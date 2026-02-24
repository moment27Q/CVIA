import { IsOptional, IsString, MaxLength } from 'class-validator';

export class GenerateCareerPathDto {
  @IsString()
  @MaxLength(12000)
  currentProfile!: string;

  @IsString()
  @MaxLength(200)
  targetRole!: string;

  @IsString()
  @IsOptional()
  @MaxLength(120)
  userId?: string;

  @IsString()
  @IsOptional()
  @MaxLength(120)
  country?: string;
}
