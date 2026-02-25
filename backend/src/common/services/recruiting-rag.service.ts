import { Injectable } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Pool } from 'pg';

interface MatchCase {
  id: string;
  candidateSummary: string;
  jobSummary: string;
  whyAccepted: string;
  verdict: 'accepted' | 'rejected' | 'unknown';
  quality: number;
  createdAt: string;
}

interface CareerPathRecord {
  id: string;
  userId: string;
  targetRole: string;
  summary: string;
  steps: Array<{ title: string; goal: string; skills: string[]; resources: string[]; etaWeeks: number }>;
  usefulStepTitles: string[];
  quality: number;
  createdAt: string;
}

interface RecruitingRagDb {
  matchCases: MatchCase[];
  careerPaths: CareerPathRecord[];
  learningResourceCache?: Array<{
    key: string;
    payload: Record<string, unknown>;
    createdAt: string;
  }>;
}

interface VectorMetaRow {
  metadata: Record<string, unknown> | null;
}

interface AcceptedCaseCandidate {
  candidateSummary: string;
  jobSummary: string;
  whyAccepted: string;
  verdict: string;
  quality: number;
  relevance?: number;
}

interface CareerPathCandidate {
  targetRole: string;
  summary: string;
  successfulSteps: string[];
  quality: number;
  relevance?: number;
}

interface EvolvingCareerCase {
  targetRole: string;
  summary: string;
  successfulSteps: string[];
  quality: number;
}

export interface CareerPathRagMatch {
  refId: string;
  matchedRole: string;
  content: string;
  coreSkills: string[];
  optionalSkills: string[];
  careerGoal: string;
}

@Injectable()
export class RecruitingRagService {
  private readonly filePath = path.join(process.cwd(), 'data', 'recruiting-rag.json');
  private pool: Pool | null = null;
  private readonly hasPgConfig: boolean;

  constructor() {
    this.hasPgConfig = Boolean(process.env.DATABASE_URL || process.env.PGDATABASE);
  }

  async findAcceptedCases(query: string, limit = 4) {
    if (this.hasPgConfig) {
      return this.findAcceptedCasesPg(query, limit);
    }

    const db = await this.readDb();
    const q = this.normalize(query);
    return db.matchCases
      .filter((c) => c.verdict === 'accepted')
      .map((c) => ({
        ...c,
        relevance: this.tokenScore(q, this.normalize(`${c.candidateSummary} ${c.jobSummary} ${c.whyAccepted}`)),
      }))
      .sort((a, b) => b.relevance + b.quality - (a.relevance + a.quality))
      .slice(0, limit)
      .map(({ candidateSummary, jobSummary, whyAccepted }) => ({ candidateSummary, jobSummary, whyAccepted }));
  }

  async findSuccessfulCareerPaths(targetRole: string, limit = 4) {
    if (this.hasPgConfig) {
      return this.findSuccessfulCareerPathsPg(targetRole, limit);
    }

    const db = await this.readDb();
    const q = this.normalize(targetRole);
    return db.careerPaths
      .map((p) => ({
        ...p,
        relevance: this.tokenScore(q, this.normalize(`${p.targetRole} ${p.summary}`)),
      }))
      .sort((a, b) => b.relevance + b.quality - (a.relevance + a.quality))
      .slice(0, limit)
      .map((p) => ({
        targetRole: p.targetRole,
        summary: p.summary,
        successfulSteps: p.usefulStepTitles.slice(0, 8),
      }));
  }

  async findSuccessfulRoleSkills(targetRole: string, limit = 12): Promise<string[]> {
    if (this.hasPgConfig) {
      return this.findSuccessfulRoleSkillsPg(targetRole, limit);
    }

    const db = await this.readDb();
    const q = this.normalize(targetRole);
    const accepted = db.matchCases.filter((c) => c.verdict === 'accepted');
    const sorted = accepted
      .map((c) => ({
        ...c,
        relevance: this.tokenScore(q, this.normalize(`${c.jobSummary} ${c.whyAccepted}`)),
      }))
      .sort((a, b) => b.relevance + b.quality - (a.relevance + a.quality))
      .slice(0, 30);

    const freq = new Map<string, number>();
    for (const row of sorted) {
      const skills = this.extractSkillsFromText(`${row.candidateSummary} ${row.jobSummary} ${row.whyAccepted}`);
      for (const s of skills) {
        freq.set(s, (freq.get(s) || 0) + 1);
      }
    }

    return [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([skill]) => skill);
  }

