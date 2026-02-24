import { Module } from '@nestjs/common';
import { CvParserService } from '../common/services/cv-parser.service';
import { GeminiService } from '../common/services/gemini.service';
import { RecruitingRagService } from '../common/services/recruiting-rag.service';
import { LearningResourcesController } from './learning-resources.controller';
import { RecruitingController } from './recruiting.controller';
import { RecruitingService } from './recruiting.service';

@Module({
  controllers: [RecruitingController, LearningResourcesController],
  providers: [RecruitingService, GeminiService, RecruitingRagService, CvParserService],
})
export class RecruitingModule {}
