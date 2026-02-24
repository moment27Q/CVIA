import { BadRequestException, Body, Controller, HttpCode, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import pdfParse from 'pdf-parse';
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
  @UseInterceptors(FileInterceptor('file'))
  async careerPathFromCv(@UploadedFile() file: Express.Multer.File, @Body() dto: GenerateCareerPathFromCvDto) {
    let cvText = String(dto.cvText || '');

    if (file) {
      try {
        const data = await pdfParse(file.buffer);
        cvText = String(data?.text || '').trim();
        console.log('PDF text length:', cvText.length);
        console.log('PDF preview (first 200 chars):', cvText.substring(0, 200));
        if (cvText.length < 100) {
          throw new BadRequestException('CV text is empty or not processed correctly');
        }
      } catch (error) {
        if (error instanceof BadRequestException) {
          throw error;
        }
        throw new BadRequestException('CV text is empty or not processed correctly');
      }
    } else {
      cvText = cvText.trim();
      console.log('CV text length:', cvText.length);
      console.log('CV preview:', cvText.substring(0, 200));
      if (!cvText || cvText.length < 50) {
        throw new BadRequestException('CV text is empty or not processed correctly');
      }
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
}
