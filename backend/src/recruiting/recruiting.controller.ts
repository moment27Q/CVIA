import { Body, Controller, HttpCode, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { FeedbackDto } from './dto-feedback.dto';
import { GetLearningResourcesDto } from './dto-get-learning-resources.dto';
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

  @Post('career-path')
  async careerPath(@Body() dto: GenerateCareerPathDto) {
    return this.recruitingService.generateCareerPath(dto);
  }

  @Post('career-path-from-cv')
  @UseInterceptors(FileInterceptor('cvFile'))
  async careerPathFromCv(@UploadedFile() cvFile: any, @Body() dto: GenerateCareerPathFromCvDto) {
    return this.recruitingService.generateCareerPathFromCv(dto, cvFile);
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
}
