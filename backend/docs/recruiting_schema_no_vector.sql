-- PostgreSQL schema WITHOUT pgvector (fallback mode)

CREATE TABLE IF NOT EXISTS recruiting_candidates (
  id BIGSERIAL PRIMARY KEY,
  external_user_id TEXT,
  cv_text TEXT NOT NULL,
  profile_summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS recruiting_jobs (
  id BIGSERIAL PRIMARY KEY,
  title TEXT,
  description TEXT NOT NULL,
  location TEXT,
  country TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS recruiting_match_predictions (
  id BIGSERIAL PRIMARY KEY,
  candidate_id BIGINT REFERENCES recruiting_candidates(id) ON DELETE CASCADE,
  job_id BIGINT REFERENCES recruiting_jobs(id) ON DELETE CASCADE,
  compatibility_score INT,
  decision TEXT,
  reasons JSONB,
  missing_skills JSONB,
  interview_focus JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS recruiting_match_feedback (
  id BIGSERIAL PRIMARY KEY,
  prediction_id BIGINT REFERENCES recruiting_match_predictions(id) ON DELETE CASCADE,
  verdict TEXT NOT NULL, -- accepted/rejected/like/dislike
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS recruiting_case_vectors (
  id BIGSERIAL PRIMARY KEY,
  case_type TEXT NOT NULL, -- match_case/career_path
  ref_id TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding JSONB NOT NULL DEFAULT '[]'::jsonb, -- stores embedding array as JSON
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recruiting_case_vectors_type_ref
  ON recruiting_case_vectors(case_type, ref_id);

CREATE INDEX IF NOT EXISTS idx_recruiting_case_vectors_metadata_gin
  ON recruiting_case_vectors
  USING gin (metadata);

CREATE TABLE IF NOT EXISTS career_paths (
  id BIGSERIAL PRIMARY KEY,
  external_user_id TEXT,
  current_profile TEXT NOT NULL,
  target_role TEXT NOT NULL,
  summary TEXT,
  estimated_months INT,
  steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS career_path_feedback (
  id BIGSERIAL PRIMARY KEY,
  career_path_id BIGINT REFERENCES career_paths(id) ON DELETE CASCADE,
  verdict TEXT NOT NULL, -- completed/not_useful/like/dislike
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fallback RAG query (without vector distance):
-- SELECT ref_id, metadata, content
-- FROM recruiting_case_vectors
-- WHERE case_type = 'match_case'
-- ORDER BY created_at DESC
-- LIMIT 5;
