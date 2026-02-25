import { Injectable } from '@nestjs/common';
import { CvLearningService } from '../common/services/cv-learning.service';
import { GeminiService } from '../common/services/gemini.service';
import { RecruitingRagService } from '../common/services/recruiting-rag.service';
import { AnalyzeCvLearningDto } from './dto-analyze-cv-learning.dto';
import { FeedbackDto } from './dto-feedback.dto';
import { GetLearningResourcesDto } from './dto-get-learning-resources.dto';
import { GenerateCareerPathDto } from './dto-generate-career-path.dto';
import { GenerateCareerPathFromCvDto } from './dto-generate-career-path-from-cv.dto';
import { MatchCvDto } from './dto-match-cv.dto';
import {
  buildCareerPathGapPrompt,
  buildCareerPathSystemPrompt,
  buildEvolvingCareerPathPrompt,
  buildLearningCvMatchPrompt,
  buildMatchSystemPrompt,
} from './prompts';

export interface RoadmapStep {
  month?: number;
  action?: string;
  resource?: string;
}

export interface RoadmapToTarget {
  targetRole?: string;
  isRealistic?: boolean;
  estimatedTime?: string;
  currentGapPercentage?: number;
  gapSkills?: string[];
  steps?: RoadmapStep[];
  keyProjects?: string[];
  advice?: string;
}

export interface CurrentMatch {
  title?: string;
  matchPercentage?: number;
  level?: string;
  reason?: string;
}

export interface MatchedJob {
  title?: string;
  matchPercentage?: number;
  level?: string;
  reason?: string;
  missingSkills?: string[];
  basedOn?: 'historial' | 'conocimiento_base';
}

export interface GeminiCvAnalysis {
  analysisId?: number | null;
  profileSummary?: string;
  skills: string[];
  currentMatch?: CurrentMatch | null;
  matchedJobs: MatchedJob[];
  roadmapToTarget?: RoadmapToTarget | null;
  suggestedRole?: string;
  totalHistoricalCVs?: number;
  similarCVsFound?: number;
}

@Injectable()
export class RecruitingService {
  private readonly knownCvSkills = [
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
    'spring',
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
    'graphql',
    'microservicios',
    'testing',
    'jest',
    'cypress',
    'linux',
    'redis',
    'flutter',
    'dart',
    'kotlin',
    'swift',
    'swiftui',
    'android sdk',
    'ios sdk',
    'firebase',
    'figma',
    'ui ux',
    'react native',
    'xcode',
  ];

  constructor(
    private readonly geminiService: GeminiService,
    private readonly ragService: RecruitingRagService,
    private readonly learningService: CvLearningService,
  ) {}

  async matchCv(dto: MatchCvDto) {
    const similarAcceptedCases = await this.ragService.findAcceptedCases(
      `${dto.cvText}\n${dto.jobTitle || ''}\n${dto.jobDescription}`,
      4,
    );
    const skillsUsuario = this.extractTechnicalSkills(dto.cvText).slice(0, 20);
    const skillsJob = this.extractTechnicalSkills(`${dto.jobTitle || ''}\n${dto.jobDescription}`).slice(0, 20);
    const experienciaUsuario = this.extractExperienceSummary(dto.cvText);

    const prompt = buildMatchSystemPrompt({
      cvText: dto.cvText,
      jobDescription: dto.jobDescription,
      jobTitle: dto.jobTitle,
      skillsUsuario,
      experienciaUsuario,
      skillsJob,
      similarAcceptedCases,
    });

    const raw = await this.geminiService.runStructuredPrompt(prompt, 900);
    const parsed = this.parseMatch(raw);

    const predictionId = await this.ragService.saveMatchPrediction({
      candidateSummary: dto.cvText.slice(0, 700),
      jobSummary: `${dto.jobTitle || ''}\n${dto.jobDescription}`.slice(0, 700),
      whyAccepted: (parsed.reasons || []).join(' | ').slice(0, 900),
      verdict: 'unknown',
    });

    return {
      predictionId,
      ragContextUsed: similarAcceptedCases.length,
      skillsUsuario,
      skillsJob,
      experienciaUsuario,
      ...parsed,
    };
  }

