import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class FeedbackDto {
  @IsString()
  @IsIn(['match', 'career_path'])
  type!: 'match' | 'career_path';

  @IsString()
  @MaxLength(80)
  refId!: string;

  @IsString()
  @IsIn(['like', 'dislike', 'accepted', 'rejected', 'completed', 'not_useful'])
  verdict!: 'like' | 'dislike' | 'accepted' | 'rejected' | 'completed' | 'not_useful';

  @IsString()
  @IsOptional()
  @MaxLength(500)
  notes?: string;
}