  async findTopSuccessfulCareerCases(query: string, limit = 3): Promise<EvolvingCareerCase[]> {
    if (this.hasPgConfig) {
      return this.findTopSuccessfulCareerCasesPg(query, limit);
    }

    const db = await this.readDb();
    const q = this.normalize(query);
    return db.careerPaths
      .map((p) => ({
        targetRole: p.targetRole,
        summary: p.summary,
        successfulSteps: (p.usefulStepTitles || []).slice(0, 8),
        quality: Number(p.quality || 0),
        relevance: this.tokenScore(q, this.normalize(`${p.targetRole} ${p.summary}`)),
      }))
      .filter((x) => x.quality > 0)
      .sort((a, b) => (b.relevance || 0) + b.quality - ((a.relevance || 0) + a.quality))
      .slice(0, limit)
      .map((x) => ({
        targetRole: x.targetRole,
        summary: x.summary,
        successfulSteps: x.successfulSteps,
        quality: x.quality,
      }));
  }

  async getLearningResourceCache(skillName: string, userLevel: string, dayKey: string) {
    const key = this.buildLearningCacheKey(skillName, userLevel, dayKey);
    if (this.hasPgConfig) {
      const rows = await this.query(
        `SELECT metadata
         FROM recruiting_case_vectors
         WHERE case_type = 'learning_resource_cache' AND ref_id = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [key],
      );
      if (!rows.rows.length) return null;
      const metadata = (rows.rows[0].metadata || {}) as Record<string, unknown>;
      return metadata?.response || null;
    }

    const db = await this.readDb();
    const row = (db.learningResourceCache || []).find((x) => x.key === key);
    return row?.payload || null;
  }

  async getCareerPathRagByRole(targetRole: string): Promise<CareerPathRagMatch> {
    if (!this.hasPgConfig) {
      throw new Error('DATABASE_URL/PGDATABASE is required for career_path RAG');
    }

    const normalizedTarget = this.normalize(targetRole);
    const exact = await this.query(
      `SELECT ref_id, content, metadata, created_at
       FROM recruiting_case_vectors
       WHERE case_type = 'career_path_template'
         AND (
           LOWER(ref_id) = LOWER($1)
           OR LOWER(COALESCE(metadata->>'role', '')) = LOWER($1)
           OR LOWER(COALESCE(metadata->>'career_goal', '')) = LOWER($1)
         )
       ORDER BY created_at DESC
       LIMIT 1`,
      [targetRole],
    );

    let picked = exact.rows[0] as any;

    if (!picked) {
      const partial = await this.query(
      `SELECT ref_id, content, metadata, created_at
       FROM recruiting_case_vectors
       WHERE case_type = 'career_path_template'
         AND (
           LOWER(ref_id) LIKE '%' || LOWER($1) || '%'
           OR LOWER(COALESCE(metadata->>'role', '')) LIKE '%' || LOWER($1) || '%'
           OR LOWER(COALESCE(metadata->>'career_goal', '')) LIKE '%' || LOWER($1) || '%'
         )
       ORDER BY created_at DESC
       LIMIT 1`,
        [targetRole],
      );
      picked = partial.rows[0] as any;
    }

    if (!picked) {
      const all = await this.query(
        `SELECT ref_id, content, metadata, created_at
         FROM recruiting_case_vectors
         WHERE case_type = 'career_path_template'
         ORDER BY created_at DESC`,
        [],
      );

      if (all.rows.length) {
        picked = all.rows
          .map((r: any) => {
            const metadata = (r.metadata || {}) as Record<string, unknown>;
            const role = String(metadata.role || '');
            const goal = String(metadata.career_goal || '');
            const haystack = this.normalize(`${r.ref_id || ''} ${role} ${goal} ${r.content || ''}`);
            const roleNorm = this.normalize(`${r.ref_id || ''} ${role} ${goal}`);
            const bonus =
              roleNorm.includes(normalizedTarget) || normalizedTarget.includes(roleNorm)
                ? 0.35
                : 0;
            return {
              row: r,
              score: this.tokenScore(normalizedTarget, haystack) + bonus,
            };
          })
          .sort((a: { score: number }, b: { score: number }) => b.score - a.score)[0]?.row;
      }
    }

    if (!picked) {
      throw new Error(`Unable to match career_path RAG for target_role="${targetRole}"`);
    }

    const metadata = (picked.metadata || {}) as Record<string, unknown>;
    const coreSkills = Array.isArray(metadata.core_skills)
      ? metadata.core_skills.map((x: unknown) => String(x)).filter(Boolean)
      : [];
    const optionalSkills = Array.isArray(metadata.optional_skills)
      ? metadata.optional_skills.map((x: unknown) => String(x)).filter(Boolean)
      : [];
    const matchedRole = String(metadata.role || picked.ref_id || targetRole);
    const careerGoal = String(metadata.career_goal || '').trim();

    return {
      refId: String(picked.ref_id || ''),
      matchedRole,
      content: String(picked.content || ''),
      coreSkills,
      optionalSkills,
      careerGoal,
    };
  }

  async saveCareerPathResultOnly(input: {
    userId: string;
    targetRole: string;
    summary: string;
    estimatedMonths: number;
    steps: Array<{ title: string; goal: string; skills: string[]; resources: string[]; etaWeeks: number }>;
  }): Promise<string> {
    if (!this.hasPgConfig) {
      throw new Error('DATABASE_URL/PGDATABASE is required to persist career_path result');
    }

    const result = await this.query(
      `INSERT INTO career_paths (external_user_id, current_profile, target_role, summary, estimated_months, steps)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING id`,
      [
        input.userId,
        '',
        input.targetRole,
        input.summary,
        Number.isFinite(input.estimatedMonths) ? input.estimatedMonths : null,
        JSON.stringify(input.steps || []),
      ],
    );

    const id = result.rows[0]?.id;
    return `career_path_${id}`;
  }

  async saveLearningResourceCache(
    skillName: string,
    userLevel: string,
    dayKey: string,
    response: Record<string, unknown>,
  ) {
    const key = this.buildLearningCacheKey(skillName, userLevel, dayKey);
    if (this.hasPgConfig) {
      await this.query(
        `INSERT INTO recruiting_case_vectors (case_type, ref_id, content, metadata, embedding)
         VALUES ('learning_resource_cache', $1, $2, $3::jsonb, $4::jsonb)`,
        [
          key,
          `${skillName} | ${userLevel} | ${dayKey}`,
          JSON.stringify({ response, skillName, userLevel, dayKey }),
          JSON.stringify([]),
        ],
      );
      return;
    }

    const db = await this.readDb();
    db.learningResourceCache = db.learningResourceCache || [];
    const next = db.learningResourceCache.filter((x) => x.key !== key);
    next.push({
      key,
      payload: response,
      createdAt: new Date().toISOString(),
    });
    db.learningResourceCache = next.slice(-200);
    await this.writeDb(db);
  }

  async saveMatchPrediction(input: {
    candidateSummary: string;
    jobSummary: string;
    whyAccepted: string;
    verdict?: 'accepted' | 'rejected' | 'unknown';
  }) {
    const id = `match_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const verdict = input.verdict || 'unknown';
    const quality = verdict === 'accepted' ? 1.2 : verdict === 'rejected' ? -0.8 : 0;

    if (this.hasPgConfig) {
      const content = `${input.candidateSummary}\n${input.jobSummary}\n${input.whyAccepted}`;
      const metadata = {
        candidateSummary: input.candidateSummary,
        jobSummary: input.jobSummary,
        whyAccepted: input.whyAccepted,
        verdict,
        quality,
      };

      await this.query(
        `INSERT INTO recruiting_case_vectors (case_type, ref_id, content, metadata, embedding)
         VALUES ('match_case', $1, $2, $3::jsonb, $4::jsonb)`,
        [id, content, JSON.stringify(metadata), JSON.stringify([])],
      );
      return id;
    }

    const db = await this.readDb();
    db.matchCases.push({
      id,
      candidateSummary: input.candidateSummary,
      jobSummary: input.jobSummary,
      whyAccepted: input.whyAccepted,
      verdict,
      quality,
      createdAt: new Date().toISOString(),
    });
    await this.writeDb(db);
    return id;
  }

  async saveCareerPath(input: {
    userId: string;
    targetRole: string;
    summary: string;
    steps: Array<{ title: string; goal: string; skills: string[]; resources: string[]; etaWeeks: number }>;
  }) {
    const id = `path_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

    if (this.hasPgConfig) {
      await this.query(
        `INSERT INTO career_paths (external_user_id, current_profile, target_role, summary, estimated_months, steps)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [input.userId, '', input.targetRole, input.summary, null, JSON.stringify(input.steps)],
      );

      const metadata = {
        userId: input.userId,
        targetRole: input.targetRole,
        summary: input.summary,
        steps: input.steps,
        usefulStepTitles: [],
        quality: 0,
      };
      await this.query(
        `INSERT INTO recruiting_case_vectors (case_type, ref_id, content, metadata, embedding)
         VALUES ('career_path', $1, $2, $3::jsonb, $4::jsonb)`,
        [id, `${input.targetRole}\n${input.summary}`, JSON.stringify(metadata), JSON.stringify([])],
      );

      return id;
    }

    const db = await this.readDb();
    db.careerPaths.push({
      id,
      userId: input.userId,
      targetRole: input.targetRole,
      summary: input.summary,
      steps: input.steps,
      usefulStepTitles: [],
      quality: 0,
      createdAt: new Date().toISOString(),
    });
    await this.writeDb(db);
    return id;
  }

