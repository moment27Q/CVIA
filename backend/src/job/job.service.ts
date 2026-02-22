import { BadRequestException, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ExportPdfDto } from './dto-export-pdf.dto';
import { GenerateApplicationDto } from './dto-generate-application.dto';
import { MatchCvJobsDto } from './dto-match-cv-jobs.dto';
import { GeminiService } from '../common/services/gemini.service';
import { PdfService } from '../common/services/pdf.service';
import { ScraperService } from '../common/services/scraper.service';
import { UsageService } from '../common/services/usage.service';
import { JobSearchService } from '../common/services/job-search.service';
import { CvParserService } from '../common/services/cv-parser.service';

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

    const rawKeywords = await this.geminiService.extractCvKeywords(cvText, dto.desiredRole);
    const keywords = this.sanitizeKeywords(rawKeywords);
    const jobs = await this.jobSearchService.searchPublicJobs(keywords, dto.location);

    return {
      extractedKeywords: keywords,
      totalJobsFound: jobs.length,
      jobs,
      note: 'Lista amplia en Peru, ordenada del mas reciente al mas antiguo, con enlaces directos por portal/palabra clave.',
    };
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
}
