import { IsString, MaxLength } from 'class-validator';

export class GetLearningResourcesDto {
  @IsString()
  @MaxLength(120)
  skill_name!: string;

  @IsString()
  @MaxLength(60)
  user_level!: string;
}
