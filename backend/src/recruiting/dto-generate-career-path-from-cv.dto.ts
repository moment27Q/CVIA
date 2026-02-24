import { IsOptional, IsString, MaxLength } from 'class-validator';

export class GenerateCareerPathFromCvDto {
  @IsString()
  @IsOptional()
  @MaxLength(20000)
  cvText?: string;

  @IsString()
  @MaxLength(200)
  targetRole!: string;

  @IsString()
  @IsOptional()
  @MaxLength(120)
  userId?: string;
}
