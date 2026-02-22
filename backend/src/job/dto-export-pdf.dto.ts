import { IsNotEmpty, IsString } from 'class-validator';

export class ExportPdfDto {
  @IsString()
  @IsNotEmpty()
  userId!: string;

  @IsString()
  @IsNotEmpty()
  fullName!: string;

  @IsString()
  @IsNotEmpty()
  plan!: string;

  @IsString()
  @IsNotEmpty()
  cvText!: string;

  @IsString()
  @IsNotEmpty()
  coverLetter!: string;
}
