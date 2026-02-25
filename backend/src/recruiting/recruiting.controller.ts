import { Body, Controller, Get, HttpCode, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import pdfParse from 'pdf-parse';
import { AcceptSuggestedRoleDto } from './dto-accept-suggested-role.dto';
import { FeedbackDto } from './dto-feedback.dto';
import { GetLearningResourcesDto } from './dto-get-learning-resources.dto';
import { AnalyzeCvLearningDto } from './dto-analyze-cv-learning.dto';
import { GenerateCareerPathDto } from './dto-generate-career-path.dto';
import { GenerateCareerPathFromCvDto } from './dto-generate-career-path-from-cv.dto';
import { MatchCvDto } from './dto-match-cv.dto';
import { RecruitingService } from './recruiting.service';

@Controller('api/recruiting')
export class RecruitingController {
  constructor(private readonly recruitingService: RecruitingService) {}

  @Post('match')
  async matchCv(@Body() dto: MatchCvDto) {
    return this.recruitingService.matchCv(dto);
  }

  @Post('match-learning')
  async matchCvLearning(@Body() dto: AnalyzeCvLearningDto) {
    return this.recruitingService.analyzeCvLearning(dto);
  }

  @Post('career-path')
  async careerPath(@Body() dto: GenerateCareerPathDto) {
    return this.recruitingService.generateCareerPath(dto);
  }

  @Post('career-path-from-cv')
  @UseInterceptors(FileInterceptor('file'))
  async careerPathFromCv(@UploadedFile() file: Express.Multer.File, @Body() dto: GenerateCareerPathFromCvDto) {
    let cvText = String(dto.cvText || '');

    if (file) {
      try {
        const data = await pdfParse(file.buffer);
        cvText = String(data?.text || '').trim();
        console.log('PDF text length:', cvText.length);
        console.log('PDF preview (first 200 chars):', cvText.substring(0, 200));
      } catch (error) {
        console.warn('Failed to parse PDF CV, using fallback', error);
        cvText = '';
      }
    } else {
      cvText = cvText.trim();
      console.log('CV text length:', cvText.length);
      console.log('CV preview:', cvText.substring(0, 200));
    }

    return this.recruitingService.generateCareerPathFromCv({ ...dto, cvText });
  }

  @Post('feedback')
  @HttpCode(200)
  async feedback(@Body() dto: FeedbackDto) {
    return this.recruitingService.registerFeedback(dto);
  }

  @Post('get-learning-resources')
  async getLearningResources(@Body() dto: GetLearningResourcesDto) {
    return this.recruitingService.getLearningResources(dto);
  }

  @Get('learning-stats')
  async getLearningStats() {
    return this.recruitingService.getLearningStats();
  }

  @Post('accept-suggested-role')
  @HttpCode(200)
  async acceptSuggestedRole(@Body() dto: AcceptSuggestedRoleDto) {
    return this.recruitingService.acceptSuggestedRole(Number(dto.analysisId));
  }
}
