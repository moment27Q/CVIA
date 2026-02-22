import { Module } from '@nestjs/common';
import { JobController } from './job.controller';
import { JobService } from './job.service';
import { GeminiService } from '../common/services/gemini.service';
import { ScraperService } from '../common/services/scraper.service';
import { UsageService } from '../common/services/usage.service';
import { PdfService } from '../common/services/pdf.service';
import { JobSearchService } from '../common/services/job-search.service';
import { CvParserService } from '../common/services/cv-parser.service';

@Module({
  controllers: [JobController],
  providers: [
    JobService,
    GeminiService,
    ScraperService,
    UsageService,
    PdfService,
    JobSearchService,
    CvParserService,
  ],
})
export class JobModule {}