  async registerFeedback(input: {
    type: 'match' | 'career_path';
    refId: string;
    verdict: 'like' | 'dislike' | 'accepted' | 'rejected' | 'completed' | 'not_useful';
    notes?: string;
  }) {
    if (this.hasPgConfig) {
      return this.registerFeedbackPg(input);
    }

    const db = await this.readDb();

    if (input.type === 'match') {
      const row = db.matchCases.find((x) => x.id === input.refId);
      if (!row) return { updated: false };
      if (input.verdict === 'accepted' || input.verdict === 'like') {
        row.verdict = 'accepted';
        row.quality = Math.min(row.quality + 1, 5);
      } else if (input.verdict === 'rejected' || input.verdict === 'dislike') {
        row.verdict = 'rejected';
        row.quality = Math.max(row.quality - 1, -5);
      }
      if (input.notes) row.whyAccepted = `${row.whyAccepted}\nFeedback: ${input.notes}`;
      await this.writeDb(db);
      return { updated: true };
    }

    const pathRow = db.careerPaths.find((x) => x.id === input.refId);
    if (!pathRow) return { updated: false };
    if (input.verdict === 'completed' || input.verdict === 'like') {
      pathRow.quality = Math.min(pathRow.quality + 1, 6);
      if (input.notes) {
        pathRow.usefulStepTitles.push(input.notes);
        pathRow.usefulStepTitles = [...new Set(pathRow.usefulStepTitles)].slice(0, 24);
      }
    } else if (input.verdict === 'not_useful' || input.verdict === 'dislike') {
      pathRow.quality = Math.max(pathRow.quality - 1, -6);
    }

    await this.writeDb(db);
    return { updated: true };
  }

