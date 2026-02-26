import { BadRequestException, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ExportPdfDto } from './dto-export-pdf.dto';
import { GenerateApplicationDto } from './dto-generate-application.dto';
import { MatchCvJobsDto } from './dto-match-cv-jobs.dto';
import { CvInsights, GeminiService } from '../common/services/gemini.service';
import { PdfService } from '../common/services/pdf.service';
import { ScraperService } from '../common/services/scraper.service';
import { UsageService } from '../common/services/usage.service';
import { ExperienceProfile, JobSearchResult, JobSearchService, MatchedJob } from '../common/services/job-search.service';
import { CvParserService } from '../common/services/cv-parser.service';
import { SearchMemoryService } from '../common/services/search-memory.service';

const FREE_LIMIT = 3;
const PREMIUM_PRICE = 15;

export interface TrainingDatasetRow {
  title: string;
  company: string;
  location: string;
  source?: string;
  source_url?: string;
  skills_required: string[];
  extracted_stack: string[];
  detected_seniority: string;
  description: string;
  processed_timestamp: string;
}

export interface RankedJobRow {
  title: string;
  company: string;
  location?: string;
  source?: string;
  source_url?: string;
  compatibility_score: number;
  match_level: 'Alto' | 'Medio' | 'Bajo';
  matching_skills: string[];
  missing_skills: string[];
  reason: string;
}

export interface EmployabilityAnalysisResult {
  analysis_summary: string;
  market_insights: {
    most_demanded_skills: string[];
    common_stacks: string[];
    average_seniority_required: string;
  };
  ranked_jobs: RankedJobRow[];
  career_gap_analysis: {
    target_role: string;
    critical_missing_skills: string[];
    secondary_missing_skills: string[];
  };
  career_roadmap: Array<{
    priority: number;
    skill_to_learn: string;
    required_level: string;
    why_important: string;
    recommended_course_type: string;
    mandatory_project: string;
    estimated_time_weeks: number;
  }>;
  action_checklist: string[];
  training_dataset: TrainingDatasetRow[];
  recommendation_buckets: {
    best_skill_match_jobs: RankedJobRow[];
    target_role_match_jobs: RankedJobRow[];
  };
  skills_best_fit?: {
    role: string;
    role_match_percent: number;
    top_job_title: string;
    top_job_score: number;
  };
}

export interface ProcessedJobRow {
  job_id: string;
  title: string;
  company: string;
  location: string;
  category: string;
  role_slug: string;
  seniority: string;
  skills_required: string[];
  tech_stack: string[];
  sector_detected: string;
  description_clean: string;
  embedding_text: string;
}

export interface ProcessedJobsOutput {
  processed_jobs: ProcessedJobRow[];
  detected_market_summary: {
    roles_detected: string[];
    categories_detected: string[];
    seniority_distribution: Record<string, number>;
  };
}

interface NormalizedTechOutput {
  skills_required: string[];
  extracted_stack: string[];
  raw_detected_phrases: string[];
}

@Injectable()
export class JobService {
  private readonly datasetFilePath = path.join(process.cwd(), 'data', 'stored-jobs-dataset.json');
  private trainedSkillVocabularyCache: { loadedAt: number; values: string[] } | null = null;
  private trainedRoleProfilesCache:
    | { loadedAt: number; values: Array<{ role: string; requiredSkills: string[]; optionalSkills: string[] }> }
    | null = null;

  constructor(
    private readonly scraperService: ScraperService,
    private readonly geminiService: GeminiService,
    private readonly usageService: UsageService,
    private readonly pdfService: PdfService,
    private readonly jobSearchService: JobSearchService,
    private readonly cvParserService: CvParserService,
    private readonly searchMemoryService: SearchMemoryService,
  ) {}

