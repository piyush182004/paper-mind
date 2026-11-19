/**
 * Versioned, forward-only migrations. The relational schema is the system of record for
 * everything: papers, full-text chunks, vectors (pgvector), the BM25 inverted index,
 * the knowledge graph (entities + typed edge tables), clusters, metrics, jobs and LLM usage.
 */
import { config } from "../config.js";
import type { Db } from "./client.js";

const D = config.EMBEDDING_DIM;

const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: "core schema",
    sql: /* sql */ `
CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------- papers & bibliographic graph
CREATE TABLE IF NOT EXISTS papers (
  id                BIGSERIAL PRIMARY KEY,
  source            TEXT NOT NULL,                        -- openalex | arxiv | semantic_scholar | core | upload
  doi               TEXT,
  arxiv_id          TEXT,
  openalex_id       TEXT,
  s2_id             TEXT,
  title             TEXT NOT NULL,
  abstract          TEXT,
  year              INT,
  published_on      DATE,
  venue             TEXT,
  url               TEXT,
  pdf_url           TEXT,
  is_open_access    BOOLEAN NOT NULL DEFAULT FALSE,
  citation_count    INT NOT NULL DEFAULT 0,
  referenced_works  TEXT[] NOT NULL DEFAULT '{}',         -- external ids (OpenAlex W…, DOIs) of references
  status            TEXT NOT NULL DEFAULT 'queued',       -- queued | processing | ready | metadata_only | failed
  status_detail     TEXT,
  has_fulltext      BOOLEAN NOT NULL DEFAULT FALSE,
  page_count        INT,
  embedding         vector(${D}),                         -- title + abstract (paper-level retrieval & clustering)
  tsv tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(abstract, '')), 'B')) STORED,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS papers_doi_uq      ON papers (lower(doi)) WHERE doi IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS papers_arxiv_uq    ON papers (arxiv_id)    WHERE arxiv_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS papers_openalex_uq ON papers (openalex_id) WHERE openalex_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS papers_tsv_gin   ON papers USING gin (tsv);
CREATE INDEX IF NOT EXISTS papers_year_idx  ON papers (year);
CREATE INDEX IF NOT EXISTS papers_status    ON papers (status);
CREATE INDEX IF NOT EXISTS papers_emb_hnsw  ON papers USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS authors (
  id           BIGSERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  name_key     TEXT NOT NULL UNIQUE,                      -- openalex id when known, else normalised name
  openalex_id  TEXT,
  orcid        TEXT
);
CREATE TABLE IF NOT EXISTS paper_authors (
  paper_id   BIGINT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  author_id  BIGINT NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
  position   INT NOT NULL,
  PRIMARY KEY (paper_id, author_id)
);
CREATE INDEX IF NOT EXISTS paper_authors_author ON paper_authors (author_id);

CREATE TABLE IF NOT EXISTS citations (                   -- edges between papers in the library
  citing_id  BIGINT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  cited_id   BIGINT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  PRIMARY KEY (citing_id, cited_id),
  CHECK (citing_id <> cited_id)
);
CREATE INDEX IF NOT EXISTS citations_cited ON citations (cited_id);

-- ---------------------------------------------------------------- full text, vectors, BM25
CREATE TABLE IF NOT EXISTS chunks (
  id          BIGSERIAL PRIMARY KEY,
  paper_id    BIGINT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  ord         INT NOT NULL,                               -- reading order (enables small-to-big context)
  section     TEXT,
  kind        TEXT NOT NULL DEFAULT 'text',               -- abstract | text | table | figure | equation
  page_start  INT,
  page_end    INT,
  content     TEXT NOT NULL,
  length      INT NOT NULL DEFAULT 0,                     -- BM25 document length (tokens)
  embedding   vector(${D})
);
CREATE INDEX IF NOT EXISTS chunks_paper_ord ON chunks (paper_id, ord);
CREATE INDEX IF NOT EXISTS chunks_emb_hnsw  ON chunks USING hnsw (embedding vector_cosine_ops);

-- Inverted index for exact Okapi BM25 computed in SQL.
CREATE TABLE IF NOT EXISTS chunk_terms (
  term      TEXT   NOT NULL,
  chunk_id  BIGINT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  tf        INT    NOT NULL,
  PRIMARY KEY (term, chunk_id)
);
CREATE INDEX IF NOT EXISTS chunk_terms_chunk ON chunk_terms (chunk_id);

-- ---------------------------------------------------------------- knowledge graph
CREATE TABLE IF NOT EXISTS entities (
  id    BIGSERIAL PRIMARY KEY,
  type  TEXT NOT NULL,                                    -- concept | method | model | dataset | metric | task
  name  TEXT NOT NULL,
  key   TEXT NOT NULL,                                    -- normalised name
  UNIQUE (type, key)
);
CREATE TABLE IF NOT EXISTS paper_entities (
  paper_id           BIGINT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  entity_id          BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  mentions           INT NOT NULL DEFAULT 1,
  source             TEXT NOT NULL,                       -- openalex | text
  score              REAL,                                -- source confidence (e.g. OpenAlex topic score)
  evidence_chunk_id  BIGINT REFERENCES chunks(id) ON DELETE SET NULL,
  evidence           TEXT,
  PRIMARY KEY (paper_id, entity_id)
);
CREATE INDEX IF NOT EXISTS paper_entities_entity ON paper_entities (entity_id);

-- Findings, limitations and contributions, each pinned to a page and chunk.
CREATE TABLE IF NOT EXISTS claims (
  id         BIGSERIAL PRIMARY KEY,
  paper_id   BIGINT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  chunk_id   BIGINT REFERENCES chunks(id) ON DELETE CASCADE,
  page       INT,
  kind       TEXT NOT NULL,                               -- finding | limitation | contribution
  text       TEXT NOT NULL,
  polarity   SMALLINT NOT NULL DEFAULT 0,                 -- +1 improves / -1 worsens / 0 neutral
  embedding  vector(${D})
);
CREATE INDEX IF NOT EXISTS claims_paper ON claims (paper_id);
CREATE INDEX IF NOT EXISTS claims_kind  ON claims (kind);
CREATE TABLE IF NOT EXISTS claim_entities (
  claim_id   BIGINT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  entity_id  BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  PRIMARY KEY (claim_id, entity_id)
);
CREATE INDEX IF NOT EXISTS claim_entities_entity ON claim_entities (entity_id);

-- ---------------------------------------------------------------- clustering
CREATE TABLE IF NOT EXISTS cluster_runs (
  id          BIGSERIAL PRIMARY KEY,
  algorithm   TEXT NOT NULL,                              -- hdbscan | kmeans
  params      JSONB NOT NULL DEFAULT '{}',
  n_papers    INT NOT NULL,
  n_clusters  INT NOT NULL,
  n_noise     INT NOT NULL DEFAULT 0,
  silhouette  REAL,
  is_active   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS clusters (
  id          BIGSERIAL PRIMARY KEY,
  run_id      BIGINT NOT NULL REFERENCES cluster_runs(id) ON DELETE CASCADE,
  label       INT NOT NULL,
  parent_id   BIGINT REFERENCES clusters(id) ON DELETE CASCADE,
  level       INT NOT NULL DEFAULT 0,                     -- 0 = topic, 1 = parent theme
  name        TEXT NOT NULL,
  keywords    JSONB NOT NULL DEFAULT '[]',
  size        INT NOT NULL,
  coherence   REAL
);
CREATE INDEX IF NOT EXISTS clusters_run ON clusters (run_id);
CREATE TABLE IF NOT EXISTS paper_clusters (
  run_id         BIGINT NOT NULL REFERENCES cluster_runs(id) ON DELETE CASCADE,
  paper_id       BIGINT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  cluster_id     BIGINT REFERENCES clusters(id) ON DELETE CASCADE,  -- NULL = outlier / noise
  probability    REAL,
  outlier_score  REAL,
  x              REAL,
  y              REAL,
  PRIMARY KEY (run_id, paper_id)
);
CREATE INDEX IF NOT EXISTS paper_clusters_cluster ON paper_clusters (cluster_id);

-- ---------------------------------------------------------------- graph analytics cache
CREATE TABLE IF NOT EXISTS graph_metrics (
  node_key     TEXT PRIMARY KEY,                          -- e.g. paper:12, author:4, dataset:7
  node_type    TEXT NOT NULL,
  pagerank     REAL,
  betweenness  REAL,
  degree       INT,
  community    INT,
  computed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- operations
CREATE TABLE IF NOT EXISTS jobs (
  id          BIGSERIAL PRIMARY KEY,
  kind        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'queued',             -- queued | running | done | failed
  progress    REAL NOT NULL DEFAULT 0,
  message     TEXT,
  payload     JSONB NOT NULL DEFAULT '{}',
  result      JSONB,
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs (status, created_at);

CREATE TABLE IF NOT EXISTS llm_usage (
  id                 BIGSERIAL PRIMARY KEY,
  model              TEXT NOT NULL,
  route              TEXT NOT NULL,
  prompt_tokens      INT NOT NULL DEFAULT 0,
  completion_tokens  INT NOT NULL DEFAULT 0,
  cached             BOOLEAN NOT NULL DEFAULT FALSE,
  ok                 BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS llm_usage_day ON llm_usage (created_at);
CREATE TABLE IF NOT EXISTS llm_cache (
  key         TEXT PRIMARY KEY,
  response    JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
`,
  },
  {
    version: 2,
    name: "multi-user: accounts, sessions, per-user libraries",
    sql: /* sql */ `
CREATE TABLE IF NOT EXISTS users (
  id             BIGSERIAL PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,                           -- SHA-256 of the cookie token, never the token
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);

-- Public papers (and their chunks, vectors, entities, claims) are processed once and shared;
-- each user's view is their library. Uploaded PDFs are private: owner_id is set and nobody else links them.
CREATE TABLE IF NOT EXISTS library (
  user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  paper_id  BIGINT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  added_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, paper_id)
);
CREATE INDEX IF NOT EXISTS library_paper ON library (paper_id);
ALTER TABLE papers       ADD COLUMN IF NOT EXISTS owner_id BIGINT REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE cluster_runs ADD COLUMN IF NOT EXISTS user_id  BIGINT REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE jobs         ADD COLUMN IF NOT EXISTS user_id  BIGINT;
ALTER TABLE llm_usage    ADD COLUMN IF NOT EXISTS user_id  BIGINT;
CREATE INDEX IF NOT EXISTS jobs_user ON jobs (user_id, id);
CREATE INDEX IF NOT EXISTS llm_usage_user ON llm_usage (user_id, created_at);

-- graph analytics are per user (each library is its own graph)
DELETE FROM graph_metrics;
ALTER TABLE graph_metrics DROP CONSTRAINT IF EXISTS graph_metrics_pkey;
ALTER TABLE graph_metrics ADD COLUMN IF NOT EXISTS user_id BIGINT NOT NULL DEFAULT 0;
ALTER TABLE graph_metrics ADD PRIMARY KEY (user_id, node_key);
UPDATE cluster_runs SET is_active = FALSE WHERE user_id IS NULL;
`,
  },
  {
    version: 3,
    name: "sign in with Google",
    sql: /* sql */ `
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;   -- Google-only accounts have no password
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub TEXT;   -- Google's stable account id
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub ON users (google_sub) WHERE google_sub IS NOT NULL;
`,
  },
];

export async function migrate(db: Db): Promise<number[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INT PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const { rows } = await db.query<{ version: number }>("SELECT version FROM schema_migrations");
  const done = new Set(rows.map((r) => Number(r.version)));
  const applied: number[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    await db.tx(async (t) => {
      await t.exec(m.sql);
      await t.query("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", [m.version, m.name]);
    });
    applied.push(m.version);
  }
  return applied;
}
