# PaperMind — Research Intelligence Platform

Discover, organise, analyse and connect scientific papers with **hybrid RAG**, **topic clustering** and a
**knowledge graph**, all stored in one relational database. Every insight links to the paper and page it came from.

```
React + TS + Tailwind (apps/web) ──► Node.js / Fastify API (apps/api) ──► Postgres + pgvector
                                          │  discovery, ingestion jobs, BM25-in-SQL, hybrid search,
                                          │  GraphRAG, graph analytics, research intelligence, LLM gateway
                                          └──► Python ML service (services/ml, internal)
                                                embeddings (BGE), cross-encoder rerank, PDF parsing, UMAP+HDBSCAN
```

| Capability | How it works |
|---|---|
| Discovery | OpenAlex, arXiv, Semantic Scholar, CORE (free); merged and de-duplicated (DOI → arXiv id → title) |
| Ingestion | PDF → page-level blocks (text, sections, tables, figures, equations) → hierarchical chunks → BGE embeddings |
| Hybrid RAG | exact Okapi BM25 in SQL (inverted index table) + pgvector HNSW + paper-level coarse retrieval → RRF → cross-encoder rerank → small-to-big context → GraphRAG expansion |
| Clustering | UMAP → HDBSCAN or K-Means (k by silhouette) → c-TF-IDF topic names → agglomerative parent themes; outliers kept |
| Knowledge graph | papers, authors, concepts, methods, models, datasets, metrics, tasks; citations, mentions, similarity; PageRank, Louvain, betweenness |
| Analytics | explainable composite: citation impact, graph influence, novelty, topic centrality (components + weights shown) |
| Intelligence | potential contradictions, untested method × dataset combinations, recurring limitations, trends, paper comparison |
| AI assistant | Q&A, explain, summarize, compare, literature review over OpenRouter; answers must cite sources; works extractively without a key |

**Accounts & privacy:** sign-up/sign-in with scrypt-hashed passwords and server-side sessions (httpOnly cookie + CSRF header).
Each user has a private library; public papers are processed once and shared, uploaded PDFs are private to their owner.
Search, topics, the graph, analytics, insights, jobs and AI budgets are all scoped per user. Topics and the graph refresh
automatically after imports.

**AI safety:** backend-only keys, daily token budget, response cache, retries, usage tracking, rate limits,
prompt-injection neutralisation of retrieved text, citation validation (invalid citations removed, grounding coverage shown),
and no fabricated metrics or gaps: all analytics are computed, never generated.

## Run locally

Requirements: Node 20+, Python 3.11+.

```bash
npm install                                  # API + web
cd services/ml && python -m venv .venv && .venv/Scripts/pip install -r requirements.txt   # (macOS/Linux: .venv/bin/pip)
.venv/Scripts/python -m uvicorn app.main:app --port 8001      # ML service (first run downloads ~130 MB of models)
cd ../.. && npm run build -w apps/web && npm run dev:api       # API + UI on http://localhost:8080
```

For UI development with hot reload: `npm run dev:web` (http://localhost:5173, proxies `/api`).
No database setup is needed: an embedded Postgres (PGlite with pgvector) is stored under `apps/api/data`.

Tests:
- `npm test`: API unit tests (Vitest, offline)
- `cd services/ml && .venv/Scripts/python -m pytest`: ML service tests
- `cd apps/api && npx tsx scripts/e2e.ts`: full end-to-end test against the running app (68 checks: accounts, security,
  discovery, import, upload, search, AI assistant, topics, map, analytics, insights, compare, removal, privacy between users).
  It uses throwaway accounts and deletes them. Run it before every deploy.

Maintenance scripts (stop the API first when using the embedded database), from `apps/api`:
- `npx tsx scripts/reset-password.ts <email> "<new password>"`
- `npx tsx scripts/reextract.ts`: re-read stored papers with the latest extraction (no downloads)
- `npx tsx scripts/merge-duplicates.ts`: merge a preprint and its published version imported separately

## Configuration

Copy `.env.example` to `apps/api/.env`. All keys are optional:

- `OPENROUTER_API_KEY` enables generated answers (default model `particle-ai/particle-1:free`).
- `DATABASE_URL` switches from embedded Postgres to a server (e.g. a free Neon database with pgvector).
- `OPENALEX_API_KEY`, `SEMANTIC_SCHOLAR_API_KEY`, `CORE_API_KEY` raise source limits (CORE needs one).
- `ML_SERVICE_TOKEN` is a shared secret between API and ML service (required in production).

## Deploy

`docker compose up --build` runs the API (with the UI) and the ML service: http://localhost:8080.
For free hosting: the ML service needs about 1 GB RAM (e.g. Hugging Face Spaces, Docker); the API and UI fit a small
instance (Render, Fly.io, Railway) with `DATABASE_URL` pointing at Neon and `ML_SERVICE_URL` at the ML service.
