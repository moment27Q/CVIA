export type PlanType = 'free' | 'premium';

export interface JobData {
  url: string;
  title: string;
  company: string;
  rawText: string;
  keywords: string[];
}

export interface GenerationResult {
  cvText: string;
  coverLetter: string;
  analysis: string;
  keywords: string[];
}

export interface UsageRecord {
  userId: string;
  freeUses: number;
  updatedAt: string;
}
