import { IsOptional, IsString, MaxLength } from 'class-validator';

export class MatchCvJobsDto {
  @IsString()
  @IsOptional()
  @MaxLength(12000)
  cvText?: string;

  @IsString()
  @IsOptional()
  @MaxLength(120)
  desiredRole?: string;

  @IsString()
  @IsOptional()
  @MaxLength(120)
  location?: string;
}
