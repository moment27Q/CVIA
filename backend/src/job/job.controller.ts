import {
  Body,
  Controller,
  HttpCode,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ExportPdfDto } from './dto-export-pdf.dto';
import { GenerateApplicationDto } from './dto-generate-application.dto';
import { MatchCvJobsDto } from './dto-match-cv-jobs.dto';
import { JobService } from './job.service';

@Controller('api/job')
export class JobController {
  constructor(private readonly jobService: JobService) {}

  @Post('generate')
  async generate(@Body() dto: GenerateApplicationDto) {
    return this.jobService.generateApplication(dto);
  }

  @Post('export-pdf')
  async exportPdf(@Body() dto: ExportPdfDto) {
    return this.jobService.exportPremiumPdf(dto);
  }

  @Post('match-cv-jobs')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('cvFile'))
  async matchCvJobs(@UploadedFile() cvFile: any, @Body() dto: MatchCvJobsDto) {
    return this.jobService.matchJobsByCv(dto, cvFile);
  }
}