  private async registerFeedbackPg(input: {
    type: 'match' | 'career_path';
    refId: string;
    verdict: 'like' | 'dislike' | 'accepted' | 'rejected' | 'completed' | 'not_useful';
    notes?: string;
  }) {
    const caseType = input.type === 'match' ? 'match_case' : 'career_path';
    const row = await this.query(
      `SELECT id, metadata, content FROM recruiting_case_vectors WHERE case_type = $1 AND ref_id = $2 LIMIT 1`,
      [caseType, input.refId],
    );

    if (!row.rows.length) return { updated: false };

    const currentMeta = (row.rows[0].metadata || {}) as Record<string, any>;
    let quality = Number(currentMeta.quality || 0);

    if (input.type === 'match') {
      if (input.verdict === 'accepted' || input.verdict === 'like') {
        currentMeta.verdict = 'accepted';
        quality = Math.min(quality + 1, 5);
      } else if (input.verdict === 'rejected' || input.verdict === 'dislike') {
        currentMeta.verdict = 'rejected';
        quality = Math.max(quality - 1, -5);
      }
      currentMeta.quality = quality;
      if (input.notes) {
        currentMeta.whyAccepted = `${String(currentMeta.whyAccepted || '')}\nFeedback: ${input.notes}`.trim();
      }
    } else {
      if (input.verdict === 'completed' || input.verdict === 'like') {
        quality = Math.min(quality + 1, 6);
        const useful = Array.isArray(currentMeta.usefulStepTitles) ? currentMeta.usefulStepTitles : [];
        if (input.notes) useful.push(input.notes);
        currentMeta.usefulStepTitles = [...new Set(useful)].slice(0, 24);
      } else if (input.verdict === 'not_useful' || input.verdict === 'dislike') {
        quality = Math.max(quality - 1, -6);
      }
      currentMeta.quality = quality;
    }

    await this.query(
      `UPDATE recruiting_case_vectors SET metadata = $1::jsonb WHERE case_type = $2 AND ref_id = $3`,
      [JSON.stringify(currentMeta), caseType, input.refId],
    );

    return { updated: true };
  }

