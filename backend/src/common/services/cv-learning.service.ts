import { Injectable, OnModuleInit } from '@nestjs/common';
import { RecruitingRagService } from './recruiting-rag.service';

@Injectable()
export class CvLearningService implements OnModuleInit {
  constructor(private readonly ragService: RecruitingRagService) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.ragService.query(
        `CREATE TABLE IF NOT EXISTS cv_analysis_history (
          id SERIAL PRIMARY KEY,
          cv_text TEXT,
          extracted_skills JSONB,
          suggested_role TEXT,
          matched_role TEXT,
          match_percentage INTEGER,
          level TEXT,
          missing_skills JSONB,
          target_role TEXT,
          roadmap_to_target JSONB,
          full_result JSONB,
          created_at TIMESTAMP DEFAULT NOW()
        )`,
        [],
      );
      await this.ragService.query(
        `ALTER TABLE cv_analysis_history
         ADD COLUMN IF NOT EXISTS target_role TEXT,
         ADD COLUMN IF NOT EXISTS roadmap_to_target JSONB,
         ADD COLUMN IF NOT EXISTS accepted_by_user BOOLEAN DEFAULT FALSE,
         ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMP NULL`,
        [],
      );
      await this.ragService.query(
        'CREATE INDEX IF NOT EXISTS idx_cv_analysis_role ON cv_analysis_history(matched_role)',
        [],
      );
      await this.ragService.query(
        'CREATE INDEX IF NOT EXISTS idx_cv_analysis_created ON cv_analysis_history(created_at DESC)',
        [],
      );
    } catch (error) {
      console.warn('[CvLearningService] Could not initialize cv_analysis_history table', error);
    }
  }

  async saveAnalysis(data: {
    cvText: string;
    extractedSkills: string[];
    suggestedRole: string;
    matchedRole: string;
    matchPercentage: number;
    level: string;
    missingSkills: string[];
    targetRole?: string;
    roadmapToTarget?: Record<string, unknown> | null;
    fullResult: object;
  }): Promise<number | null> {
    try {
      const result = await this.ragService.query(
        `INSERT INTO cv_analysis_history
          (cv_text, extracted_skills, suggested_role, matched_role, match_percentage, level, missing_skills, target_role, roadmap_to_target, full_result)
         VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10::jsonb)
         RETURNING id`,
        [
          data.cvText,
          JSON.stringify(data.extractedSkills || []),
          data.suggestedRole,
          data.matchedRole,
          Number.isFinite(Number(data.matchPercentage)) ? Math.round(Number(data.matchPercentage)) : 0,
          data.level,
          JSON.stringify(data.missingSkills || []),
          data.targetRole || null,
          JSON.stringify(data.roadmapToTarget || null),
          JSON.stringify(data.fullResult || {}),
        ],
      );
      return Number(result.rows?.[0]?.id || 0) || null;
    } catch (error) {
      console.warn('[CvLearningService] saveAnalysis failed', error);
      return null;
    }
  }

  async acceptAnalysis(analysisId: number): Promise<boolean> {
    try {
      const id = Number(analysisId);
      if (!Number.isFinite(id) || id <= 0) return false;
      const result = await this.ragService.query(
        `UPDATE cv_analysis_history
         SET accepted_by_user = TRUE,
             accepted_at = NOW()
         WHERE id = $1`,
        [id],
      );
      return Number(result.rowCount || 0) > 0;
    } catch (error) {
      console.warn('[CvLearningService] acceptAnalysis failed', error);
      return false;
    }
  }

  async getTrainingContext(skills: string[]): Promise<string> {
    try {
      if (!skills.length) return '';

      const picked = skills.slice(0, 5);
      const skillConditions = picked.map((_, i) => `extracted_skills::text ILIKE $${i + 1}`).join(' OR ');
      const values = picked.map((s) => `%${s}%`);

      const result = await this.ragService.query(
        `SELECT
           extracted_skills,
           matched_role,
           target_role,
           match_percentage,
           level,
           missing_skills,
           roadmap_to_target,
           accepted_by_user,
           created_at
         FROM cv_analysis_history
         WHERE ${skillConditions}
         ORDER BY created_at DESC
         LIMIT 20`,
        values,
      );

      if (!result.rows.length) return '';

      const context = result.rows.map((row: any) => ({
        skills: row.extracted_skills,
        role: row.matched_role,
        targetRole: row.target_role,
        matchPercentage: row.match_percentage,
        level: row.level,
        missingSkills: row.missing_skills,
        roadmapEstimatedTime: row.roadmap_to_target?.estimatedTime,
        roadmapToTarget: row.roadmap_to_target,
        acceptedByUser: Boolean(row.accepted_by_user),
      }));

      return JSON.stringify(context);
    } catch (error) {
      console.warn('[CvLearningService] getTrainingContext failed', error);
      return '';
    }
  }

  async getLearningStats(): Promise<{
    totalCVsAnalyzed: number;
    mostCommonRoles: { role: string; count: number }[];
    mostCommonSkills: { skill: string; count: number }[];
  }> {
    try {
      const total = await this.ragService.query('SELECT COUNT(*) as total FROM cv_analysis_history', []);
      const roles = await this.ragService.query(
        `SELECT matched_role as role, COUNT(*)::int as count
         FROM cv_analysis_history
         WHERE matched_role IS NOT NULL AND matched_role <> ''
         GROUP BY matched_role
         ORDER BY count DESC
         LIMIT 10`,
        [],
      );

      return {
        totalCVsAnalyzed: parseInt(String(total.rows[0]?.total || '0'), 10),
        mostCommonRoles: roles.rows as { role: string; count: number }[],
        mostCommonSkills: [],
      };
    } catch (error) {
      console.warn('[CvLearningService] getLearningStats failed', error);
      return {
        totalCVsAnalyzed: 0,
        mostCommonRoles: [],
        mostCommonSkills: [],
      };
    }
  }
}
