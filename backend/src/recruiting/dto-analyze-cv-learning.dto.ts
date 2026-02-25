import { IsOptional, IsString, MaxLength } from 'class-validator';

export class AnalyzeCvLearningDto {
  @IsString()
  @MaxLength(20000)
  cvText!: string;

  @IsString()
  @IsOptional()
  @MaxLength(120)
  userId?: string;
}
