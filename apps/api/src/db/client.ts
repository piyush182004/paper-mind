/**
 * One small database interface over two drivers:
 *   - PGlite: real Postgres compiled to WASM, embedded, persisted under DATA_DIR (zero setup locally)
 *   - pg:     any Postgres server, e.g. Neon (free) in production, selected by DATABASE_URL
 * Both run pgvector, full-text search and the same SQL.
 */
import path from "node:path";
import fs from "node:fs";
import { config } from "../config.js";

export interface QueryResult<T> {
  rows: T[];
}

export interface Db {
  readonly kind: "pglite" | "postgres";
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  exec(sql: string): Promise<void>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Driver errors carry the full query parameters (embeddings, document text): never log those. */
export class DbError extends Error {
  constructor(message: string, readonly code?: string, readonly detail?: string, readonly sql?: string) {
    super(message);
    this.name = "DbError";
  }
}
function clean(e: unknown, sql: string): DbError {
  const err = e as { message?: string; code?: string; detail?: string };
  return new DbError(err.message ?? String(e), err.code, err.detail, sql.replace(/\s+/g, " ").slice(0, 160));
}

let instance: Db | null = null;

export async function getDb(): Promise<Db> {
  if (instance) return instance;
  instance = config.DATABASE_URL ? await openPostgres(config.DATABASE_URL) : await openPglite();
  return instance;
}

export async function closeDb(): Promise<void> {
  if (instance) await instance.close();
  instance = null;
}

async function openPglite(dir = path.resolve(config.DATA_DIR, "pglite")): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite-pgvector");
  fs.mkdirSync(dir, { recursive: true });
  const pg = await PGlite.create(dir, { extensions: { vector } });

  const wrap = (q: { query: typeof pg.query; exec: typeof pg.exec }): Omit<Db, "tx" | "close"> => ({
    kind: "pglite",
    async query<T>(sql: string, params?: unknown[]) {
      try {
        const r = await q.query<T>(sql, params as unknown[] | undefined);
        return { rows: r.rows };
      } catch (e) {
        throw clean(e, sql);
      }
    },
    async exec(sql: string) {
      try {
        await q.exec(sql);
      } catch (e) {
        throw clean(e, sql);
      }
    },
  });

  const base = wrap(pg);
  // PGlite is single-connection: serialise transactions so concurrent jobs can't interleave.
  let chain: Promise<unknown> = Promise.resolve();
  return {
    ...base,
    tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
      const run = chain.then(() =>
        pg.transaction(async (t) => {
          const inner: Db = { ...wrap(t as never), tx: (f) => f(inner), close: async () => {} };
          return fn(inner);
        }),
      );
      chain = run.catch(() => undefined);
      return run as Promise<T>;
    },
    close: () => pg.close(),
  };
}

async function openPostgres(url: string): Promise<Db> {
  const pgMod = await import("pg");
  const Pool = pgMod.default.Pool;
  const needsSsl = /sslmode=require|neon\.tech/.test(url);
  const pool = new Pool({ connectionString: url, max: 10, ssl: needsSsl ? { rejectUnauthorized: false } : undefined });

  const make = (q: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }): Db => ({
    kind: "postgres",
    async query<T>(sql: string, params?: unknown[]) {
      try {
        const r = await q.query(sql, params);
        return { rows: r.rows as T[] };
      } catch (e) {
        throw clean(e, sql);
      }
    },
    async exec(sql: string) {
      try {
        await q.query(sql);
      } catch (e) {
        throw clean(e, sql);
      }
    },
    async tx<T>(fn: (db: Db) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn(make(client));
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  });
  return make(pool);
}

/** pgvector literal for a JS vector. */
export const vec = (v: ArrayLike<number>): string => `[${Array.from(v, (x) => (Number.isFinite(x) ? +x.toFixed(6) : 0)).join(",")}]`;

/** Parse a pgvector value returned as text ("[0.1,0.2]") or array. */
export function parseVec(v: unknown): Float32Array {
  if (v == null) return new Float32Array();
  if (Array.isArray(v)) return Float32Array.from(v as number[]);
  const s = String(v).trim();
  return Float32Array.from(JSON.parse(s.startsWith("[") ? s : `[${s}]`) as number[]);
}
