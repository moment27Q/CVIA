import { Module } from '@nestjs/common';
import { JobModule } from './job/job.module';
import { RecruitingModule } from './recruiting/recruiting.module';

@Module({
  imports: [JobModule, RecruitingModule],
})
export class AppModule {}
