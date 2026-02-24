import { Module } from '@nestjs/common';
import { GeminiService } from '../common/services/gemini.service';
import { RecruitingRagService } from '../common/services/recruiting-rag.service';
import { RecruitingController } from './recruiting.controller';
import { RecruitingService } from './recruiting.service';

@Module({
  controllers: [RecruitingController],
  providers: [RecruitingService, GeminiService, RecruitingRagService],
})
export class RecruitingModule {}
