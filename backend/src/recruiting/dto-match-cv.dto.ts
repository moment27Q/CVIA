import { IsOptional, IsString, MaxLength } from 'class-validator';

export class MatchCvDto {
  @IsString()
  @MaxLength(20000)
  cvText!: string;

  @IsString()
  @MaxLength(12000)
  jobDescription!: string;

  @IsString()
  @IsOptional()
  @MaxLength(180)
  jobTitle?: string;

  @IsString()
  @IsOptional()
  @MaxLength(120)
  location?: string;

  @IsString()
  @IsOptional()
  @MaxLength(80)
  country?: string;

  @IsString()
  @IsOptional()
  @MaxLength(120)
  candidateId?: string;
}