  private async findAcceptedCasesPg(query: string, limit: number) {
    const rows = await this.query(
      `SELECT metadata FROM recruiting_case_vectors WHERE case_type = 'match_case' ORDER BY created_at DESC LIMIT 300`,
      [],
    );

    const q = this.normalize(query);
    return (rows.rows as VectorMetaRow[])
      .map((r): AcceptedCaseCandidate => {
        const m = (r.metadata || {}) as Record<string, unknown>;
        return {
          candidateSummary: String(m.candidateSummary || ''),
          jobSummary: String(m.jobSummary || ''),
          whyAccepted: String(m.whyAccepted || ''),
          verdict: String(m.verdict || 'unknown'),
          quality: Number(m.quality || 0),
        };
      })
      .filter((x: AcceptedCaseCandidate) => x.verdict === 'accepted')
      .map((c: AcceptedCaseCandidate) => ({
        ...c,
        relevance: this.tokenScore(q, this.normalize(`${c.candidateSummary} ${c.jobSummary} ${c.whyAccepted}`)),
      }))
      .sort((a: AcceptedCaseCandidate, b: AcceptedCaseCandidate) => (b.relevance || 0) + b.quality - ((a.relevance || 0) + a.quality))
      .slice(0, limit)
      .map((item: AcceptedCaseCandidate) => ({
        candidateSummary: item.candidateSummary,
        jobSummary: item.jobSummary,
        whyAccepted: item.whyAccepted,
      }));
  }

  private async findSuccessfulCareerPathsPg(targetRole: string, limit: number) {
    const rows = await this.query(
      `SELECT metadata FROM recruiting_case_vectors WHERE case_type = 'career_path' ORDER BY created_at DESC LIMIT 300`,
      [],
    );

    const q = this.normalize(targetRole);
    return (rows.rows as VectorMetaRow[])
      .map((r): CareerPathCandidate => {
        const m = (r.metadata || {}) as Record<string, unknown>;
        return {
          targetRole: String(m.targetRole || ''),
          summary: String(m.summary || ''),
          successfulSteps: Array.isArray(m.usefulStepTitles)
            ? m.usefulStepTitles.map((x: unknown) => String(x)).slice(0, 8)
            : [],
          quality: Number(m.quality || 0),
        };
      })
      .map((p: CareerPathCandidate) => ({
        ...p,
        relevance: this.tokenScore(q, this.normalize(`${p.targetRole} ${p.summary}`)),
      }))
      .sort((a: CareerPathCandidate, b: CareerPathCandidate) => (b.relevance || 0) + b.quality - ((a.relevance || 0) + a.quality))
      .slice(0, limit)
      .map((p: CareerPathCandidate) => ({ targetRole: p.targetRole, summary: p.summary, successfulSteps: p.successfulSteps }));
  }

  private async findSuccessfulRoleSkillsPg(targetRole: string, limit: number): Promise<string[]> {
    const rows = await this.query(
      `SELECT metadata, content
       FROM recruiting_case_vectors
       WHERE case_type = 'match_case'
       ORDER BY created_at DESC
       LIMIT 500`,
      [],
    );

    const q = this.normalize(targetRole);
    const ranked = rows.rows
      .map((r: any) => {
        const m = (r.metadata || {}) as Record<string, unknown>;
        const verdict = String(m.verdict || 'unknown');
        const quality = Number(m.quality || 0);
        const candidateSummary = String(m.candidateSummary || '');
        const jobSummary = String(m.jobSummary || '');
        const whyAccepted = String(m.whyAccepted || '');
        const content = String(r.content || '');
        const relevance = this.tokenScore(q, this.normalize(`${jobSummary} ${content}`));
        return { verdict, quality, candidateSummary, jobSummary, whyAccepted, content, relevance };
      })
      .filter((x) => x.verdict === 'accepted')
      .sort((a, b) => b.relevance + b.quality - (a.relevance + a.quality))
      .slice(0, 40);

    const freq = new Map<string, number>();
    for (const row of ranked) {
      const skills = this.extractSkillsFromText(`${row.candidateSummary} ${row.jobSummary} ${row.whyAccepted} ${row.content}`);
      for (const s of skills) {
        freq.set(s, (freq.get(s) || 0) + 1);
      }
    }

    return [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([skill]) => skill);
  }