  async analyzeCvLearning(dto: AnalyzeCvLearningDto) {
    const cvText = String(dto.cvText || '').trim();
    if (!cvText || cvText.length < 50) {
      return {
        profileSummary: '',
        skills: [],
        matchedJobs: [],
        totalHistoricalCVs: 0,
      };
    }

    const extractedSkills = this.normalizeSkillList(this.extractTechnicalSkills(cvText));
    const similarAcceptedCases = await this.ragService.findAcceptedCases(cvText, 80);
    const historicalJobCounts = this.buildHistoricalJobCounts(similarAcceptedCases);
    const topHistoricalJobs = [...historicalJobCounts.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
      .map((x) => ({ title: x.title, count: x.count }));

    const prompt = buildLearningCvMatchPrompt({
      cvText,
      extractedSkills,
      historicalCases: similarAcceptedCases,
      topHistoricalJobs,
    });

    const raw = await this.geminiService.runStructuredPrompt(prompt, 1800, 0.35);
    const parsed = this.parseLearningCvMatch(raw);

    const parsedJobs = Array.isArray(parsed.matchedJobs) ? parsed.matchedJobs : [];
    const normalizedJobs = parsedJobs.map((job) => {
      const title = String(job?.title || '').trim() || 'Software Developer';
      const similarCVsCount = this.countSimilarForTitle(title, historicalJobCounts);
      const fallbackLevel = this.detectLevelFromTitle(title);
      return {
        title,
        matchPercentage: this.clampInt(job?.matchPercentage, 45, 98, Math.min(95, 55 + similarCVsCount * 6)),
        level: String(job?.level || fallbackLevel).trim() || fallbackLevel,
        reason: String(job?.reason || '').trim() || 'Coincidencia estimada por skills del CV y demanda de mercado.',
        basedOn: similarCVsCount > 0 ? 'historial' : 'base',
        similarCVsCount,
        missingSkills: this.normalizeSkillList(
          Array.isArray(job?.missingSkills) ? job.missingSkills.map((x: unknown) => String(x)) : [],
        ).slice(0, 8),
      };
    });

    const usedTitles = new Set(normalizedJobs.map((x) => this.normalize(x.title)));
    for (const row of topHistoricalJobs) {
      if (normalizedJobs.length >= 5) break;
      const normalizedTitle = this.normalize(row.title);
      if (!normalizedTitle || usedTitles.has(normalizedTitle)) continue;
      usedTitles.add(normalizedTitle);
      normalizedJobs.push({
        title: row.title,
        matchPercentage: this.clampInt(45 + row.count * 6, 45, 92, 60),
        level: this.detectLevelFromTitle(row.title),
        reason: `Patron detectado en historial para perfiles similares (${row.count} casos).`,
        basedOn: 'historial',
        similarCVsCount: row.count,
        missingSkills: [],
      });
    }

    const baseFallbackTitles = [
      'Backend Developer Junior',
      'Frontend Developer Junior',
      'Full Stack Developer Junior',
      'Mobile Developer Junior',
      'QA Tester',
      'Data Analyst Junior',
    ];
    for (const title of baseFallbackTitles) {
      if (normalizedJobs.length >= 5) break;
      const normalizedTitle = this.normalize(title);
      if (!normalizedTitle || usedTitles.has(normalizedTitle)) continue;
      usedTitles.add(normalizedTitle);
      normalizedJobs.push({
        title,
        matchPercentage: 45,
        level: this.detectLevelFromTitle(title),
        reason: 'Estimacion basada en conocimiento base del mercado.',
        basedOn: 'base',
        similarCVsCount: 0,
        missingSkills: [],
      });
    }

    const matchedJobs = normalizedJobs
      .sort((a, b) => b.matchPercentage - a.matchPercentage)
      .slice(0, 5)
      .map((x) => ({
        title: x.title,
        matchPercentage: x.matchPercentage,
        level: x.level,
        reason: x.reason,
        basedOn: x.basedOn,
        similarCVsCount: x.similarCVsCount,
        missingSkills: x.missingSkills,
      }));

    const profileSummary =
      String(parsed.profileSummary || '').trim() ||
      `Perfil con enfoque en ${extractedSkills.slice(0, 4).join(', ') || 'habilidades tecnicas iniciales'}.`;
    const skills = this.normalizeSkillList(
      Array.isArray(parsed.skills) && parsed.skills.length
        ? parsed.skills.map((x: unknown) => String(x))
        : extractedSkills,
    ).slice(0, 30);
    const totalHistoricalCVs = similarAcceptedCases.length;

    await this.ragService.saveMatchPrediction({
      candidateSummary: cvText.slice(0, 700),
      jobSummary: matchedJobs.map((x) => x.title).join(' | ').slice(0, 700),
      whyAccepted: matchedJobs
        .map((x) => `${x.title}: ${x.reason}`)
        .join(' | ')
        .slice(0, 900),
      verdict: 'unknown',
    });

    return {
      profileSummary,
      skills,
      matchedJobs,
      totalHistoricalCVs,
    };
  }

  async generateCareerPath(dto: GenerateCareerPathDto) {
    const priorSuccessfulPaths = await this.ragService.findSuccessfulCareerPaths(dto.targetRole, 4);
    const prompt = buildCareerPathSystemPrompt({
      currentProfile: dto.currentProfile,
      targetRole: dto.targetRole,
      priorSuccessfulPaths,
    });

    const raw = await this.geminiService.runStructuredPrompt(prompt, 1800);
    const parsed = this.parseCareerPath(raw);

    const pathId = await this.ragService.saveCareerPath({
      userId: dto.userId || 'anonymous',
      targetRole: dto.targetRole,
      summary: parsed.summary,
      steps: parsed.steps,
    });

    return {
      pathId,
      ragContextUsed: priorSuccessfulPaths.length,
      ...parsed,
    };
  }

  async generateCareerPathFromCv(dto: GenerateCareerPathFromCvDto) {
    try {
      const cvText = String(dto.cvText || '').trim();
      const normalizedCv = cvText.toLowerCase().trim();
      const fallbackTargetRole = String(dto.targetRole || 'Software Developer');

      const geminiResult = await this.analyzeWithGeminiAndLearn(cvText, fallbackTargetRole);
      console.log(`Gemini suggested role: ${geminiResult.suggestedRole}`);
      console.log(`Gemini extracted skills: [${(geminiResult.skills || []).join(', ')}]`);
      console.log(`Similar CVs found in history: ${geminiResult.similarCVsFound}`);

      const roleToSearch = String(fallbackTargetRole || geminiResult.suggestedRole || 'Software Developer');
      const rag = await this.ragService.getCareerPathRagByRole(roleToSearch);
      console.log(`Matched role: ${rag.matchedRole}`);

      let coreSkills = this.normalizeSkillList(rag.coreSkills);
      let optionalSkills = this.normalizeSkillList(rag.optionalSkills);
      const targetNormalized = this.normalize(fallbackTargetRole);
      const matchedNormalized = this.normalize(rag.matchedRole || '');
      const ragLooksAligned =
        !!targetNormalized &&
        !!matchedNormalized &&
        (matchedNormalized.includes(targetNormalized) || targetNormalized.includes(matchedNormalized));
      if (!ragLooksAligned) {
        const fallbackRoleSkills = this.getFallbackRoleSkills(fallbackTargetRole);
        if (fallbackRoleSkills) {
          coreSkills = this.normalizeSkillList(fallbackRoleSkills.coreSkills);
          optionalSkills = this.normalizeSkillList(fallbackRoleSkills.optionalSkills);
        }
      }
      const cvSkills = [
        ...new Set([
          ...this.normalizeSkillList(geminiResult.skills || []),
          ...this.matchCvSkillsByCatalogNormalized(normalizedCv, [...coreSkills, ...optionalSkills]),
        ]),
      ];

      console.log(`Extracted CV skills: [${cvSkills.join(', ')}]`);
      const missingCore = coreSkills.filter((skill) => !cvSkills.includes(skill));
      const missingOptional = optionalSkills.filter((skill) => !cvSkills.includes(skill));
      const prioritizedMissingSkills = missingCore;

      const fallbackSteps = prioritizedMissingSkills.map((skill, idx) => ({
        month: idx + 1,
        title: `Mes ${idx + 1}: ${skill}`,
        action: `Implementa un proyecto enfocado en ${skill} alineado al rol ${fallbackTargetRole}. Publica avances semanales en GitHub y documenta decisiones tecnicas.`,
        resource: `Ruta oficial y practica guiada de ${skill} (${fallbackTargetRole})`,
        goal: `Desarrollar dominio aplicado en ${skill} para avanzar hacia ${fallbackTargetRole}.`,
        skills: [skill],
        resources: optionalSkills.length ? [`Conectar ${skill} con ${optionalSkills.slice(0, 3).join(', ')}`] : [],
        etaWeeks: 4,
      }));
      const historicalRoadmapSteps =
        Array.isArray(geminiResult.roadmapToTarget?.steps) && geminiResult.roadmapToTarget?.steps?.length
          ? geminiResult.roadmapToTarget?.steps || []
          : [];
      const historicalLooksGeneric = historicalRoadmapSteps.every((step: any) => {
        const action = String(step?.action || step?.goal || '').toLowerCase();
        return action.includes('cerrar brecha de');
      });
      const shouldUseHistoricalRoadmap = historicalRoadmapSteps.length > 0 && !historicalLooksGeneric;
      const roadmapSteps =
        shouldUseHistoricalRoadmap
          ? historicalRoadmapSteps
          : fallbackSteps;

      const estimatedMonths = Math.max(1, Math.ceil((roadmapSteps.length * 4) / 4));
      const summary =
        shouldUseHistoricalRoadmap
          ? `Roadmap generado con pasos historicos personalizados para ${fallbackTargetRole}.`
          : prioritizedMissingSkills.length > 0
          ? `Roadmap generado desde career_path RAG para ${rag.matchedRole}. Meta siguiente: ${rag.careerGoal || roleToSearch}.`
          : `No se detectaron brechas frente a core_skills del rol ${rag.matchedRole}.`;

      const pathId = await this.ragService.saveCareerPathResultOnly({
        userId: dto.userId || 'anonymous',
        targetRole: fallbackTargetRole,
        summary,
        estimatedMonths,
        steps: roadmapSteps as any[],
      });

      return {
        pathId,
        analysisId: geminiResult.analysisId ?? null,
        ragContextUsed: 1,
        matchedRole: rag.matchedRole,
        coreSkills,
        optionalSkills,
        cvSkills,
        missingSkills: prioritizedMissingSkills,
        missingOptionalSkills: missingOptional,
        summary,
        estimatedMonths,
        steps: roadmapSteps,
        careerGoal: rag.careerGoal || roleToSearch,
        roadmapToTarget: geminiResult.roadmapToTarget ?? null,
        currentMatch: geminiResult.currentMatch,
        gemini: geminiResult,
      };
    } catch (error) {
      console.error('generateCareerPathFromCv failed, using fallback response', error);
      const fallbackRole = String(dto.targetRole || 'Software Developer');
      return {
        pathId: null,
        analysisId: null,
        ragContextUsed: 0,
        matchedRole: fallbackRole,
        coreSkills: [],
        optionalSkills: [],
        cvSkills: [],
        missingSkills: [],
        missingOptionalSkills: [],
        summary: 'No se pudo procesar el CV en este intento.',
        estimatedMonths: 0,
        steps: [],
        careerGoal: fallbackRole,
        roadmapToTarget: null,
        currentMatch: null,
        gemini: {
          skills: [],
          suggestedRole: fallbackRole,
          currentMatch: null,
          matchedJobs: [],
          roadmapToTarget: null,
          profileSummary: '',
          totalHistoricalCVs: 0,
          similarCVsFound: 0,
        } as GeminiCvAnalysis,
      };
    }
  }

  async registerFeedback(dto: FeedbackDto) {
    return this.ragService.registerFeedback(dto);
  }

  async getLearningResources(dto: GetLearningResourcesDto) {
    const dayKey = new Date().toISOString().slice(0, 10);
    const cached = await this.ragService.getLearningResourceCache(dto.skill_name, dto.user_level, dayKey);
    if (cached) {
      return {
        cached: true,
        skill_name: dto.skill_name,
        user_level: dto.user_level,
        data: cached,
      };
    }

    const prompt = [
      'Actua como un Tech Lead Curador de Contenido.',
      `El usuario necesita aprender: ${dto.skill_name}.`,
      `Nivel actual del usuario: ${dto.user_level}.`,
      '',
      'Genera un JSON estricto con 3 recomendaciones exactas:',
      'Mejor Curso Gratuito: (Youtube, Documentacion oficial, Blogs).',
      'Mejor Curso de Pago: (Udemy, Coursera, Platzi - especifica cual).',
      'Proyecto Practico: Una idea rapida para aplicar lo aprendido hoy mismo.',
      '',
      'Formato JSON requerido:',
      '{ "free_resource": { "title": "...", "platform": "...", "url_search_term": "..." }, "paid_resource": { "title": "...", "platform": "..." }, "practice_project": "..." }',
    ].join('\n');

    const raw = await this.geminiService.runStructuredPrompt(prompt, 700, 0.78);
    const parsed = this.parseLearningResources(raw, dto.skill_name);

    await this.ragService.saveLearningResourceCache(dto.skill_name, dto.user_level, dayKey, parsed);

    return {
      cached: false,
      skill_name: dto.skill_name,
      user_level: dto.user_level,
      data: parsed,
    };
  }

  async getLearningStats() {
    return this.learningService.getLearningStats();
  }

  async acceptSuggestedRole(analysisId: number) {
    const accepted = await this.learningService.acceptAnalysis(analysisId);
    return {
      ok: accepted,
      analysisId,
      accepted,
    };
  }

  private async analyzeWithGeminiAndLearn(cvText: string, targetRole: string): Promise<GeminiCvAnalysis> {
    const safeCvText = String(cvText || '').trim();
    const safeTargetRole = String(targetRole || 'Software Developer').trim() || 'Software Developer';
    const quickSkills = this.normalizeSkillList(this.extractTechnicalSkills(safeCvText));

    const trainingContext = await this.learningService.getTrainingContext(quickSkills);
    const stats = await this.learningService.getLearningStats();
    const hasTrainingData = trainingContext.length > 0;
    console.log(`Training context: ${hasTrainingData ? 'YES' : 'NO'} (${stats.totalCVsAnalyzed} CVs in history)`);
    const contextRows: Array<{
      skills?: string[];
      role?: string;
      targetRole?: string;
      matchPercentage?: number;
      level?: string;
      missingSkills?: string[];
      roadmapEstimatedTime?: string;
      roadmapToTarget?: RoadmapToTarget | null;
      acceptedByUser?: boolean;
    }> = hasTrainingData
      ? (() => {
          try {
            return JSON.parse(trainingContext);
          } catch {
            return [];
          }
        })()
      : [];

    const quickSkillSet = new Set(quickSkills.map((s) => this.normalize(s)).filter(Boolean));
    const roleMap = new Map<
      string,
      {
        title: string;
        weightedScore: number;
        weightedPct: number;
        weightedCount: number;
        similarRows: number;
        level: string;
        missing: Map<string, number>;
      }
    >();
    const similarRows: Array<{
      similarity: number;
      row: {
        skills?: string[];
        role?: string;
        targetRole?: string;
        matchPercentage?: number;
        level?: string;
        missingSkills?: string[];
        roadmapEstimatedTime?: string;
        roadmapToTarget?: RoadmapToTarget | null;
        acceptedByUser?: boolean;
      };
    }> = [];

    for (const row of contextRows) {
      const title = String(row?.role || '').trim();
      if (!title) continue;
      const key = this.normalize(title);
      if (!key) continue;
      const rowSkills = this.normalizeSkillList(Array.isArray(row?.skills) ? row.skills : []);
      const rowSkillSet = new Set(rowSkills.map((s) => this.normalize(s)).filter(Boolean));
      const intersection = [...quickSkillSet].filter((skill) => rowSkillSet.has(skill)).length;
      const union = new Set([...quickSkillSet, ...rowSkillSet]).size || 1;
      const similarity = intersection / union;
      if (similarity <= 0) continue;
      similarRows.push({ similarity, row });
      if (!roleMap.has(key)) {
        roleMap.set(key, {
          title,
          weightedScore: 0,
          weightedPct: 0,
          weightedCount: 0,
          similarRows: 0,
          level: String(row?.level || 'Junior').trim() || 'Junior',
          missing: new Map<string, number>(),
        });
      }
      const current = roleMap.get(key)!;
      const historicalPct = this.clampInt(row?.matchPercentage, 0, 100, 60);
      const acceptanceBoost = row?.acceptedByUser ? 1.15 : 1;
      const qualityScore = similarity * 100 * acceptanceBoost;
      current.weightedScore += qualityScore;
      current.weightedPct += historicalPct * similarity * acceptanceBoost;
      current.weightedCount += similarity * acceptanceBoost;
      current.similarRows += 1;
      for (const skill of row?.missingSkills || []) {
        const n = this.normalize(String(skill));
        if (!n) continue;
        current.missing.set(n, (current.missing.get(n) || 0) + 1);
      }
    }

    const matchedJobs: MatchedJob[] = [...roleMap.values()]
      .sort((a, b) => b.weightedScore - a.weightedScore)
      .slice(0, 5)
      .map((x) => ({
        title: x.title,
        matchPercentage: this.clampInt(x.weightedPct / Math.max(0.0001, x.weightedCount), 35, 95, 60),
        level: x.level || 'Junior',
        reason: `Basado en similitud de skills con ${x.similarRows} CVs del historial.`,
        missingSkills: [...x.missing.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([skill]) => skill),
        basedOn: 'historial',
      }));

    if (!matchedJobs.length) {
      matchedJobs.push({
        title: safeTargetRole,
        matchPercentage: 50,
        level: 'Junior',
        reason: 'Sin suficientes casos historicos; usando estimacion base local.',
        missingSkills: [],
        basedOn: 'conocimiento_base',
      });
    }

    const targetRows = similarRows
      .sort((a, b) => b.similarity - a.similarity)
      .map((x) => x.row)
      .filter((x) => x?.roadmapToTarget && Array.isArray(x.roadmapToTarget?.steps))
      .filter(
        (x) => this.normalize(String(x?.targetRole || '')) === this.normalize(safeTargetRole),
      );

    const historicalRoadmapSteps = Array.isArray(targetRows[0]?.roadmapToTarget?.steps)
      ? (targetRows[0]?.roadmapToTarget?.steps || []).slice(0, 8)
      : [];

    const targetRowsByRole = contextRows.filter(
      (x) => this.normalize(String(x?.targetRole || '')) === this.normalize(safeTargetRole),
    );
    const targetMissingMap = new Map<string, number>();
    for (const row of targetRowsByRole) {
      for (const skill of row?.missingSkills || []) {
        const n = this.normalize(String(skill));
        if (!n) continue;
        targetMissingMap.set(n, (targetMissingMap.get(n) || 0) + 1);
      }
    }
    const targetGapSkills = [...targetMissingMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([skill]) => skill);

    const roadmapToTarget: RoadmapToTarget | null = targetRowsByRole.length
      ? {
          targetRole: safeTargetRole,
          isRealistic: true,
          estimatedTime: String(targetRowsByRole[0]?.roadmapEstimatedTime || '').trim() || '6-12 meses',
          currentGapPercentage: 40,
          gapSkills: targetGapSkills,
          steps: historicalRoadmapSteps,
          keyProjects: [],
          advice: `Basado en historial, avanza primero por ${matchedJobs[0]?.title || 'un rol intermedio'} antes de ${safeTargetRole}.`,
        }
      : null;

    const result: GeminiCvAnalysis = {
      analysisId: null,
      skills: quickSkills,
      suggestedRole: String(matchedJobs[0]?.title || safeTargetRole),
      currentMatch: {
        title: String(matchedJobs[0]?.title || safeTargetRole),
        matchPercentage: matchedJobs[0]?.matchPercentage || 50,
        level: String(matchedJobs[0]?.level || 'Junior'),
        reason: String(matchedJobs[0]?.reason || ''),
      },
      matchedJobs,
      roadmapToTarget,
      profileSummary: `Perfil detectado con ${quickSkills.length} skills tecnicas. Recomendacion basada en historial interno.`,
      totalHistoricalCVs: stats.totalCVsAnalyzed,
      similarCVsFound: similarRows.length,
    };
    const analysisId = await this.learningService.saveAnalysis({
      cvText: safeCvText,
      extractedSkills: result.skills || [],
      suggestedRole: result.currentMatch?.title || safeTargetRole,
      matchedRole: result.matchedJobs?.[0]?.title || safeTargetRole,
      matchPercentage: result.matchedJobs?.[0]?.matchPercentage || 0,
      level: result.matchedJobs?.[0]?.level || 'Junior',
      missingSkills: result.matchedJobs?.[0]?.missingSkills || [],
      targetRole: safeTargetRole,
      roadmapToTarget: (result.roadmapToTarget || null) as Record<string, unknown> | null,
      fullResult: result as unknown as object,
    });
    result.analysisId = analysisId;

    console.log(`Analysis saved to training history. Total: ${stats.totalCVsAnalyzed + 1} CVs`);
    return result;
  }

  private async callGeminiWithRetry(prompt: string, maxRetries = 3): Promise<string> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.geminiService.generate(prompt);
        if (result && result.trim().length > 0) return result;
        throw new Error('empty_response');
      } catch (error: any) {
        const message = error?.message || '';
        const detail = error?.detail || JSON.stringify(error) || '';
        const fullText = message + detail;

        const is429 =
          fullText.includes('429') ||
          fullText.includes('quota') ||
          fullText.includes('RESOURCE_EXHAUSTED') ||
          fullText.includes('Too Many Requests');
        const hardQuotaZero =
          /limit:\s*0/i.test(fullText) ||
          /GenerateRequestsPerDayPerProjectPerModel-FreeTier/i.test(fullText);

        if (is429 && hardQuotaZero) {
          console.error('[Gemini] cuota en 0 (limit: 0). Se aborta sin reintentos.');
          throw new Error('quota_limit_zero');
        }

        if (is429 && attempt < maxRetries) {
          // Extraer segundos exactos del mensaje de Gemini
          const matchSeconds =
            fullText.match(/retry in (\d+(?:\.\d+)?)s/i) ||
            fullText.match(/"retryDelay"\s*:\s*"(\d+)s"/i) ||
            fullText.match(/retryDelay.*?(\d+)/i);

          const waitSeconds = matchSeconds
            ? Math.ceil(parseFloat(matchSeconds[1])) + 3
            : attempt * 20;

          console.log(
            `[Gemini] 429 quota exceeded - esperando ${waitSeconds}s antes de reintentar (intento ${attempt}/${maxRetries})`
          );

          await new Promise((r) => setTimeout(r, waitSeconds * 1000));
          continue;
        }

        if (attempt === maxRetries) {
          console.error(`[Gemini] Falló después de ${maxRetries} intentos:`, message);
          throw new Error('max_retries_exceeded');
        }

        throw error;
      }
    }
    throw new Error('max_retries_exceeded');
  }

  private parseLearningCvMatch(raw: string | null): {
    profileSummary: string;
    skills: string[];
    matchedJobs: Array<{
      title: string;
      matchPercentage: number;
      level: string;
      reason: string;
      basedOn: string;
      similarCVsCount: number;
      missingSkills: string[];
    }>;
    totalHistoricalCVs: number;
  } {
    if (!raw) {
      return {
        profileSummary: '',
        skills: [],
        matchedJobs: [],
        totalHistoricalCVs: 0,
      };
    }

    try {
      const parsed = this.parseJsonObject(raw);
      const matchedJobs = Array.isArray(parsed.matchedJobs)
        ? parsed.matchedJobs.map((item: any) => ({
            title: String(item?.title || '').trim(),
            matchPercentage: this.clampInt(item?.matchPercentage, 1, 100, 50),
            level: String(item?.level || '').trim(),
            reason: String(item?.reason || '').trim(),
            basedOn: String(item?.basedOn || '').trim(),
            similarCVsCount: this.clampInt(item?.similarCVsCount, 0, 999, 0),
            missingSkills: Array.isArray(item?.missingSkills)
              ? item.missingSkills.map((x: unknown) => String(x)).filter(Boolean).slice(0, 10)
              : [],
          }))
        : [];

      return {
        profileSummary: String(parsed.profileSummary || '').trim(),
        skills: Array.isArray(parsed.skills) ? parsed.skills.map((x: unknown) => String(x)).filter(Boolean).slice(0, 40) : [],
        matchedJobs,
        totalHistoricalCVs: this.clampInt(parsed.totalHistoricalCVs, 0, 99999, 0),
      };
    } catch {
      this.logParseFailure('learning_match', raw);
      return {
        profileSummary: this.extractBrokenJsonString(raw, 'profileSummary'),
        skills: this.extractBrokenJsonStringArray(raw, 'skills'),
        matchedJobs: [],
        totalHistoricalCVs: this.clampInt(this.extractBrokenJsonNumber(raw, 'totalHistoricalCVs'), 0, 99999, 0),
      };
    }
  }

  private buildHistoricalJobCounts(cases: Array<{ jobSummary: string }>): Map<string, { title: string; count: number }> {
    const counts = new Map<string, { title: string; count: number }>();
    for (const row of cases) {
      const title = this.inferJobTitleFromSummary(row.jobSummary);
      const normalizedTitle = this.normalize(title);
      if (!normalizedTitle) continue;
      const current = counts.get(normalizedTitle);
      if (current) {
        current.count += 1;
      } else {
        counts.set(normalizedTitle, { title, count: 1 });
      }
    }
    return counts;
  }

  private countSimilarForTitle(title: string, counts: Map<string, { title: string; count: number }>): number {
    const normalizedTitle = this.normalize(title);
    if (!normalizedTitle) return 0;

    const exact = counts.get(normalizedTitle);
    if (exact) return exact.count;

    let partial = 0;
    for (const [key, value] of counts.entries()) {
      if (key.includes(normalizedTitle) || normalizedTitle.includes(key)) {
        partial += value.count;
      }
    }
    return partial;
  }

  private inferJobTitleFromSummary(jobSummary: string): string {
    const raw = String(jobSummary || '').trim();
    if (!raw) return '';

    const firstLine = raw.split(/\r?\n/)[0].trim();
    if (
      firstLine &&
      firstLine.length <= 90 &&
      /(developer|engineer|analyst|designer|manager|qa|devops|scientist|architect|mobile|frontend|backend|full stack|ios|android)/i.test(
        firstLine,
      )
    ) {
      return firstLine;
    }

    const normalized = this.normalize(raw);
    const dictionary = [
      'backend developer',
      'frontend developer',
      'full stack developer',
      'mobile developer ios',
      'mobile developer android',
      'mobile developer',
      'qa automation',
      'qa tester',
      'devops engineer',
      'data analyst',
      'data scientist',
      'product manager',
      'ui designer',
      'ux ui designer',
      'security engineer',
      'cybersecurity analyst',
    ];
    const found = dictionary.find((role) => normalized.includes(this.normalize(role)));
    return found ? found.replace(/\b\w/g, (c) => c.toUpperCase()) : '';
  }

  private detectLevelFromTitle(title: string): string {
    const normalized = this.normalize(title);
    if (/\b(senior|sr)\b/.test(normalized)) return 'Senior';
    if (/\b(semi senior|ssr|mid)\b/.test(normalized)) return 'Semi Senior';
    if (/\b(lead|staff|principal)\b/.test(normalized)) return 'Lead';
    return 'Junior';
  }

  private getFallbackRoleSkills(targetRole: string): { coreSkills: string[]; optionalSkills: string[] } | null {
    const role = this.normalize(targetRole);
    if (!role) return null;

    if (role.includes('frontend')) {
      return {
        coreSkills: ['html', 'css', 'javascript', 'typescript', 'react', 'git'],
        optionalSkills: ['vue', 'angular', 'tailwind', 'testing', 'rest api'],
      };
    }
    if (role.includes('backend')) {
      return {
        coreSkills: ['node.js', 'sql', 'rest api', 'git', 'docker'],
        optionalSkills: ['express', 'postgresql', 'mongodb', 'testing', 'aws'],
      };
    }
    if (role.includes('full stack') || role.includes('fullstack')) {
      return {
        coreSkills: ['javascript', 'node.js', 'sql', 'react', 'git'],
        optionalSkills: ['typescript', 'express', 'postgresql', 'docker', 'rest api'],
      };
    }
    if (role.includes('data analyst')) {
      return {
        coreSkills: ['sql', 'excel', 'python', 'power bi', 'estadistica'],
        optionalSkills: ['tableau', 'pandas', 'numpy', 'visualizacion de datos'],
      };
    }
    if (role.includes('mobile')) {
      return {
        coreSkills: ['kotlin', 'swift', 'git', 'apis rest', 'firebase'],
        optionalSkills: ['flutter', 'dart', 'android sdk', 'ios sdk'],
      };
    }
    return null;
  }

  private clampInt(value: unknown, min: number, max: number, fallback: number): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.round(n)));
  }

  private parseMatch(raw: string | null) {
    if (!raw) {
      return {
        compatibilityScore: 50,
        decision: 'possible_match',
        reasons: ['No hubo respuesta estructurada de Gemini.'],
        missingSkills: [],
        interviewFocus: [],
      };
    }

    try {
      const parsed = this.parseJsonObject(raw);

      if (
        typeof parsed.match_summary !== 'undefined' ||
        Array.isArray(parsed.matching_skills) ||
        Array.isArray(parsed.missing_skills)
      ) {
        const matchingSkills = Array.isArray(parsed.matching_skills)
          ? parsed.matching_skills.map((x: unknown) => String(x)).slice(0, 20)
          : [];
        const missingSkills = Array.isArray(parsed.missing_skills)
          ? parsed.missing_skills.map((x: unknown) => String(x)).slice(0, 20)
          : [];

        const ratioBase = matchingSkills.length + missingSkills.length;
        const inferredScore = ratioBase > 0 ? Math.round((matchingSkills.length / ratioBase) * 100) : 50;
        const compatibilityScore = Math.max(0, Math.min(100, inferredScore));
        const decision =
          compatibilityScore >= 75 ? 'strong_match' : compatibilityScore >= 45 ? 'possible_match' : 'weak_match';
        const reasons = [String(parsed.match_summary || '').trim(), String(parsed.improvement_tip || '').trim()]
          .filter(Boolean)
          .slice(0, 8);

        return {
          compatibilityScore,
          decision,
          reasons,
          missingSkills,
          interviewFocus: Array.isArray(parsed.matching_skills)
            ? parsed.matching_skills.map((x: unknown) => String(x)).slice(0, 10)
            : [],
          matchSummary: String(parsed.match_summary || '').slice(0, 600),
          matchingSkills,
          improvementTip: String(parsed.improvement_tip || '').slice(0, 320),
        };
      }

      const score = Number(parsed.compatibilityScore);

      return {
        compatibilityScore: Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : 50,
        decision: ['strong_match', 'possible_match', 'weak_match'].includes(parsed.decision)
          ? parsed.decision
          : 'possible_match',
        reasons: Array.isArray(parsed.reasons) ? parsed.reasons.map((x: unknown) => String(x)).slice(0, 10) : [],
        missingSkills: Array.isArray(parsed.missingSkills)
          ? parsed.missingSkills.map((x: unknown) => String(x)).slice(0, 12)
          : [],
        interviewFocus: Array.isArray(parsed.interviewFocus)
          ? parsed.interviewFocus.map((x: unknown) => String(x)).slice(0, 10)
          : [],
      };
    } catch {
      const recovered = this.recoverPartialMatch(raw);
      if (recovered) {
        return recovered;
      }
      this.logParseFailure('match', raw);
      return {
        compatibilityScore: 50,
        decision: 'possible_match',
        reasons: ['No se pudo parsear JSON de Gemini.'],
        missingSkills: [],
        interviewFocus: [],
      };
    }
  }

  private extractExperienceSummary(cvText: string): string {
    const normalized = this.normalize(cvText);
    const yearMatches = [...normalized.matchAll(/(\d{1,2})\s*(?:\+)?\s*(?:anos|ano|years|year)/g)];
    const years = yearMatches
      .map((m) => Number(m[1]))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => b - a);

    if (years.length > 0) {
      return `${years[0]} anos de experiencia estimada`;
    }
    if (/\b(practicante|practica|intern|trainee|sin experiencia)\b/.test(normalized)) {
      return 'Perfil inicial: practicas o sin experiencia formal';
    }
    return 'Experiencia no especificada claramente en el CV';
  }

  private parseCareerPath(raw: string | null) {
    if (!raw) {
      return {
        summary: 'No se pudo generar ruta en este intento.',
        estimatedMonths: 6,
        steps: [],
      };
    }

    try {
      const parsed = this.parseJsonObject(raw);
      if (Array.isArray(parsed.priority_skills_to_learn)) {
        const priority = parsed.priority_skills_to_learn.slice(0, 12).map((item: any, idx: number) => {
          const skill = String(item?.skill || '').trim();
          const why = String(item?.why_important || '').trim();
          const level = String(item?.level_required || '').trim();
          const courseType = String(item?.recommended_course_type || '').trim();
          const project = String(item?.practice_project || '').trim();
          const estimatedWeeksRaw = Number(item?.estimated_weeks);
          const estimatedWeeks = Number.isFinite(estimatedWeeksRaw)
            ? Math.max(1, Math.min(52, Math.round(estimatedWeeksRaw)))
            : 4;

          return {
            title: skill ? `Prioridad ${idx + 1}: ${skill}` : `Prioridad ${idx + 1}`,
            goal: [why, level ? `Nivel requerido: ${level}` : '', `Curso sugerido: ${courseType}`, `Proyecto: ${project}`]
              .filter(Boolean)
              .join(' | ')
              .slice(0, 280),
            skills: skill ? [skill] : [],
            resources: courseType ? [courseType] : [],
            etaWeeks: estimatedWeeks,
          };
        });

        const summary = [
          String(parsed.final_goal_validation || '').trim(),
          Array.isArray(parsed.learning_order) && parsed.learning_order.length
            ? `Orden sugerido: ${parsed.learning_order.map((x: unknown) => String(x)).join(' -> ')}`
            : '',
        ]
          .filter(Boolean)
          .join(' | ')
          .slice(0, 800);

        const estimatedMonths = Math.max(
          1,
          Math.min(
            48,
            Math.round(
              priority.reduce((acc: number, s: { etaWeeks: number }) => acc + (Number(s.etaWeeks) || 0), 0) / 4,
            ) || 6,
          ),
        );

        return {
          summary: summary || `Ruta personalizada para ${String(parsed.target_role || '').trim() || 'rol objetivo'}.`,
          estimatedMonths,
          steps: priority,
          targetRole: String(parsed.target_role || '').trim(),
          learningOrder: Array.isArray(parsed.learning_order)
            ? parsed.learning_order.map((x: unknown) => String(x)).slice(0, 20)
            : [],
          milestoneChecklist: Array.isArray(parsed.milestone_checklist)
            ? parsed.milestone_checklist.map((x: unknown) => String(x)).slice(0, 30)
            : [],
          finalGoalValidation: String(parsed.final_goal_validation || '').slice(0, 500),
        };
      }

      const steps = Array.isArray(parsed.steps) ? parsed.steps : [];
      return {
        summary: String(parsed.summary || '').slice(0, 800),
        estimatedMonths: Number.isFinite(Number(parsed.estimatedMonths))
          ? Math.max(1, Math.min(48, Math.round(Number(parsed.estimatedMonths))))
          : 6,
        steps: steps.slice(0, 12).map((s: any) => ({
          title: String(s?.title || 'Paso').slice(0, 120),
          goal: String(s?.goal || '').slice(0, 280),
          skills: Array.isArray(s?.skills) ? s.skills.map((x: unknown) => String(x)).slice(0, 12) : [],
          resources: Array.isArray(s?.resources) ? s.resources.map((x: unknown) => String(x)).slice(0, 8) : [],
          etaWeeks: Number.isFinite(Number(s?.etaWeeks)) ? Math.max(1, Math.min(52, Math.round(Number(s?.etaWeeks)))) : 4,
        })),
      };
    } catch {
      const recovered = this.recoverPartialCareerPath(raw);
      if (recovered) {
        return recovered;
      }
      this.logParseFailure('career_path', raw);
      return {
        summary: 'No se pudo parsear la ruta de carrera.',
        estimatedMonths: 6,
        steps: [],
      };
    }
  }

  private parseJsonObject(raw: string): any {
    const trimmed = String(raw || '').trim();
    if (!trimmed) throw new Error('empty_raw');

    try {
      return JSON.parse(trimmed);
    } catch {
      // continue
    }

    const normalizedJson = this.normalizeBrokenJson(trimmed);
    if (normalizedJson !== trimmed) {
      try {
        return JSON.parse(normalizedJson);
      } catch {
        // continue
      }
    }

    // Some models may return a JSON string literal that contains escaped JSON.
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      try {
        const once = JSON.parse(trimmed);
        if (typeof once === 'string') {
          return this.parseJsonObject(once);
        }
      } catch {
        // continue
      }
    }

    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
      const fencedBody = fenced[1].trim();
      try {
        return JSON.parse(fencedBody);
      } catch {
        const normalizedFenced = this.normalizeBrokenJson(fencedBody);
        if (normalizedFenced !== fencedBody) {
          try {
            return JSON.parse(normalizedFenced);
          } catch {
            // continue
          }
        }
      }
    }

    // Extract balanced JSON object candidates and parse first valid one.
    for (let start = 0; start < trimmed.length; start += 1) {
      if (trimmed[start] !== '{') continue;

      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let i = start; i < trimmed.length; i += 1) {
        const ch = trimmed[i];

        if (inString) {
          if (escaped) {
            escaped = false;
            continue;
          }
          if (ch === '\\') {
            escaped = true;
            continue;
          }
          if (ch === '"') {
            inString = false;
          }
          continue;
        }

        if (ch === '"') {
          inString = true;
          continue;
        }
        if (ch === '{') depth += 1;
        if (ch === '}') depth -= 1;

        if (depth === 0) {
          const candidate = trimmed.slice(start, i + 1);
          try {
            return JSON.parse(candidate);
          } catch {
            const normalizedCandidate = this.normalizeBrokenJson(candidate);
            if (normalizedCandidate !== candidate) {
              try {
                return JSON.parse(normalizedCandidate);
              } catch {
                // continue
              }
            }
            break;
          }
        }
      }
    }

    throw new Error('json_not_found');
  }

  private normalizeBrokenJson(input: string): string {
    let output = '';
    let inString = false;
    let escaped = false;

    for (let i = 0; i < input.length; i += 1) {
      const ch = input[i];

      if (inString) {
        if (escaped) {
          output += ch;
          escaped = false;
          continue;
        }
        if (ch === '\\') {
          output += ch;
          escaped = true;
          continue;
        }
        if (ch === '"') {
          output += ch;
          inString = false;
          continue;
        }
        // Gemini sometimes inserts literal line breaks/control chars inside string values.
        if (ch === '\n' || ch === '\r' || ch === '\t') {
          output += ' ';
          continue;
        }
        output += ch;
        continue;
      }

      if (ch === '"') {
        output += ch;
        inString = true;
        continue;
      }
      output += ch;
    }

    // Remove trailing commas before object/array close.
    return output.replace(/,\s*([}\]])/g, '$1');
  }

  private recoverPartialMatch(raw: string | null) {
    const text = String(raw || '');
    if (!text) return null;

    const matchSummary = this.extractBrokenJsonString(text, 'match_summary');
    const improvementTip = this.extractBrokenJsonString(text, 'improvement_tip');
    const matchingSkills = this.extractBrokenJsonStringArray(text, 'matching_skills');
    const missingSkills = this.extractBrokenJsonStringArray(text, 'missing_skills');

    if (!matchSummary && !improvementTip && !matchingSkills.length && !missingSkills.length) {
      return null;
    }

    const ratioBase = matchingSkills.length + missingSkills.length;
    const inferredScore = ratioBase > 0 ? Math.round((matchingSkills.length / ratioBase) * 100) : 60;
    const compatibilityScore = Math.max(0, Math.min(100, inferredScore));
    const decision =
      compatibilityScore >= 75 ? 'strong_match' : compatibilityScore >= 45 ? 'possible_match' : 'weak_match';

    const reasons = [matchSummary, improvementTip].filter(Boolean).slice(0, 8) as string[];

    return {
      compatibilityScore,
      decision,
      reasons: reasons.length ? reasons : ['Se recupero respuesta parcial de Gemini.'],
      missingSkills,
      interviewFocus: matchingSkills.slice(0, 10),
      matchSummary: String(matchSummary || '').slice(0, 600),
      matchingSkills,
      improvementTip: String(improvementTip || '').slice(0, 320),
    };
  }

  private recoverPartialCareerPath(raw: string | null) {
    const text = String(raw || '');
    if (!text) return null;

    const targetRole = this.extractBrokenJsonString(text, 'target_role');
    const newSkills = this.extractAllBrokenJsonStringsByKey(text, 'skill').slice(0, 12);
    const newWhy = this.extractAllBrokenJsonStringsByKey(text, 'why_important').slice(0, 12);
    const newLevel = this.extractAllBrokenJsonStringsByKey(text, 'level_required').slice(0, 12);
    const newCourse = this.extractAllBrokenJsonStringsByKey(text, 'recommended_course_type').slice(0, 12);
    const newProject = this.extractAllBrokenJsonStringsByKey(text, 'practice_project').slice(0, 12);
    const newWeeks = this.extractAllBrokenJsonNumbersByKey(text, 'estimated_weeks').slice(0, 12);
    const newLearningOrder = this.extractBrokenJsonStringArray(text, 'learning_order');
    const newChecklist = this.extractBrokenJsonStringArray(text, 'milestone_checklist');
    const newFinalGoal = this.extractBrokenJsonString(text, 'final_goal_validation');

    const newMaxLen = Math.max(newSkills.length, newWhy.length, newLevel.length, newCourse.length, newProject.length, newWeeks.length);
    const newSteps = Array.from({ length: newMaxLen }).map((_, idx) => ({
      title: newSkills[idx] ? `Prioridad ${idx + 1}: ${newSkills[idx]}` : `Prioridad ${idx + 1}`,
      goal: [
        String(newWhy[idx] || '').trim(),
        newLevel[idx] ? `Nivel requerido: ${newLevel[idx]}` : '',
        newCourse[idx] ? `Curso sugerido: ${newCourse[idx]}` : '',
        newProject[idx] ? `Proyecto: ${newProject[idx]}` : '',
      ]
        .filter(Boolean)
        .join(' | ')
        .slice(0, 280),
      skills: newSkills[idx] ? [newSkills[idx]] : [],
      resources: newCourse[idx] ? [newCourse[idx]] : [],
      etaWeeks: Number.isFinite(newWeeks[idx]) ? Math.max(1, Math.min(52, Math.round(newWeeks[idx]))) : 4,
    }));

    if (targetRole || newSteps.length || newLearningOrder.length || newChecklist.length || newFinalGoal) {
      const summary = [newFinalGoal, newLearningOrder.length ? `Orden sugerido: ${newLearningOrder.join(' -> ')}` : '']
        .filter(Boolean)
        .join(' | ')
        .slice(0, 800);
      const estimatedMonths = Math.max(
        1,
        Math.min(
          48,
          Math.round(newSteps.reduce((acc, s) => acc + (Number(s.etaWeeks) || 0), 0) / 4) || 6,
        ),
      );

      return {
        summary: summary || `Ruta personalizada para ${targetRole || 'rol objetivo'}.`,
        estimatedMonths,
        steps: newSteps,
        targetRole,
        learningOrder: newLearningOrder.slice(0, 20),
        milestoneChecklist: newChecklist.slice(0, 30),
        finalGoalValidation: String(newFinalGoal || '').slice(0, 500),
      };
    }

    const summary = this.extractBrokenJsonString(text, 'summary');
    const estimatedMonthsRaw = this.extractBrokenJsonNumber(text, 'estimatedMonths');
    const estimatedMonths = Number.isFinite(estimatedMonthsRaw)
      ? Math.max(1, Math.min(48, Math.round(Number(estimatedMonthsRaw))))
      : 6;

    const titles = this.extractAllBrokenJsonStringsByKey(text, 'title').slice(0, 12);
    const goals = this.extractAllBrokenJsonStringsByKey(text, 'goal').slice(0, 12);
    const skillsBlocks = this.extractAllBrokenJsonArraysByKey(text, 'skills').slice(0, 12);
    const resourceBlocks = this.extractAllBrokenJsonArraysByKey(text, 'resources').slice(0, 12);
    const etaValues = this.extractAllBrokenJsonNumbersByKey(text, 'etaWeeks').slice(0, 12);

    const maxLen = Math.max(titles.length, goals.length, skillsBlocks.length, resourceBlocks.length, etaValues.length);
    const steps = Array.from({ length: maxLen }).map((_, idx) => ({
      title: String(titles[idx] || `Paso ${idx + 1}`).slice(0, 120),
      goal: String(goals[idx] || '').slice(0, 280),
      skills: (skillsBlocks[idx] || []).slice(0, 12),
      resources: (resourceBlocks[idx] || []).slice(0, 8),
      etaWeeks: Number.isFinite(etaValues[idx]) ? Math.max(1, Math.min(52, Math.round(etaValues[idx]))) : 4,
    }));

    if (!summary && !steps.length) return null;

    return {
      summary: String(summary || 'Ruta recuperada parcialmente desde respuesta de Gemini.').slice(0, 800),
      estimatedMonths,
      steps,
    };
  }

  private extractBrokenJsonString(text: string, key: string): string {
    const keyIdx = text.indexOf(`"${key}"`);
    if (keyIdx < 0) return '';
    const colonIdx = text.indexOf(':', keyIdx);
    if (colonIdx < 0) return '';
    const firstQuote = text.indexOf('"', colonIdx + 1);
    if (firstQuote < 0) return '';

    let out = '';
    let escaped = false;
    for (let i = firstQuote + 1; i < text.length; i += 1) {
      const ch = text[i];
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        break;
      }
      if (ch === '\n' || ch === '\r' || ch === '\t') {
        out += ' ';
        continue;
      }
      out += ch;
    }
    return out.replace(/\s+/g, ' ').trim();
  }

  private extractBrokenJsonStringArray(text: string, key: string): string[] {
    const keyIdx = text.indexOf(`"${key}"`);
    if (keyIdx < 0) return [];
    const bracketStart = text.indexOf('[', keyIdx);
    if (bracketStart < 0) return [];
    const bracketEnd = text.indexOf(']', bracketStart + 1);
    const arrBody = (bracketEnd >= 0 ? text.slice(bracketStart + 1, bracketEnd) : text.slice(bracketStart + 1)).trim();
    if (!arrBody) return [];

    const values: string[] = [];
    const regex = /"([^"\\]*(?:\\.[^"\\]*)*)"/g;
    let m: RegExpExecArray | null = null;
    while ((m = regex.exec(arrBody)) !== null) {
      const value = m[1]
        .replace(/\\n|\\r|\\t/g, ' ')
        .replace(/\\"/g, '"')
        .replace(/\s+/g, ' ')
        .trim();
      if (value) values.push(value);
    }
    return [...new Set(values)].slice(0, 20);
  }

  private extractBrokenJsonNumber(text: string, key: string): number {
    const keyIdx = text.indexOf(`"${key}"`);
    if (keyIdx < 0) return NaN;
    const tail = text.slice(keyIdx);
    const m = tail.match(new RegExp(`"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`));
    return m ? Number(m[1]) : NaN;
  }

  private extractAllBrokenJsonStringsByKey(text: string, key: string): string[] {
    const values: string[] = [];
    const regex = new RegExp(`"${key}"\\s*:\\s*"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"`, 'g');
    let m: RegExpExecArray | null = null;
    while ((m = regex.exec(text)) !== null) {
      const value = m[1]
        .replace(/\\n|\\r|\\t/g, ' ')
        .replace(/\\"/g, '"')
        .replace(/\s+/g, ' ')
        .trim();
      if (value) values.push(value);
    }
    return values;
  }

  private extractAllBrokenJsonArraysByKey(text: string, key: string): string[][] {
    const blocks: string[][] = [];
    const regex = new RegExp(`"${key}"\\s*:\\s*\\[([^\\]]*)`, 'g');
    let m: RegExpExecArray | null = null;
    while ((m = regex.exec(text)) !== null) {
      const body = String(m[1] || '');
      const values: string[] = [];
      const itemRegex = /"([^"\\]*(?:\\.[^"\\]*)*)"/g;
      let item: RegExpExecArray | null = null;
      while ((item = itemRegex.exec(body)) !== null) {
        const value = item[1]
          .replace(/\\n|\\r|\\t/g, ' ')
          .replace(/\\"/g, '"')
          .replace(/\s+/g, ' ')
          .trim();
        if (value) values.push(value);
      }
      blocks.push([...new Set(values)]);
    }
    return blocks;
  }

  private extractAllBrokenJsonNumbersByKey(text: string, key: string): number[] {
    const values: number[] = [];
    const regex = new RegExp(`"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`, 'g');
    let m: RegExpExecArray | null = null;
    while ((m = regex.exec(text)) !== null) {
      const value = Number(m[1]);
      if (Number.isFinite(value)) values.push(value);
    }
    return values;
  }

  private logParseFailure(scope: string, raw: string | null) {
    if (String(process.env.GEMINI_DEBUG || '').toLowerCase() !== 'true') return;
    const preview = String(raw || '')
      .replace(/\s+/g, ' ')
      .slice(0, 500);
    console.error(`[RecruitingService] parse failure scope=${scope} raw_preview=${preview}`);
  }

  private computeMissingSkills(cvSkills: string[], marketSkills: string[]): string[] {
    const cvNorm = cvSkills.map((s) => this.normalize(s));
    return marketSkills.filter((skill) => {
      const n = this.normalize(skill);
      if (!n) return false;
      return !cvNorm.some((cv) => cv === n || cv.includes(n) || n.includes(cv));
    });
  }

  private matchCvSkillsByCatalogNormalized(normalizedCv: string, catalog: string[]): string[] {
    const out: string[] = [];
    for (const skill of catalog) {
      const normalizedSkill = this.normalize(skill);
      if (!normalizedSkill) continue;
      if (normalizedCv.includes(normalizedSkill)) out.push(normalizedSkill);
    }
    return [...new Set(out)];
  }

  private normalizeSkillList(skills: string[]): string[] {
    return [...new Set((skills || []).map((s) => this.normalize(s)).filter(Boolean))];
  }

  private normalize(value: string): string {
    return String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9+#.\s-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private extractTechnicalSkills(text: string): string[] {
    const normalized = this.normalize(text);
    return this.knownCvSkills.filter((skill) => normalized.includes(skill.toLowerCase()));
  }

  private buildFallbackCareerPath(
    targetRole: string,
    cvSkills: string[],
    marketSkills: string[],
    missingSkills: string[],
  ) {
    const prioritized = (missingSkills.length ? missingSkills : marketSkills).slice(0, 9);
    const blockA = prioritized.slice(0, 3);
    const blockB = prioritized.slice(3, 6);
    const blockC = prioritized.slice(6, 9);

    return {
      summary: `Ruta generada con contexto de mercado para ${targetRole}. Se priorizan brechas detectadas segun perfiles exitosos.`,
      estimatedMonths: 6,
      steps: [
        {
          title: 'Paso 1: Fundamentos y refuerzo',
          goal: `Consolidar base tecnica y cubrir primeras brechas: ${blockA.join(', ') || 'fundamentos del rol'}.`,
          skills: blockA.length ? blockA : cvSkills.slice(0, 3),
          resources: ['Documentacion oficial', 'Curso base del stack', 'Katas/ejercicios'],
          etaWeeks: 4,
        },
        {
          title: 'Paso 2: Stack objetivo',
          goal: `Dominar herramientas y patrones del puesto: ${blockB.join(', ') || 'stack principal del rol'}.`,
          skills: blockB.length ? blockB : marketSkills.slice(0, 3),
          resources: ['Proyecto guiado', 'Repositorio de buenas practicas', 'Code reviews'],
          etaWeeks: 6,
        },
        {
          title: 'Paso 3: Proyecto demostrable',
          goal: `Construir un proyecto portfolio aplicando: ${blockC.join(', ') || 'skills del mercado'}.`,
          skills: blockC.length ? blockC : marketSkills.slice(3, 6),
          resources: ['Proyecto end-to-end', 'README tecnico', 'Deploy publico'],
          etaWeeks: 6,
        },
      ],
    };
  }

  private detectKeyDifference(cvSkills: string[], missingSkills: string[], englishLevel: string | undefined): string {
    if (missingSkills.length > 0) {
      return `No domina aun ${missingSkills.slice(0, 3).join(', ')}`;
    }
    if (englishLevel && englishLevel !== 'advanced') {
      return `Nivel de ingles ${englishLevel} (se requiere mejora para entrevistas y documentacion)`;
    }
    if (cvSkills.length < 4) {
      return 'Perfil con stack reducido; necesita mas profundidad y amplitud tecnica';
    }
    return 'Necesita acelerar experiencia demostrable en proyectos reales';
  }

  private detectImproveTopic(
    historicalCases: Array<{ successfulSteps: string[] }>,
    missingSkills: string[],
  ): string {
    const historicalJoined = historicalCases
      .flatMap((c) => c.successfulSteps || [])
      .map((x) => this.normalize(String(x)))
      .join(' ');

    for (const skill of missingSkills) {
      const normalizedSkill = this.normalize(skill);
      if (!normalizedSkill) continue;
      if (!historicalJoined.includes(normalizedSkill)) {
        return skill;
      }
    }

    return missingSkills[0] || 'proyectos de impacto y portafolio';
  }

  private parseLearningResources(raw: string | null, skillName: string) {
    if (!raw) {
      return this.learningResourceFallback(skillName);
    }

    try {
      const jsonText = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
      const parsed = JSON.parse(jsonText);
      return {
        free_resource: {
          title: String(parsed?.free_resource?.title || `Curso gratuito de ${skillName}`).slice(0, 140),
          platform: String(parsed?.free_resource?.platform || 'Documentacion oficial').slice(0, 80),
          url_search_term: String(parsed?.free_resource?.url_search_term || `${skillName} tutorial oficial`).slice(0, 180),
        },
        paid_resource: {
          title: String(parsed?.paid_resource?.title || `Especializacion de ${skillName}`).slice(0, 140),
          platform: String(parsed?.paid_resource?.platform || 'Udemy').slice(0, 80),
        },
        practice_project: String(parsed?.practice_project || `Crea un mini proyecto aplicando ${skillName} hoy.`).slice(0, 260),
      };
    } catch {
      return this.learningResourceFallback(skillName);
    }
  }

  private learningResourceFallback(skillName: string) {
    return {
      free_resource: {
        title: `Fundamentos gratuitos de ${skillName}`,
        platform: 'Documentacion oficial',
        url_search_term: `${skillName} official documentation tutorial`,
      },
      paid_resource: {
        title: `Curso completo de ${skillName}`,
        platform: 'Udemy',
      },
      practice_project: `Construye una mini app de ejemplo usando ${skillName} con al menos 2 funcionalidades reales.`,
    };
  }
}
