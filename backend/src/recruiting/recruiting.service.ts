import { Injectable } from '@nestjs/common';
import { GeminiService } from '../common/services/gemini.service';
import { RecruitingRagService } from '../common/services/recruiting-rag.service';
import { FeedbackDto } from './dto-feedback.dto';
import { GenerateCareerPathDto } from './dto-generate-career-path.dto';
import { GenerateCareerPathFromCvDto } from './dto-generate-career-path-from-cv.dto';
import { MatchCvDto } from './dto-match-cv.dto';
import { buildCareerPathGapPrompt, buildCareerPathSystemPrompt, buildMatchSystemPrompt } from './prompts';

@Injectable()
export class RecruitingService {
  constructor(
    private readonly geminiService: GeminiService,
    private readonly ragService: RecruitingRagService,
  ) {}

  async matchCv(dto: MatchCvDto) {
    const similarAcceptedCases = await this.ragService.findAcceptedCases(
      `${dto.cvText}\n${dto.jobTitle || ''}\n${dto.jobDescription}`,
      4,
    );

    const prompt = buildMatchSystemPrompt({
      cvText: dto.cvText,
      jobDescription: dto.jobDescription,
      jobTitle: dto.jobTitle,
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
      ...parsed,
    };
  }

  async generateCareerPath(dto: GenerateCareerPathDto) {
    const priorSuccessfulPaths = await this.ragService.findSuccessfulCareerPaths(dto.targetRole, 4);
    const prompt = buildCareerPathSystemPrompt({
      currentProfile: dto.currentProfile,
      targetRole: dto.targetRole,
      priorSuccessfulPaths,
    });

    const raw = await this.geminiService.runStructuredPrompt(prompt, 1200);
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
    const insights = await this.geminiService.extractCvInsights(dto.cvText, dto.targetRole);
    const cvSkills = this.extractTechnicalSkills(`${dto.cvText}\n${(insights.keywords || []).join(' ')}`).slice(0, 20);
    const marketSkills = await this.ragService.findSuccessfulRoleSkills(dto.targetRole, 18);
    const missingSkills = this.computeMissingSkills(cvSkills, marketSkills).slice(0, 14);

    const prompt = buildCareerPathGapPrompt({
      targetRole: dto.targetRole,
      cvSkills,
      marketSkills,
      missingSkills,
      cvText: dto.cvText,
    });

    const raw = await this.geminiService.runStructuredPrompt(prompt, 1400);
    const parsed = this.parseCareerPath(raw);
    const withFallback = parsed.steps.length
      ? parsed
      : this.buildFallbackCareerPath(dto.targetRole, cvSkills, marketSkills, missingSkills);

    const pathId = await this.ragService.saveCareerPath({
      userId: dto.userId || 'anonymous',
      targetRole: dto.targetRole,
      summary: withFallback.summary,
      steps: withFallback.steps,
    });

    return {
      pathId,
      cvSkills,
      marketSkills,
      missingSkills,
      ragContextUsed: marketSkills.length,
      ...withFallback,
    };
  }

  async registerFeedback(dto: FeedbackDto) {
    return this.ragService.registerFeedback(dto);
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
      const jsonText = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
      const parsed = JSON.parse(jsonText);
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
      return {
        compatibilityScore: 50,
        decision: 'possible_match',
        reasons: ['No se pudo parsear JSON de Gemini.'],
        missingSkills: [],
        interviewFocus: [],
      };
    }
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
      const jsonText = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
      const parsed = JSON.parse(jsonText);
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
      return {
        summary: 'No se pudo parsear la ruta de carrera.',
        estimatedMonths: 6,
        steps: [],
      };
    }
  }

  private computeMissingSkills(cvSkills: string[], marketSkills: string[]): string[] {
    const cvNorm = cvSkills.map((s) => this.normalize(s));
    return marketSkills.filter((skill) => {
      const n = this.normalize(skill);
      if (!n) return false;
      return !cvNorm.some((cv) => cv === n || cv.includes(n) || n.includes(cv));
    });
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
    const lexicon = [
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
    ];
    return lexicon.filter((skill) => normalized.includes(this.normalize(skill)));
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
}
