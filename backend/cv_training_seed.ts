import 'dotenv/config';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Pool } from 'pg';

type SeedRow = {
  cv_text: string;
  extracted_skills: unknown[];
  suggested_role: string;
  matched_role: string;
  match_percentage: number;
  level: string;
  missing_skills: unknown[];
  full_result: Record<string, unknown>;
};

function getPool(): Pool {
  if (process.env.DATABASE_URL) {
    return new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return new Pool({
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || '',
    database: process.env.PGDATABASE || 'recruiting_ai_db',
  });
}

async function ensureTable(pool: Pool): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS cv_analysis_history (
      id SERIAL PRIMARY KEY,
      cv_text TEXT,
      extracted_skills JSONB,
      suggested_role TEXT,
      matched_role TEXT,
      match_percentage INTEGER,
      level TEXT,
      missing_skills JSONB,
      full_result JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    )`,
  );
  await pool.query('CREATE INDEX IF NOT EXISTS idx_cv_analysis_role ON cv_analysis_history(matched_role)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_cv_analysis_created ON cv_analysis_history(created_at DESC)');
}

async function loadSeedFile(): Promise<SeedRow[]> {
  const filePath = path.join(process.cwd(), 'data', 'cv_training_seed.json');
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('cv_training_seed.json no contiene un array JSON.');
  }

  return parsed.map((item: any) => ({
    cv_text: String(item?.cv_text || '').trim(),
    extracted_skills: Array.isArray(item?.extracted_skills) ? item.extracted_skills : [],
    suggested_role: String(item?.suggested_role || '').trim(),
    matched_role: String(item?.matched_role || '').trim(),
    match_percentage: Number.isFinite(Number(item?.match_percentage)) ? Number(item.match_percentage) : 0,
    level: String(item?.level || '').trim(),
    missing_skills: Array.isArray(item?.missing_skills) ? item.missing_skills : [],
    full_result: typeof item?.full_result === 'object' && item?.full_result ? item.full_result : {},
  }));
}

async function run(): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  let inserted = 0;
  let skipped = 0;

  try {
    await ensureTable(pool);
    const rows = await loadSeedFile();
    await client.query('BEGIN');

    for (const row of rows) {
      if (!row.cv_text) {
        skipped += 1;
        continue;
      }

      const exists = await client.query(
        `SELECT 1
         FROM cv_analysis_history
         WHERE cv_text = $1
           AND suggested_role = $2
           AND matched_role = $3
           AND match_percentage = $4
           AND level = $5
         LIMIT 1`,
        [row.cv_text, row.suggested_role, row.matched_role, Math.round(row.match_percentage), row.level],
      );

      if (exists.rowCount && exists.rowCount > 0) {
        skipped += 1;
        continue;
      }

      await client.query(
        `INSERT INTO cv_analysis_history
          (cv_text, extracted_skills, suggested_role, matched_role, match_percentage, level, missing_skills, full_result)
         VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7::jsonb, $8::jsonb)`,
        [
          row.cv_text,
          JSON.stringify(row.extracted_skills || []),
          row.suggested_role,
          row.matched_role,
          Math.round(row.match_percentage),
          row.level,
          JSON.stringify(row.missing_skills || []),
          JSON.stringify(row.full_result || {}),
        ],
      );
      inserted += 1;
    }

    await client.query('COMMIT');
    console.log(`Seed completado. Insertados: ${inserted}. Omitidos: ${skipped}.`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((error) => {
  console.error('Error cargando cv_training_seed.json:', error);
  process.exit(1);
});
