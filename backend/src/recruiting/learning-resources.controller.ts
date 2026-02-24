import { Body, Controller, Post } from '@nestjs/common';
import { GetLearningResourcesDto } from './dto-get-learning-resources.dto';
import { RecruitingService } from './recruiting.service';

@Controller('api')
export class LearningResourcesController {
  constructor(private readonly recruitingService: RecruitingService) {}

  @Post('get-learning-resources')
  async getLearningResources(@Body() dto: GetLearningResourcesDto) {
    return this.recruitingService.getLearningResources(dto);
  }
}
