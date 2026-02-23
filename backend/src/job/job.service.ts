import { BadRequestException, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ExportPdfDto } from './dto-export-pdf.dto';
import { GenerateApplicationDto } from './dto-generate-application.dto';
import { MatchCvJobsDto } from './dto-match-cv-jobs.dto';
import { CvInsights, GeminiService } from '../common/services/gemini.service';
import { PdfService } from '../common/services/pdf.service';
import { ScraperService } from '../common/services/scraper.service';
import { UsageService } from '../common/services/usage.service';
import { ExperienceProfile, JobSearchService } from '../common/services/job-search.service';
import { CvParserService } from '../common/services/cv-parser.service';
import { SearchMemoryService } from '../common/services/search-memory.service';

const FREE_LIMIT = 3;
const PREMIUM_PRICE = 15;

@Injectable()
export class JobService {
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
    await this.searchMemoryService.learnFromResults(country, experienceProfile.level, keywords, search.jobs);
    const region = dto.country?.trim() || dto.location?.trim() || 'tu pais';

    return {
      extractedKeywords: keywords,
      extractedRoles: insights.roles || [],
      englishLevel: insights.englishLevel,
      preferredJobTypes: insights.preferredJobTypes || [],
      experienceProfile,
      totalJobsFound: search.jobs.length,
      jobs: search.jobs,
      providerStatus: search.providers,
      note: `Lista en ${region}, ordenada de mas reciente a mas antigua, con enlaces directos por portal/palabra clave.`,
    };
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
