import { IsInt, Min } from 'class-validator';

export class AcceptSuggestedRoleDto {
  @IsInt()
  @Min(1)
  analysisId!: number;
}
