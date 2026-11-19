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
  // node-postgres returns BIGINT (ids, count(), sum()) and NUMERIC (avg()) as strings; PGlite returns numbers.
  // Parse both to numbers so both drivers behave the same (ids stay far below 2^53).
  pgMod.default.types.setTypeParser(20, (v: string) => Number(v));
  pgMod.default.types.setTypeParser(1700, (v: string) => Number(v));
  const needsSsl = /sslmode=require|neon\.tech/.test(url);
  // keepAlive + a short idle timeout: serverless Postgres (Neon) drops idle connections when it scales to zero
  const pool = new Pool({ connectionString: url, max: 10, idleTimeoutMillis: 30_000, keepAlive: true,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined });
  // a dropped idle connection must never crash the server: the pool replaces it on the next query
  pool.on("error", (e) => console.warn(`[db] idle connection closed by server: ${e.message}`));

  /** Connection-level failures (not SQL errors) are safe to retry once outside a transaction. */
  const dropped = (e: unknown) => {
    const err = e as { code?: string; message?: string };
    return ["ECONNRESET", "EPIPE", "ETIMEDOUT", "57P01", "57P02", "57P03"].includes(err.code ?? "") || String(err.code ?? "").startsWith("08")
      || /Connection terminated|connection.*closed/i.test(err.message ?? "");
  };

  const make = (q: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }): Db => ({
    kind: "postgres",
    async query<T>(sql: string, params?: unknown[]) {
      try {
        const r = await q.query(sql, params);
        return { rows: r.rows as T[] };
      } catch (e) {
        if (q === pool && dropped(e)) {
          try {
            return { rows: (await pool.query(sql, params)).rows as T[] };
          } catch (e2) {
            throw clean(e2, sql);
          }
        }
        throw clean(e, sql);
      }
    },
    async exec(sql: string) {
      try {
        await q.query(sql);
      } catch (e) {
        if (q === pool && dropped(e)) {
          try {
            await pool.query(sql);
            return;
          } catch (e2) {
            throw clean(e2, sql);
          }
        }
        throw clean(e, sql);
      }
    },
    async tx<T>(fn: (db: Db) => Promise<T>) {
      const client = await pool.connect();
      let broken: Error | undefined;
      try {
        await client.query("BEGIN");
        const out = await fn(make(client));
        await client.query("COMMIT");
        return out;
      } catch (e) {
        // if the connection itself died, ROLLBACK fails too: discard that connection instead of reusing it
        await client.query("ROLLBACK").catch((re: Error) => { broken = re; });
        throw e;
      } finally {
        client.release(broken);
      }
    },
    close: () => pool.end(),
  });

  // serverless Postgres may be asleep: wait for it to wake (up to ~1 min) instead of failing the boot
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query("SELECT 1");
      break;
    } catch (e) {
      if (attempt >= 6) throw clean(e, "SELECT 1");
      console.warn(`[db] database not reachable yet (${(e as Error).message}); retrying (${attempt}/5)`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
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