  private async findTopSuccessfulCareerCasesPg(query: string, limit: number): Promise<EvolvingCareerCase[]> {
    const rows = await this.query(
      `SELECT metadata
       FROM recruiting_case_vectors
       WHERE case_type = 'career_path'
       ORDER BY created_at DESC
       LIMIT 500`,
      [],
    );

    const q = this.normalize(query);
    return rows.rows
      .map((r: any) => {
        const m = (r.metadata || {}) as Record<string, unknown>;
        const targetRole = String(m.targetRole || '');
        const summary = String(m.summary || '');
        const successfulSteps = Array.isArray(m.usefulStepTitles)
          ? m.usefulStepTitles.map((x: unknown) => String(x)).slice(0, 8)
          : [];
        const quality = Number(m.quality || 0);
        const relevance = this.tokenScore(q, this.normalize(`${targetRole} ${summary}`));
        return { targetRole, summary, successfulSteps, quality, relevance };
      })
      .filter((x) => x.quality > 0)
      .sort((a, b) => (b.relevance || 0) + b.quality - ((a.relevance || 0) + a.quality))
      .slice(0, limit)
      .map((x) => ({
        targetRole: x.targetRole,
        summary: x.summary,
        successfulSteps: x.successfulSteps,
        quality: x.quality,
      }));
  }

  async query(sql: string, params: unknown[]) {
    const pool = this.getPool();
    return pool.query(sql, params as any[]);
  }

  private getPool() {
    if (!this.pool) {
      if (process.env.DATABASE_URL) {
        this.pool = new Pool({ connectionString: process.env.DATABASE_URL });
      } else {
        this.pool = new Pool({
          host: process.env.PGHOST || 'localhost',
          port: Number(process.env.PGPORT || 5432),
          user: process.env.PGUSER || 'postgres',
          password: process.env.PGPASSWORD || '',
          database: process.env.PGDATABASE || 'postgres',
        });
      }
    }
    return this.pool;
  }

  private tokenScore(a: string, b: string) {
    const left = new Set(a.split(' ').filter(Boolean));
    if (!left.size) return 0;
    const right = new Set(b.split(' ').filter(Boolean));
    let overlap = 0;
    left.forEach((token) => {
      if (right.has(token)) overlap += 1;
    });
    return overlap / left.size;
  }

  private normalize(value: string) {
    return String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9+\s-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private buildLearningCacheKey(skillName: string, userLevel: string, dayKey: string) {
    return `${this.normalize(skillName)}|${this.normalize(userLevel)}|${dayKey}`;
  }

  private extractSkillsFromText(text: string): string[] {
    const normalized = this.normalize(text);
    const skillLexicon = [
      'java',
      'python',
      'javascript',
      'typescript',
      'node',
      'node.js',
      'react',
      'angular',
      'vue',
      'sql',
      'postgresql',
      'mysql',
      'mongodb',
      'spring boot',
      'docker',
      'kubernetes',
      'aws',
      'azure',
      'gcp',
      'git',
      'html',
      'css',
      'tailwind',
      'php',
      'laravel',
      'django',
      'fastapi',
      'rest',
      'microservicios',
      'testing',
      'cypress',
      'jest',
      'power bi',
      'excel',
      'etl',
      'spark',
      'pandas',
      'spring',
      'spring boot',
      'express',
      'nestjs',
      'redis',
      'graphql',
      'linux',
      'ci/cd',
      'jenkins',
      'terraform',
    ];

    const found = skillLexicon.filter((skill) => normalized.includes(this.normalize(skill)));
    return [...new Set(found)].slice(0, 40);
  }

  private async readDb(): Promise<RecruitingRagDb> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as RecruitingRagDb;
      return {
        matchCases: parsed.matchCases || [],
        careerPaths: parsed.careerPaths || [],
        learningResourceCache: parsed.learningResourceCache || [],
      };
    } catch {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const initial: RecruitingRagDb = { matchCases: [], careerPaths: [], learningResourceCache: [] };
      await fs.writeFile(this.filePath, JSON.stringify(initial, null, 2), 'utf8');
      return initial;
    }
  }

  private async writeDb(data: RecruitingRagDb): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf8');
  }
}
