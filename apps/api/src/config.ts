/**
 * Typed configuration from environment variables (and an optional .env file).
 * Every external key is optional: discovery, retrieval, clustering, graph analytics and
 * scoring all run without any API key. Only the conversational layer needs an LLM key.
 */
import { z } from "zod";

try {
  process.loadEnvFile?.(); // Node >= 20.12: reads ./.env if present
} catch {
  /* no .env file: rely on the real environment */
}

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

const Env = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().default(8080),
  LOG_LEVEL: z.string().default("info"),
  CORS_ORIGINS: z.string().default("http://localhost:5173,http://127.0.0.1:5173"),
  PUBLIC_URL: z.string().default("http://localhost:8080"),

  // --- storage ------------------------------------------------------------------------
  /** postgres://… (e.g. Neon). Empty = embedded Postgres (PGlite) on local disk. */
  DATABASE_URL: z.string().optional(),
  DATA_DIR: z.string().default("./data"),

  // --- Python ML microservice (embeddings, reranking, PDF parsing, clustering) ------------
  ML_SERVICE_URL: z.string().default("http://127.0.0.1:8001"),
  /** Shared secret sent as X-Internal-Token; set the same value on the ML service in production. */
  ML_SERVICE_TOKEN: z.string().optional(),
  ML_TIMEOUT_MS: z.coerce.number().int().default(120_000),
  EMBEDDING_DIM: z.coerce.number().int().default(384), // BAAI/bge-small-en-v1.5
  ENABLE_RERANKER: bool.default(true),

  // --- discovery sources (all free; keys only raise limits) -----------------------------
  OPENALEX_MAILTO: z.string().optional(), // joins OpenAlex's faster "polite pool"
  OPENALEX_API_KEY: z.string().optional(), // free key: avoids anonymous search throttling under load

  // --- Sign in with Google (optional; create an OAuth client in Google Cloud Console) -----
  // Authorised redirect URI to register: <PUBLIC_URL>/api/auth/google/callback
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  // --- LLM (OpenRouter, backend-only key) ------------------------------------------------
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().default("particle-ai/particle-1:free"),
  LLM_DAILY_TOKEN_BUDGET: z.coerce.number().int().default(300_000),      // whole service
  LLM_USER_DAILY_TOKEN_BUDGET: z.coerce.number().int().default(60_000),  // per user
  LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().default(1200),
  LLM_MAX_CONTEXT_CHARS: z.coerce.number().int().default(24_000),
  LLM_TIMEOUT_MS: z.coerce.number().int().default(60_000),

  // --- ingestion / abuse protection -------------------------------------------------------
  INGEST_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  MAX_UPLOAD_MB: z.coerce.number().default(40),
  MAX_PDF_PAGES: z.coerce.number().int().default(60),
  RATE_LIMIT_PER_MIN: z.coerce.number().int().default(120),
  CHAT_RATE_LIMIT_PER_MIN: z.coerce.number().int().default(12),
});

export type Config = z.infer<typeof Env>;

const parsed = Env.safeParse(process.env);
if (!parsed.success) {
  // Fail fast with a readable message (never print values: they may be secrets).
  const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  throw new Error(`Invalid configuration: ${issues}`);
}

export const config: Config = parsed.data;
export const llmEnabled = () => Boolean(config.OPENROUTER_API_KEY);