  async generateApplication(dto: GenerateApplicationDto) {
    const usage = await this.usageService.getOrCreate(dto.userId);

    if (dto.plan === 'free' && usage.freeUses >= FREE_LIMIT) {
      throw new HttpException(
        {
          message: `Plan gratis agotado. Contrata premium por S/${PREMIUM_PRICE} al mes para postulaciones ilimitadas y PDF premium.`,
          freeLimit: FREE_LIMIT,
          currentUses: usage.freeUses,
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    const jobData = await this.scraperService.scrapeJob(dto.jobUrl);
    if (!jobData.rawText || jobData.rawText.length < 100) {
      throw new BadRequestException('No se pudo extraer suficiente contenido de la oferta laboral.');
    }

    const result = await this.geminiService.generateJobApplication({
      jobData,
      candidate: {
        fullName: dto.fullName,
        profileSummary: dto.profileSummary || '',
        oldCvText: dto.oldCvText || '',
        education: dto.education || '',
        skills: dto.skills || '',
      },
      isPremium: dto.plan === 'premium',
    });

    if (dto.plan === 'free') {
      await this.usageService.incrementFreeUse(dto.userId);
    }

    const updated = await this.usageService.getOrCreate(dto.userId);

    return {
      ...result,
      plan: dto.plan,
      remainingFreeUses: Math.max(FREE_LIMIT - updated.freeUses, 0),
      pricing: {
        premiumMonthlyPen: PREMIUM_PRICE,
      },
      jobPreview: {
        title: jobData.title,
        company: jobData.company,
        topKeywords: jobData.keywords,
      },
    };
  }

  async exportPremiumPdf(dto: ExportPdfDto) {
    if (dto.plan !== 'premium') {
      throw new HttpException(
        `La exportacion PDF premium requiere suscripcion activa de S/${PREMIUM_PRICE} al mes.`,
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    const usage = await this.usageService.getOrCreate(dto.userId);

    if (usage.freeUses < 0) {
      throw new BadRequestException('Estado de usuario invalido.');
    }

    const pdfBase64 = await this.pdfService.buildPremiumPdf({
      fullName: dto.fullName,
      cvText: dto.cvText,
      coverLetter: dto.coverLetter,
    });

    return {
      fileName: `cv-premium-${Date.now()}.pdf`,
      mimeType: 'application/pdf',
      data: pdfBase64,
    };
  }

  async matchJobsByCv(dto: MatchCvJobsDto, cvFile?: any) {
    const cvText = await this.cvParserService.parseCv(dto.cvText || '', cvFile);
    if (cvText.length < 80) {
      throw new BadRequestException(
        'No se pudo leer contenido suficiente del CV. Sube un PDF/TXT/MD/CSV o pega el texto del CV en el campo manual.',
      );
    }

    const insights = await this.extractInsightsWithFallback(cvText);
    const trainedVocabulary = await this.getTrainedSkillVocabulary();
    const cvSkillTokens = this.extractSkillTokens(cvText);
    const cvTrainedSkillTokens = this.extractSkillsByVocabulary(cvText, trainedVocabulary);
    const keywords = this.sanitizeKeywords(insights.keywords, trainedVocabulary);
    const desiredRole = dto.desiredRole?.trim() || insights.roles[0] || '';
    const candidateSkills = [...new Set([...cvSkillTokens, ...cvTrainedSkillTokens, ...keywords])];
    const apiQueryKeywords = candidateSkills.length ? candidateSkills : cvSkillTokens;
    const bestFitRolePreview = await this.findBestFitRoleBySkills(candidateSkills);
    const experienceProfile = this.inferExperienceProfile(cvText, desiredRole, insights);
    const country = dto.country?.trim() || dto.location?.trim() || 'Peru';
    const learningProfile = await this.searchMemoryService.getProfile(country, experienceProfile.level);
    const primarySearch = await this.jobSearchService.searchPublicJobs(
      apiQueryKeywords,
      dto.location,
      dto.country,
      desiredRole,
      experienceProfile,
      learningProfile,
    );
    let roleDrivenSearch: JobSearchResult = { jobs: [], providers: [] };
    if (bestFitRolePreview?.role) {
      roleDrivenSearch = await this.jobSearchService.searchPublicJobs(
        [bestFitRolePreview.role, ...apiQueryKeywords].slice(0, 20),
        dto.location,
        dto.country,
        bestFitRolePreview.role,
        experienceProfile,
        learningProfile,
      );
    }

    const uniqueJobs = this.dedupeJobs([...(primarySearch.jobs || []), ...(roleDrivenSearch.jobs || [])]);
    await this.searchMemoryService.learnFromResults(country, experienceProfile.level, keywords, uniqueJobs);
    const storedJobsDataset = await this.readStoredJobsDataset();
    const analysis = await this.buildEmployabilityAnalysis({
      cvProfile: cvText,
      targetRole: desiredRole || insights.roles[0] || 'Sin meta definida',
      jobsFromApi: uniqueJobs,
      storedJobsDataset,
      candidateSkills,
      experienceProfile,
    });
    const skillsBestFit = await this.computeSkillsBestFit(candidateSkills, analysis.ranked_jobs || []);
    if (skillsBestFit) {
      analysis.skills_best_fit = skillsBestFit;
      analysis.recommendation_buckets.best_skill_match_jobs = this.sortJobsForBestFitRole(
        analysis.recommendation_buckets.best_skill_match_jobs || analysis.ranked_jobs || [],
        skillsBestFit.role,
      ).slice(0, 10);
    }
    await this.mergeAndPersistTrainingDataset(analysis.training_dataset);
    const processedJobsOutput = this.buildProcessedJobsOutput(uniqueJobs);

    const region = dto.country?.trim() || dto.location?.trim() || 'tu pais';
    const providerStatus = [
      ...(primarySearch.providers || []),
      ...((roleDrivenSearch.providers || []).map((p) => ({
        ...p,
        provider: `${p.provider} (best-fit role)`,
      })) as any[]),
    ];

    return {
      extractedKeywords: keywords,
      extractedSkillTokens: cvSkillTokens,
      extractedRoles: insights.roles || [],
      englishLevel: insights.englishLevel,
      preferredJobTypes: insights.preferredJobTypes || [],
      experienceProfile,
      totalJobsFound: uniqueJobs.length,
      jobs: uniqueJobs,
      providerStatus,
      note: `Lista en ${region}, ordenada de mas reciente a mas antigua, con enlaces directos por portal/palabra clave.`,
      employabilityAnalysis: analysis,
      processedJobsOutput,
    };
  }

  private async buildEmployabilityAnalysis(input: {
    cvProfile: string;
    targetRole: string;
    jobsFromApi: MatchedJob[];
    storedJobsDataset: TrainingDatasetRow[];
    candidateSkills: string[];
    experienceProfile: ExperienceProfile;
  }): Promise<EmployabilityAnalysisResult> {
    const trainingDataset = input.jobsFromApi.map((job) => this.toTrainingDatasetRow(job));
    const fallback = this.buildDeterministicEmployabilityAnalysis({
      targetRole: input.targetRole,
      candidateSkills: input.candidateSkills,
      experienceProfile: input.experienceProfile,
      trainingDataset,
    });

    const prompt = this.buildEmployabilityPrompt({
      cvProfile: input.cvProfile,
      targetRole: input.targetRole,
      jobsFromApi: trainingDataset,
      storedJobsDataset: input.storedJobsDataset.slice(-120),
    });

    const raw = await this.geminiService.runStructuredPrompt(prompt, 2600, 0.72);
    if (!raw) return fallback;

    try {
      const parsed = this.parseJsonObject(raw) as Partial<EmployabilityAnalysisResult>;
      return this.normalizeEmployabilityAnalysis(parsed, fallback, trainingDataset);
    } catch {
      return fallback;
    }
  }

  private buildEmployabilityPrompt(input: {
    cvProfile: string;
    targetRole: string;
    jobsFromApi: TrainingDatasetRow[];
    storedJobsDataset: TrainingDatasetRow[];
  }): string {
    return [
      'Eres un sistema avanzado de analisis de empleabilidad y planificacion de carrera especializado en el mercado tecnologico de Peru.',
      '',
      'Tu tarea es:',
      'FASE 1 - MATCHING DE EMPLEOS',
      '1. Analizar el perfil del candidato (CV).',
      '2. Evaluar cada trabajo recibido desde APIs reales.',
      '3. Calcular compatibilidad.',
      '4. Ordenarlos de mayor a menor coincidencia.',
      '5. Detectar brechas criticas de habilidades.',
      '',
      'FASE 2 - GENERACION DE DATA PARA ENTRENAMIENTO',
      '6. Estructurar TODOS los trabajos recibidos en un formato limpio para almacenamiento.',
      '7. Extraer stack tecnologico, seniority detectado, habilidades clave, herramientas repetidas, tecnologias mas demandadas.',
      '8. No omitir ningun trabajo.',
      '',
      'FASE 3 - RUTA DE CARRERA INTELIGENTE',
      '9. Analizar la meta profesional del candidato.',
      '10. Comparar su perfil contra los trabajos mejor rankeados y tecnologias mas repetidas.',
      '11. Generar un roadmap EXACTO y priorizado.',
      '12. Para cada skill: nivel requerido, por que, curso sugerido (tipo/enfoque), proyecto obligatorio, tiempo estimado.',
      '13. Generar checklist accionable.',
      '14. Enfocarse en cerrar brechas reales del mercado peruano.',
      '',
      'REGLAS IMPORTANTES:',
      '- No inventes trabajos.',
      '- Solo usa los trabajos proporcionados.',
      '- No uses consejos genericos.',
      '- Cada recomendacion debe estar basada en datos detectados en los empleos.',
      '- Prioriza tecnologias que aparecen mas veces.',
      '- Detecta si la meta del usuario es coherente con su nivel actual.',
      '- Evita trabajos repetidos.',
      '',
      'Devuelve la respuesta EXACTAMENTE en este formato JSON:',
      '{',
      '  "analysis_summary": "",',
      '  "market_insights": {',
      '    "most_demanded_skills": [],',
      '    "common_stacks": [],',
      '    "average_seniority_required": ""',
      '  },',
      '  "ranked_jobs": [',
      '    {',
      '      "title": "",',
      '      "company": "",',
      '      "compatibility_score": 0,',
      '      "match_level": "Alto | Medio | Bajo",',
      '      "matching_skills": [],',
      '      "missing_skills": [],',
      '      "reason": ""',
      '    }',
      '  ],',
      '  "career_gap_analysis": {',
      '    "target_role": "",',
      '    "critical_missing_skills": [],',
      '    "secondary_missing_skills": []',
      '  },',
      '  "career_roadmap": [',
      '    {',
      '      "priority": 1,',
      '      "skill_to_learn": "",',
      '      "required_level": "",',
      '      "why_important": "",',
      '      "recommended_course_type": "",',
      '      "mandatory_project": "",',
      '      "estimated_time_weeks": 0',
      '    }',
      '  ],',
      '  "action_checklist": [],',
      '  "training_dataset": [',
      '    {',
      '      "title": "",',
      '      "company": "",',
      '      "location": "",',
      '      "skills_required": [],',
      '      "extracted_stack": [],',
      '      "detected_seniority": "",',
      '      "description": "",',
      '      "processed_timestamp": ""',
      '    }',
      '  ]',
      '}',
      '',
      `Perfil del candidato:\n${input.cvProfile.slice(0, 12000)}`,
      `Meta profesional:\n${input.targetRole}`,
      `Trabajos obtenidos desde API:\n${JSON.stringify(input.jobsFromApi)}`,
      `Historial de trabajos previamente guardados (si existe):\n${JSON.stringify(input.storedJobsDataset)}`,
    ].join('\n');
  }

  private buildDeterministicEmployabilityAnalysis(input: {
    targetRole: string;
    candidateSkills: string[];
    experienceProfile: ExperienceProfile;
    trainingDataset: TrainingDatasetRow[];
  }): EmployabilityAnalysisResult {
    const candidateSkills = [...new Set(input.candidateSkills.map((x) => this.normalize(x)).filter(Boolean))];
    const skillFreq = new Map<string, number>();
    const stackFreq = new Map<string, number>();

    input.trainingDataset.forEach((row) => {
      row.skills_required.forEach((skill) => {
        const n = this.normalize(skill);
        if (n) skillFreq.set(n, (skillFreq.get(n) || 0) + 1);
      });
      row.extracted_stack.forEach((tech) => {
        const n = this.normalize(tech);
        if (n) stackFreq.set(n, (stackFreq.get(n) || 0) + 1);
      });
    });

    const mostDemandedSkills = [...skillFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([x]) => x);

    const commonStacks = [...stackFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([x]) => x);

    const rankedJobs: RankedJobRow[] = input.trainingDataset
      .map((job) => {
        const derivedRequired = [
          ...job.skills_required,
          ...job.extracted_stack,
          ...this.extractSkillTokens(`${job.title} ${job.description} ${job.extracted_stack.join(' ')}`),
          ...this.extractTechStack(`${job.title} ${job.description}`),
        ];
        const required = [...new Set(derivedRequired.map((x) => this.normalize(x)).filter(Boolean))];
        const matching = required.filter((r) => candidateSkills.some((c) => c === r || c.includes(r) || r.includes(c)));
        const missing = required.filter((r) => !matching.includes(r));

        const skillRatio = required.length ? matching.length / required.length : 0;
        const blendedScore = required.length
          ? skillRatio
          : matching.length
            ? 0.45
            : 0.2;
        const score = Math.round(Math.max(0.2, Math.min(0.98, blendedScore)) * 100);
        const level: RankedJobRow['match_level'] = score >= 70 ? 'Alto' : score >= 45 ? 'Medio' : 'Bajo';
        return {
          title: job.title,
          company: job.company,
          location: job.location,
          source: job.source,
          source_url: job.source_url,
          compatibility_score: Math.max(0, Math.min(100, score)),
          match_level: level,
          matching_skills: matching.slice(0, 10),
          missing_skills: missing.slice(0, 12),
          reason:
            level === 'Alto'
              ? 'Coincidencia fuerte entre skills del candidato y requisitos del puesto.'
              : level === 'Medio'
                ? 'Coincidencia parcial; requiere cerrar brechas para competir mejor.'
                : 'Brecha amplia frente a los requisitos actuales del puesto.',
        };
      })
      .sort((a, b) => b.compatibility_score - a.compatibility_score);

    const missingFreq = new Map<string, number>();
    rankedJobs.forEach((job) => {
      job.missing_skills.forEach((skill) => missingFreq.set(skill, (missingFreq.get(skill) || 0) + 1));
    });

    const criticalMissing = [...missingFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([x]) => x);
    const secondaryMissing = [...missingFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(6, 14)
      .map(([x]) => x);

    const roadmap = criticalMissing.map((skill, idx) => ({
      priority: idx + 1,
      skill_to_learn: skill,
      required_level: idx < 3 ? 'Intermedio' : 'Basico-Intermedio',
      why_important: `Aparece de forma recurrente en vacantes del mercado peruano para ${input.targetRole}.`,
      recommended_course_type: `Curso practico orientado a ${skill} con proyectos reales y buenas practicas.`,
      mandatory_project: `Proyecto de portafolio que use ${skill} en un caso real de negocio.`,
      estimated_time_weeks: idx < 3 ? 4 : 3,
    }));

    const actionChecklist = [
      `Priorizar las 3 skills mas demandadas: ${criticalMissing.slice(0, 3).join(', ') || 'sin datos suficientes'}.`,
      'Aplicar a puestos con match Alto y Medio, adaptando CV por cada vacante.',
      'Construir al menos 2 proyectos demostrables alineados al stack objetivo.',
      'Actualizar LinkedIn/GitHub con evidencias de cada skill completada.',
    ];

    const recommendationBuckets = this.buildRecommendationBuckets(input.targetRole, rankedJobs);

    return {
      analysis_summary: `Se analizaron ${input.trainingDataset.length} empleos sin duplicados para ${input.targetRole}. Se priorizan brechas reales del mercado tecnologico peruano.`,
      market_insights: {
        most_demanded_skills: mostDemandedSkills,
        common_stacks: commonStacks,
        average_seniority_required: this.estimateAverageSeniority(input.trainingDataset, input.experienceProfile.level),
      },
      ranked_jobs: rankedJobs,
      career_gap_analysis: {
        target_role: input.targetRole,
        critical_missing_skills: criticalMissing,
        secondary_missing_skills: secondaryMissing,
      },
      career_roadmap: roadmap,
      action_checklist: actionChecklist,
      training_dataset: input.trainingDataset,
      recommendation_buckets: recommendationBuckets,
    };
  }

  private normalizeEmployabilityAnalysis(
    parsed: Partial<EmployabilityAnalysisResult>,
    fallback: EmployabilityAnalysisResult,
    trainingDataset: TrainingDatasetRow[],
  ): EmployabilityAnalysisResult {
    const ranked = Array.isArray(parsed.ranked_jobs) ? parsed.ranked_jobs : fallback.ranked_jobs;
    const dedupRanked = this.dedupeRankedJobs(ranked as RankedJobRow[]);
    const recommendationBuckets = this.buildRecommendationBuckets(
      String(parsed.career_gap_analysis?.target_role || fallback.career_gap_analysis.target_role),
      dedupRanked.length ? dedupRanked : fallback.ranked_jobs,
    );

    return {
      analysis_summary: String(parsed.analysis_summary || fallback.analysis_summary).slice(0, 1200),
      market_insights: {
        most_demanded_skills: Array.isArray(parsed.market_insights?.most_demanded_skills)
          ? parsed.market_insights!.most_demanded_skills.map((x) => String(x)).slice(0, 30)
          : fallback.market_insights.most_demanded_skills,
        common_stacks: Array.isArray(parsed.market_insights?.common_stacks)
          ? parsed.market_insights!.common_stacks.map((x) => String(x)).slice(0, 20)
          : fallback.market_insights.common_stacks,
        average_seniority_required: String(parsed.market_insights?.average_seniority_required || fallback.market_insights.average_seniority_required).slice(0, 80),
      },
      ranked_jobs: dedupRanked.length ? dedupRanked : fallback.ranked_jobs,
      career_gap_analysis: {
        target_role: String(parsed.career_gap_analysis?.target_role || fallback.career_gap_analysis.target_role).slice(0, 120),
        critical_missing_skills: Array.isArray(parsed.career_gap_analysis?.critical_missing_skills)
          ? parsed.career_gap_analysis!.critical_missing_skills.map((x) => String(x)).slice(0, 14)
          : fallback.career_gap_analysis.critical_missing_skills,
        secondary_missing_skills: Array.isArray(parsed.career_gap_analysis?.secondary_missing_skills)
          ? parsed.career_gap_analysis!.secondary_missing_skills.map((x) => String(x)).slice(0, 18)
          : fallback.career_gap_analysis.secondary_missing_skills,
      },
      career_roadmap: Array.isArray(parsed.career_roadmap)
        ? parsed.career_roadmap.slice(0, 12).map((x: any, idx) => ({
            priority: Number.isFinite(Number(x?.priority)) ? Math.max(1, Math.min(40, Math.round(Number(x.priority)))) : idx + 1,
            skill_to_learn: String(x?.skill_to_learn || '').slice(0, 120),
            required_level: String(x?.required_level || '').slice(0, 80),
            why_important: String(x?.why_important || '').slice(0, 240),
            recommended_course_type: String(x?.recommended_course_type || '').slice(0, 180),
            mandatory_project: String(x?.mandatory_project || '').slice(0, 220),
            estimated_time_weeks: Number.isFinite(Number(x?.estimated_time_weeks))
              ? Math.max(1, Math.min(52, Math.round(Number(x.estimated_time_weeks))))
              : 4,
          }))
        : fallback.career_roadmap,
      action_checklist: Array.isArray(parsed.action_checklist)
        ? parsed.action_checklist.map((x) => String(x)).slice(0, 30)
        : fallback.action_checklist,
      training_dataset: this.dedupeTrainingDataset(
        Array.isArray(parsed.training_dataset)
          ? parsed.training_dataset.map((row: any) => ({
              title: String(row?.title || '').slice(0, 160),
              company: String(row?.company || '').slice(0, 120),
              location: String(row?.location || '').slice(0, 120),
              source: String(row?.source || '').slice(0, 80),
              source_url: String(row?.source_url || '').slice(0, 500),
              skills_required: Array.isArray(row?.skills_required)
                ? row.skills_required.map((x: unknown) => String(x)).slice(0, 20)
                : [],
              extracted_stack: Array.isArray(row?.extracted_stack)
                ? row.extracted_stack.map((x: unknown) => String(x)).slice(0, 20)
                : [],
              detected_seniority: String(row?.detected_seniority || '').slice(0, 60),
              description: String(row?.description || '').slice(0, 400),
              processed_timestamp: String(row?.processed_timestamp || new Date().toISOString()),
            }))
          : trainingDataset,
      ),
      recommendation_buckets: recommendationBuckets,
    };
  }

  private buildRecommendationBuckets(targetRole: string, rankedJobs: RankedJobRow[]) {
    const normalizedTarget = this.normalize(targetRole);
    const targetTokens = normalizedTarget.split(' ').filter((x) => x && x.length >= 3);
    const ranked = this.dedupeRankedJobs(rankedJobs).slice(0, 120);

    const bestSkillMatch = ranked.filter((x) => x.match_level !== 'Bajo').slice(0, 10);
    const roleAligned = ranked
      .map((job) => {
        const titleNorm = this.normalize(job.title);
        const companyNorm = this.normalize(job.company);
        const haystack = `${titleNorm} ${companyNorm}`.trim();
        const overlap = targetTokens.length
          ? targetTokens.filter((token) => haystack.includes(token)).length / targetTokens.length
          : 0;
        const levelBonus =
          job.match_level === 'Alto' ? 10 : job.match_level === 'Medio' ? 4 : -8;
        const blendedScore = job.compatibility_score * 0.75 + overlap * 100 * 0.25 + levelBonus;
        const isPlaceholder = this.isPortalSearchPlaceholder(job.title);
        return { job, blendedScore, overlap, isPlaceholder };
      })
      .filter((row) => (normalizedTarget ? row.overlap > 0 : true))
      .filter((row) => !row.isPlaceholder)
      .sort((a, b) => b.blendedScore - a.blendedScore)
      .slice(0, 10)
      .map((row) => row.job);

    const fallbackRoleAligned = roleAligned.length
      ? roleAligned
      : ranked
          .filter((x) => !this.isPortalSearchPlaceholder(x.title))
          .filter((x) => x.match_level !== 'Bajo')
          .slice(0, 10);

    return {
      best_skill_match_jobs: bestSkillMatch.length ? bestSkillMatch : ranked.slice(0, 10),
      target_role_match_jobs: fallbackRoleAligned,
    };
  }

  private isPortalSearchPlaceholder(title: string): boolean {
    return /^buscar\s+["'`]/i.test(String(title || '').trim());
  }

  private buildProcessedJobsOutput(jobs: MatchedJob[]): ProcessedJobsOutput {
    const processed = this.dedupeJobs(jobs).map((job) => {
      const rawDescription = `${job.title} ${job.tags.join(' ')}`.trim();
      const descriptionClean = this.cleanFreeText(rawDescription);
      const normalizedTech = this.normalizeTechFromDescription(descriptionClean);
      const roleSlug = this.buildRoleSlug(job.title);
      const category = this.detectCategory(descriptionClean, normalizedTech.skills_required);
      const sectorDetected = this.detectSector(descriptionClean, normalizedTech.skills_required);
      const seniority = this.detectProcessingSeniority(rawDescription);
      const jobId = this.buildJobId(job);

      return {
        job_id: jobId,
        title: job.title,
        company: job.company,
        location: job.location,
        category,
        role_slug: roleSlug,
        seniority,
        skills_required: normalizedTech.skills_required,
        tech_stack: normalizedTech.extracted_stack,
        sector_detected: sectorDetected,
        description_clean: descriptionClean,
        embedding_text: this.cleanFreeText(
          `${job.title}. ${job.company}. ${job.location}. categoria:${category}. seniority:${seniority}. sector:${sectorDetected}. skills:${normalizedTech.skills_required.join(', ')}. stack:${normalizedTech.extracted_stack.join(', ')}.`,
        ),
      };
    });

    const rolesDetected = [...new Set(processed.map((x) => x.role_slug).filter(Boolean))];
    const categoriesDetected = [...new Set(processed.map((x) => x.category).filter(Boolean))];
    const seniorityDistribution: Record<string, number> = {};
    processed.forEach((row) => {
      seniorityDistribution[row.seniority] = (seniorityDistribution[row.seniority] || 0) + 1;
    });

    return {
      processed_jobs: processed,
      detected_market_summary: {
        roles_detected: rolesDetected,
        categories_detected: categoriesDetected,
        seniority_distribution: seniorityDistribution,
      },
    };
  }

  private toTrainingDatasetRow(job: MatchedJob): TrainingDatasetRow {
    const description = this.cleanFreeText(
      `${job.title}. ${job.company}. ${job.location}. ${job.tags.join(' ')}`.trim(),
    );
    const normalizedTech = this.normalizeTechFromDescription(description);
    return {
      title: job.title,
      company: job.company,
      location: job.location,
      source: job.source,
      source_url: job.url,
      skills_required: normalizedTech.skills_required,
      extracted_stack: normalizedTech.extracted_stack,
      detected_seniority: this.detectSeniority(description),
      description: description.slice(0, 400),
      processed_timestamp: new Date().toISOString(),
    };
  }

  private normalizeTechFromDescription(description: string): NormalizedTechOutput {
    const normalized = this.normalize(description);
    const aliases: Record<string, string[]> = {
      'Node.js': ['node.js', 'node js', 'node'],
      NestJS: ['nestjs'],
      Express: ['express'],
      TypeScript: ['typescript', 'ts'],
      JavaScript: ['javascript', 'js'],
      React: ['react'],
      Vue: ['vue'],
      Angular: ['angular'],
      Java: ['java'],
      Spring: ['spring'],
      'Spring Boot': ['spring boot'],
      Python: ['python'],
      Django: ['django'],
      FastAPI: ['fastapi'],
      PHP: ['php'],
      Laravel: ['laravel'],
      SQL: ['sql'],
      PostgreSQL: ['postgresql', 'postgres'],
      MySQL: ['mysql'],
      MongoDB: ['mongodb', 'mongo db'],
      Redis: ['redis'],
      Docker: ['docker'],
      Kubernetes: ['kubernetes', 'k8s'],
      AWS: ['aws', 'amazon web services'],
      Azure: ['azure'],
      GCP: ['gcp', 'google cloud'],
      GraphQL: ['graphql'],
      REST: ['rest', 'restful', 'api rest'],
      Linux: ['linux'],
      Git: ['git'],
      HTML: ['html'],
      CSS: ['css'],
      'Power BI': ['power bi', 'powerbi'],
      Excel: ['excel'],
      ETL: ['etl'],
    };

    const detected = new Set<string>();
    const rawPhrases: string[] = [];
    for (const [canonical, terms] of Object.entries(aliases)) {
      for (const term of terms) {
        const t = this.normalize(term);
        if (!t) continue;
        const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`(^|\\s)${escaped}(\\s|$)`);
        if (pattern.test(normalized)) {
          detected.add(canonical);
          rawPhrases.push(term);
          break;
        }
      }
    }

    const skillsRequired = [...detected];
    const structuralSet = new Set([
      'Node.js', 'NestJS', 'Express', 'React', 'Vue', 'Angular', 'Spring', 'Spring Boot',
      'Django', 'FastAPI', 'Laravel', 'PostgreSQL', 'MySQL', 'MongoDB', 'Redis',
      'Docker', 'Kubernetes', 'AWS', 'Azure', 'GCP',
    ]);
    let extractedStack = skillsRequired.filter((x) => structuralSet.has(x));

    if (!skillsRequired.length) {
      extractedStack = [];
    } else if (
      extractedStack.length === skillsRequired.length &&
      extractedStack.every((x, idx) => x === skillsRequired[idx])
    ) {
      extractedStack = extractedStack.filter((x) => !['REST', 'SQL', 'Git', 'Linux'].includes(x));
    }

    return {
      skills_required: skillsRequired,
      extracted_stack: extractedStack,
      raw_detected_phrases: [...new Set(rawPhrases)],
    };
  }

  private extractSkillTokens(text: string): string[] {
    const normalized = this.normalize(text);
    const lexicon = [
      'node', 'node.js', 'nestjs', 'express', 'typescript', 'javascript', 'react', 'vue', 'angular',
      'java', 'spring', 'spring boot', 'python', 'django', 'fastapi', 'php', 'laravel',
      'sql', 'postgresql', 'mysql', 'mongodb', 'redis', 'docker', 'kubernetes', 'aws', 'azure', 'gcp',
      'graphql', 'rest', 'microservicios', 'testing', 'jest', 'cypress', 'linux', 'git', 'html', 'css',
      'power bi', 'excel', 'etl', 'kotlin', 'swift', 'figma', 'tailwind', 'next.js', 'nextjs', 'firebase',
    ];
    return lexicon.filter((x) => normalized.includes(this.normalize(x))).slice(0, 20);
  }

  private extractTechStack(text: string): string[] {
    const normalized = this.normalize(text);
    const stackLexicon = [
      'node.js', 'node', 'nestjs', 'express', 'react', 'vue', 'angular', 'typescript', 'javascript',
      'java', 'spring boot', 'spring', 'python', 'django', 'fastapi', 'php', 'laravel',
      'postgresql', 'mysql', 'mongodb', 'redis', 'docker', 'kubernetes', 'aws', 'azure', 'gcp',
      'graphql', 'rest', 'linux', 'git', 'power bi', 'etl',
    ];
    return stackLexicon.filter((x) => normalized.includes(this.normalize(x))).slice(0, 20);
  }

  private detectCategory(description: string, skills: string[]): string {
    const text = this.normalize(description);
    const skillText = this.normalize(skills.join(' '));
    const joined = `${text} ${skillText}`.trim();
    if (/\b(data|analyst|analytics|bi|machine learning|ml|scientist|etl|power bi)\b/.test(joined)) return 'data';
    if (/\b(devops|sre|cloud|infraestructura|kubernetes|docker|terraform|ci cd)\b/.test(joined)) return 'devops';
    if (/\b(iot|internet of things|embedded|firmware|arduino|sensores)\b/.test(joined)) return 'iot';
    if (/\b(agro|agricola|riego|cultivo|ganadero)\b/.test(joined)) return 'agro';
    if (/\b(industrial|mantenimiento|planta|produccion|automatizacion industrial)\b/.test(joined)) return 'industrial';
    if (/\b(software|developer|desarrollador|frontend|backend|full stack|qa|tester)\b/.test(joined)) return 'software';
    return 'otro';
  }

  private detectSector(description: string, skills: string[]): string {
    const text = this.normalize(description);
    const skillText = this.normalize(skills.join(' '));
    const joined = `${text} ${skillText}`.trim();
    if (/\b(agro|agricola|riego|cultivo|agroindustria)\b/.test(joined)) return 'agro';
    if (/\b(industrial|planta|manufactura|produccion|mineria|mantenimiento)\b/.test(joined)) return 'industrial';
    if (/\b(devops|sre|cloud|docker|kubernetes)\b/.test(joined)) return 'devops';
    if (/\b(data|analytics|machine learning|bi|scientist|etl)\b/.test(joined)) return 'data';
    if (/\b(iot|internet of things|embedded|firmware|arduino|sensores)\b/.test(joined)) return 'iot';
    if (/\b(software|tecnologia|it|developer|backend|frontend)\b/.test(joined)) return 'software';
    return 'otro';
  }

  private detectProcessingSeniority(description: string): string {
    const text = this.normalize(description);
    if (/\b(senior|lead|principal|arquitecto|manager|jefe)\b/.test(text)) return 'senior';
    if (/\b(semi senior|semisenior|ssr|intermedio|mid)\b/.test(text)) return 'semi-senior';
    if (/\b(junior|trainee|intern|practicante|entry)\b/.test(text)) return 'junior';
    return 'no_especificado';
  }

  private buildRoleSlug(title: string): string {
    const n = this.normalize(title)
      .replace(/[^\w\s-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .filter((x) => x && x.length > 1)
      .slice(0, 5)
      .join('_');
    return n || 'rol_no_definido';
  }

  private buildJobId(job: MatchedJob): string {
    const base = `${this.normalize(job.title)}|${this.normalize(job.company)}|${this.normalize(job.location)}|${this.normalize(job.url)}`;
    let hash = 0;
    for (let i = 0; i < base.length; i += 1) {
      hash = (hash * 31 + base.charCodeAt(i)) >>> 0;
    }
    return `job_${hash.toString(16)}`;
  }

  private cleanFreeText(text: string): string {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .replace(/[^\w\s.,:;()/#+-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1200);
  }

  private detectSeniority(text: string): string {
    const normalized = this.normalize(text);
    if (/\b(senior|lead|principal|arquitecto|manager)\b/.test(normalized)) return 'senior';
    if (/\b(mid|semi senior|ssr|intermedio)\b/.test(normalized)) return 'mid';
    if (/\b(junior|entry|trainee|practicante|intern)\b/.test(normalized)) return 'junior';
    return 'no_especificado';
  }

  private estimateAverageSeniority(dataset: TrainingDatasetRow[], levelHint: ExperienceProfile['level']): string {
    const scoreByLabel: Record<string, number> = { junior: 1, mid: 2, senior: 3, no_especificado: 0 };
    const labels = dataset.map((x) => x.detected_seniority || 'no_especificado');
    const avg = labels.length
      ? labels.reduce((acc, l) => acc + (scoreByLabel[l] || 0), 0) / labels.length
      : scoreByLabel[levelHint] || 1;
    if (avg >= 2.3) return 'Senior predominante';
    if (avg >= 1.4) return 'Mid predominante';
    return 'Junior predominante';
  }

  private dedupeJobs(jobs: MatchedJob[]): MatchedJob[] {
    const map = new Map<string, MatchedJob>();
    jobs.forEach((job) => {
      const key = [
        this.normalize(job.url || ''),
        this.normalize(job.title || ''),
        this.normalize(job.company || ''),
      ].join('|');
      if (!map.has(key)) map.set(key, job);
    });
    return [...map.values()];
  }

  private dedupeRankedJobs(rows: RankedJobRow[]): RankedJobRow[] {
    const map = new Map<string, RankedJobRow>();
    rows.forEach((row) => {
      const key = `${this.normalize(row.title)}|${this.normalize(row.company)}`;
      if (!map.has(key)) map.set(key, row);
    });
    return [...map.values()].sort((a, b) => b.compatibility_score - a.compatibility_score);
  }

  private dedupeTrainingDataset(rows: TrainingDatasetRow[]): TrainingDatasetRow[] {
    const map = new Map<string, TrainingDatasetRow>();
    rows.forEach((row) => {
      const key = `${this.normalize(row.title)}|${this.normalize(row.company)}|${this.normalize(row.location)}`;
      if (!map.has(key)) map.set(key, row);
    });
    return [...map.values()];
  }

  private async readStoredJobsDataset(): Promise<TrainingDatasetRow[]> {
    try {
      const raw = await fs.readFile(this.datasetFilePath, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed?.rows) ? parsed.rows : [];
    } catch {
      return [];
    }
  }

  private async mergeAndPersistTrainingDataset(rows: TrainingDatasetRow[]): Promise<void> {
    const existing = await this.readStoredJobsDataset();
    const merged = this.dedupeTrainingDataset([...existing, ...rows]).slice(-5000);
    await fs.mkdir(path.dirname(this.datasetFilePath), { recursive: true });
    await fs.writeFile(
      this.datasetFilePath,
      JSON.stringify({ rows: merged, updatedAt: new Date().toISOString() }, null, 2),
      'utf8',
    );
  }

  private parseJsonObject(raw: string): any {
    const text = String(raw || '').trim();
    if (!text) throw new Error('empty_json');
    try {
      return JSON.parse(text);
    } catch {
      // continue
    }

    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
      return JSON.parse(fenced[1].trim());
    }

    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1));
    }

    throw new Error('json_not_found');
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

  private async extractInsightsWithFallback(cvText: string, desiredRole?: string): Promise<CvInsights> {
    try {
      return await this.geminiService.extractCvInsights(cvText, desiredRole);
    } catch {
      const base = `${desiredRole || ''} ${cvText}`
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, ' ')
        .replace(/[^a-z0-9+#.\s-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      const stopwords = new Set([
        'de',
        'la',
        'el',
        'en',
        'con',
        'para',
        'por',
        'del',
        'las',
        'los',
        'una',
        'uno',
        'and',
        'the',
        'for',
        'with',
      ]);

      const words = (base.match(/[a-z0-9+#.]{3,}/g) || []).filter((w) => !stopwords.has(w));
      const keywords = [...new Set(words)].slice(0, 20);
      return {
        keywords,
        roles: desiredRole ? [desiredRole.toLowerCase()] : keywords.slice(0, 4),
        yearsExperience: 0,
        level: 'junior',
        prefersInternships: true,
        englishLevel: 'unknown',
        preferredJobTypes: ['practica', 'intern', 'junior'],
      };
    }
  }

  private sanitizeKeywords(list: string[], trainedVocabulary: string[] = []): string[] {
    const noise = new Set([
      'proyecto', 'titulo', 'descripcion', 'descripci', 'intermedio', 'desarrollado', 'estudiante', 'ciclo',
      'profesional', 'professional', 'buenas', 'practicas', 'maquetacion', 'interfaces', 'responsive', 'design',
    ]);
    const trainedSet = new Set(trainedVocabulary.map((x) => this.normalize(x)).filter(Boolean));

    const cleaned = list
      .map((x) => this.normalize(String(x)))
      .filter((x) => x && x.length >= 3 && !noise.has(x))
      .filter((x) => {
        if (trainedSet.has(x)) return true;
        const hasTechShape = /[+#.]|sql|api|aws|azure|react|angular|vue|node|python|java|docker|kubernetes|git|html|css|excel|power bi/.test(x);
        return hasTechShape;
      });

    const uniq = [...new Set(cleaned)];
    return uniq.length ? uniq.slice(0, 14) : [];
  }

  private extractSkillsByVocabulary(text: string, vocabulary: string[]): string[] {
    const normalizedText = this.normalize(text);
    const out: string[] = [];
    for (const raw of vocabulary) {
      const skill = this.normalize(raw);
      if (!skill || skill.length < 2) continue;
      if (normalizedText.includes(skill)) out.push(skill);
    }
    return [...new Set(out)].slice(0, 30);
  }

  private async getTrainedSkillVocabulary(): Promise<string[]> {
    const now = Date.now();
    if (this.trainedSkillVocabularyCache && now - this.trainedSkillVocabularyCache.loadedAt < 10 * 60 * 1000) {
      return this.trainedSkillVocabularyCache.values;
    }

    const dir = path.join(process.cwd(), 'data');
    let files: string[] = [];
    try {
      files = await fs.readdir(dir);
    } catch {
      return [];
    }

    const trainingFiles = files.filter((name) => /^puestos_peru_training.*\.json$/i.test(name));
    const values = new Set<string>();

    for (const file of trainingFiles) {
      try {
        const raw = await fs.readFile(path.join(dir, file), 'utf8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) continue;
        for (const row of parsed as Array<Record<string, unknown>>) {
          const required = Array.isArray(row.required_skills) ? row.required_skills : [];
          const optional = Array.isArray(row.nice_to_have) ? row.nice_to_have : [];
          for (const skill of [...required, ...optional]) {
            const normalized = this.normalize(String(skill || ''));
            if (normalized && normalized.length >= 2) values.add(normalized);
          }
        }
      } catch {
        // ignore malformed training file
      }
    }

    const result = [...values];
    this.trainedSkillVocabularyCache = { loadedAt: now, values: result };
    return result;
  }

  private async getTrainedRoleProfiles(): Promise<Array<{ role: string; requiredSkills: string[]; optionalSkills: string[] }>> {
    const now = Date.now();
    if (this.trainedRoleProfilesCache && now - this.trainedRoleProfilesCache.loadedAt < 10 * 60 * 1000) {
      return this.trainedRoleProfilesCache.values;
    }

    const dir = path.join(process.cwd(), 'data');
    let files: string[] = [];
    try {
      files = await fs.readdir(dir);
    } catch {
      return [];
    }

    const trainingFiles = files.filter((name) => /^puestos_peru_training.*\.json$/i.test(name));
    const out: Array<{ role: string; requiredSkills: string[]; optionalSkills: string[] }> = [];

    for (const file of trainingFiles) {
      try {
        const raw = await fs.readFile(path.join(dir, file), 'utf8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) continue;
        for (const row of parsed as Array<Record<string, unknown>>) {
          const role = String(row.role || '').trim();
          if (!role) continue;
          const requiredSkills = Array.isArray(row.required_skills)
            ? row.required_skills.map((x) => this.normalize(String(x))).filter(Boolean)
            : [];
          const optionalSkills = Array.isArray(row.nice_to_have)
            ? row.nice_to_have.map((x) => this.normalize(String(x))).filter(Boolean)
            : [];
          out.push({
            role,
            requiredSkills: [...new Set(requiredSkills)],
            optionalSkills: [...new Set(optionalSkills)],
          });
        }
      } catch {
        // ignore malformed files
      }
    }

    this.trainedRoleProfilesCache = { loadedAt: now, values: out };
    return out;
  }

  private async computeSkillsBestFit(candidateSkills: string[], rankedJobs: RankedJobRow[]) {
    const rankedProfile = await this.findBestFitRoleBySkills(candidateSkills);

    if (!rankedProfile || rankedProfile.match <= 0) return null;

    const sortedJobs = this.sortJobsForBestFitRole(rankedJobs || [], rankedProfile.role);
    const topJob = sortedJobs[0];

    return {
      role: rankedProfile.role,
      role_match_percent: Math.max(0, Math.min(100, Math.round(rankedProfile.match))),
      top_job_title: String(topJob?.title || ''),
      top_job_score: Number(topJob?.compatibility_score || 0),
    };
  }

  private async findBestFitRoleBySkills(candidateSkills: string[]): Promise<{ role: string; match: number } | null> {
    const profiles = await this.getTrainedRoleProfiles();
    if (!profiles.length) return null;

    const cv = [...new Set((candidateSkills || []).map((x) => this.normalize(x)).filter(Boolean))];
    if (!cv.length) return null;

    const rankedProfile = profiles
      .map((p) => {
        const requiredHits = p.requiredSkills.filter((s) => cv.some((c) => c === s || c.includes(s) || s.includes(c))).length;
        const optionalHits = p.optionalSkills.filter((s) => cv.some((c) => c === s || c.includes(s) || s.includes(c))).length;
        const weightedTotal = p.requiredSkills.length + p.optionalSkills.length * 0.5;
        const weightedHits = requiredHits + optionalHits * 0.5;
        const match = weightedTotal > 0 ? (weightedHits / weightedTotal) * 100 : 0;
        return { role: p.role, match };
      })
      .sort((a, b) => b.match - a.match)[0];

    if (!rankedProfile || rankedProfile.match <= 0) return null;
    return rankedProfile;
  }

  private sortJobsForBestFitRole(jobs: RankedJobRow[], role: string): RankedJobRow[] {
    const roleTokens = this.normalize(role).split(' ').filter((x) => x && x.length >= 3);
    return [...(jobs || [])]
      .map((job) => {
        const haystack = this.normalize(`${job.title} ${job.company} ${job.reason || ''}`);
        const overlap = roleTokens.length
          ? roleTokens.filter((token) => haystack.includes(token)).length / roleTokens.length
          : 0;
        const blended = Number(job.compatibility_score || 0) * 0.8 + overlap * 100 * 0.2;
        return { job, blended };
      })
      .sort((a, b) => b.blended - a.blended)
      .map((x) => x.job);
  }

  private inferExperienceProfile(cvText: string, desiredRole?: string, insights?: CvInsights): ExperienceProfile {
    const normalized = `${desiredRole || ''} ${cvText}`
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');

    const yearsMatches = [
      ...normalized.matchAll(/(\d{1,2})\s*(?:\+)?\s*(?:anos|ano|years|year)/g),
    ].map((m) => Number(m[1]));
    const heuristicYears = yearsMatches.length ? Math.max(...yearsMatches.filter((n) => !Number.isNaN(n))) : 0;
    const maxYears = Math.max(heuristicYears, insights?.yearsExperience || 0);

    const entrySignals = ['practicante', 'practica', 'intern', 'trainee', 'sin experiencia', 'estudiante'];
    const seniorSignals = ['senior', 'lead', 'lider', 'manager', 'jefe', 'principal', 'arquitecto'];

    const entryHits = entrySignals.filter((x) => normalized.includes(x)).length;
    const seniorHits = seniorSignals.filter((x) => normalized.includes(x)).length;

    let level: ExperienceProfile['level'] = (insights?.level as ExperienceProfile['level']) || 'mid';
    if (maxYears <= 1 || entryHits >= 2) level = 'intern';
    else if (maxYears <= 3 || entryHits > 0) level = 'junior';
    else if (maxYears >= 6 || seniorHits >= 2) level = 'senior';

    const prefersInternships =
      typeof insights?.prefersInternships === 'boolean'
        ? insights.prefersInternships
        : level === 'intern' || (level === 'junior' && maxYears <= 1);
    const seniorityTerms =
      insights?.preferredJobTypes?.length
        ? [...new Set([...insights.preferredJobTypes, ...(insights.roles || [])])].slice(0, 6)
        : level === 'intern'
          ? ['practicante', 'intern', 'trainee', 'junior']
          : level === 'junior'
            ? ['junior', 'entry level', 'asistente', 'analista junior']
            : level === 'senior'
              ? ['senior', 'lead', 'manager', 'principal']
              : ['analista', 'associate', 'mid level'];

    return {
      years: maxYears,
      level,
      prefersInternships,
      seniorityTerms,
    };
  }
}
