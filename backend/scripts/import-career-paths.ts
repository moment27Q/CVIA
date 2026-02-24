import 'dotenv/config';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Pool } from 'pg';

interface CareerPathRow {
  role: string;
  target_country: string;
  core_skills: string[];
  optional_skills: string[];
  career_goal: string;
}

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

function buildContent(row: CareerPathRow): string {
  return [
    `Role: ${row.role}`,
    `Country: ${row.target_country}`,
    `Core skills: ${row.core_skills.join(', ')}`,
    `Optional skills: ${row.optional_skills.join(', ')}`,
    `Next career step: ${row.career_goal}`,
  ].join('\n');
}

function normalizeRefPart(value: string): string {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

async function readInputFile(): Promise<CareerPathRow[]> {
  const filePath = path.join(process.cwd(), 'data', 'career_paths_100_real.normalized.json');
  const raw = await fs.readFile(filePath, 'utf8');
  const sanitized = raw.replace(/^\uFEFF/, '').trim();
  const parsed: unknown = JSON.parse(sanitized);
  if (!Array.isArray(parsed)) {
    throw new Error('El archivo de entrada no contiene un array JSON.');
  }

  return parsed.map((item) => {
    const row = item as Partial<CareerPathRow>;
    return {
      role: String(row.role || '').trim(),
      target_country: String(row.target_country || '').trim(),
      core_skills: Array.isArray(row.core_skills) ? row.core_skills.map((x) => String(x).trim()).filter(Boolean) : [],
      optional_skills: Array.isArray(row.optional_skills)
        ? row.optional_skills.map((x) => String(x).trim()).filter(Boolean)
        : [],
      career_goal: String(row.career_goal || '').trim(),
    };
  });
}

async function run(): Promise<void> {
  const rows = await readInputFile();
  const pool = getPool();
  const client = await pool.connect();
  let inserted = 0;

  try {
    await client.query('BEGIN');

    for (let idx = 0; idx < rows.length; idx += 1) {
      const row = rows[idx];
      if (!row.role) continue;
      const refId = [
        normalizeRefPart(row.role),
        normalizeRefPart(row.target_country || 'na'),
        normalizeRefPart(row.career_goal || 'na'),
        String(idx + 1),
      ].join('|');

      const content = buildContent(row);
      const metadata = {
        role: row.role,
        target_country: row.target_country,
        core_skills: row.core_skills,
        optional_skills: row.optional_skills,
        career_goal: row.career_goal,
      };

      const result = await client.query(
        `INSERT INTO recruiting_case_vectors (case_type, ref_id, content, metadata, embedding)
         SELECT $1, $2, $3, $4::jsonb, $5::jsonb
         WHERE NOT EXISTS (
           SELECT 1
           FROM recruiting_case_vectors
           WHERE case_type = $1 AND ref_id = $2
         )`,
        ['career_path_template', refId, content, JSON.stringify(metadata), JSON.stringify([])],
      );

      inserted += result.rowCount || 0;
    }

    await client.query('COMMIT');
    console.log(`Insertados: ${inserted}`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((error) => {
  console.error('Error importando career paths:', error);
  process.exit(1);
});
