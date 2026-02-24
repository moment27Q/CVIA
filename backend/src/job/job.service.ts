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
import { ExperienceProfile, JobSearchService, MatchedJob } from '../common/services/job-search.service';
import { CvParserService } from '../common/services/cv-parser.service';
import { SearchMemoryService } from '../common/services/search-memory.service';

const FREE_LIMIT = 3;
const PREMIUM_PRICE = 15;

export interface TrainingDatasetRow {
  title: string;
  company: string;
  location: string;
  skills_required: string[];
  extracted_stack: string[];
  detected_seniority: string;
  description: string;
  processed_timestamp: string;
}

export interface RankedJobRow {
  title: string;
  company: string;
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
}

@Injectable()
export class JobService {
  private readonly datasetFilePath = path.join(process.cwd(), 'data', 'stored-jobs-dataset.json');

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

    const insights = await this.extractInsightsWithFallback(cvText, dto.desiredRole);
    const keywords = this.sanitizeKeywords(insights.keywords);
    const desiredRole = dto.desiredRole?.trim() || insights.roles[0] || '';
    const experienceProfile = this.inferExperienceProfile(cvText, desiredRole, insights);
    const country = dto.country?.trim() || dto.location?.trim() || 'Peru';
    const learningProfile = await this.searchMemoryService.getProfile(country, experienceProfile.level);
    const search = await this.jobSearchService.searchPublicJobs(
      keywords,
      dto.location,
      dto.country,
      desiredRole,
      experienceProfile,
      learningProfile,
    );
    const uniqueJobs = this.dedupeJobs(search.jobs);
    await this.searchMemoryService.learnFromResults(country, experienceProfile.level, keywords, uniqueJobs);
    const storedJobsDataset = await this.readStoredJobsDataset();
    const analysis = await this.buildEmployabilityAnalysis({
      cvProfile: cvText,
      targetRole: desiredRole || insights.roles[0] || 'Sin meta definida',
      jobsFromApi: uniqueJobs,
      storedJobsDataset,
      candidateSkills: keywords,
      experienceProfile,
    });
    await this.mergeAndPersistTrainingDataset(analysis.training_dataset);

    const region = dto.country?.trim() || dto.location?.trim() || 'tu pais';

    return {
      extractedKeywords: keywords,
      extractedRoles: insights.roles || [],
      englishLevel: insights.englishLevel,
      preferredJobTypes: insights.preferredJobTypes || [],
      experienceProfile,
      totalJobsFound: uniqueJobs.length,
      jobs: uniqueJobs,
      providerStatus: search.providers,
      note: `Lista en ${region}, ordenada de mas reciente a mas antigua, con enlaces directos por portal/palabra clave.`,
      employabilityAnalysis: analysis,
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
        const required = [...new Set(job.skills_required.map((x) => this.normalize(x)).filter(Boolean))];
        const matching = required.filter((r) => candidateSkills.some((c) => c === r || c.includes(r) || r.includes(c)));
        const missing = required.filter((r) => !matching.includes(r));
        const score = required.length ? Math.round((matching.length / required.length) * 100) : 35;
        const level: RankedJobRow['match_level'] = score >= 70 ? 'Alto' : score >= 45 ? 'Medio' : 'Bajo';
        return {
          title: job.title,
          company: job.company,
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
    };
  }

  private normalizeEmployabilityAnalysis(
    parsed: Partial<EmployabilityAnalysisResult>,
    fallback: EmployabilityAnalysisResult,
    trainingDataset: TrainingDatasetRow[],
  ): EmployabilityAnalysisResult {
    const ranked = Array.isArray(parsed.ranked_jobs) ? parsed.ranked_jobs : fallback.ranked_jobs;
    const dedupRanked = this.dedupeRankedJobs(ranked as RankedJobRow[]);

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
    };
  }

  private toTrainingDatasetRow(job: MatchedJob): TrainingDatasetRow {
    const description = `${job.title} ${job.tags.join(' ')}`.trim();
    const skills = this.extractSkillTokens(description);
    return {
      title: job.title,
      company: job.company,
      location: job.location,
      skills_required: skills,
      extracted_stack: skills,
      detected_seniority: this.detectSeniority(`${job.title} ${description}`),
      description: description.slice(0, 400),
      processed_timestamp: new Date().toISOString(),
    };
  }

  private extractSkillTokens(text: string): string[] {
    const normalized = this.normalize(text);
    const lexicon = [
      'node', 'node.js', 'nestjs', 'express', 'typescript', 'javascript', 'react', 'vue', 'angular',
      'java', 'spring', 'spring boot', 'python', 'django', 'fastapi', 'php', 'laravel',
      'sql', 'postgresql', 'mysql', 'mongodb', 'redis', 'docker', 'kubernetes', 'aws', 'azure', 'gcp',
      'graphql', 'rest', 'microservicios', 'testing', 'jest', 'cypress', 'linux', 'git', 'html', 'css',
      'power bi', 'excel', 'etl',
    ];
    return lexicon.filter((x) => normalized.includes(this.normalize(x))).slice(0, 20);
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

  private sanitizeKeywords(list: string[]): string[] {
    const noise = new Set(['proyecto', 'titulo', 'descripcion', 'descripci', 'intermedio', 'desarrollado', 'estudiante', 'ciclo']);
    const cleaned = list
      .map((x) =>
        String(x)
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-z0-9+#.\s-]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim(),
      )
      .filter((x) => x && x.length >= 3 && !noise.has(x));

    const uniq = [...new Set(cleaned)];
    return uniq.length ? uniq.slice(0, 14) : ['practicante', 'analista', 'asistente'];
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
