import { IsIn, IsNotEmpty, IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';

export class GenerateApplicationDto {
  @IsString()
  @IsNotEmpty()
  @IsUrl({ require_tld: false })
  jobUrl!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  userId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  fullName!: string;

  @IsString()
  @IsOptional()
  @MaxLength(1200)
  profileSummary?: string;

  @IsString()
  @IsOptional()
  @MaxLength(8000)
  oldCvText?: string;

  @IsString()
  @IsOptional()
  @MaxLength(1200)
  education?: string;

  @IsString()
  @IsOptional()
  @MaxLength(1200)
  skills?: string;

  @IsString()
  @IsIn(['free', 'premium'])
  plan!: 'free' | 'premium';
}
