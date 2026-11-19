/**
 * Durable in-process job queue backed by the `jobs` table: survives restarts (running jobs are
 * re-queued on boot), reports progress for the UI, and bounds concurrency so ingestion can't
 * starve the API. For multi-instance deployments swap this for a shared queue (e.g. pg-boss).
 */
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/client.js";

export interface JobRow {
  id: number;
  kind: string;
  status: "queued" | "running" | "done" | "failed";
  progress: number;
  message: string | null;
  payload: Record<string, unknown>;
  result: unknown;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobContext {
  progress(fraction: number, message?: string): Promise<void>;
}
type Handler = (payload: Record<string, unknown>, ctx: JobContext) => Promise<unknown>;

/** a job still running after this is stopped, so one stuck download or document can't block the queue */
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS ?? 30 * 60_000);

/** What the library shows for a paper whose processing failed. */
function paperFailure(msg: string): string {
  const m = msg.replace(/\s+/g, " ").trim().replace(/\.$/, "");
  return (/again/i.test(m) ? `${m}.` : `Could not be processed: ${m}. Open the paper and use Re-ingest to try again.`).slice(0, 400);
}

export class JobQueue {
  private handlers = new Map<string, Handler>();
  private running = 0;
  private active = 0; // jobs being worked on right now
  private timer: NodeJS.Timeout | null = null;
  private sweeper: NodeJS.Timeout | null = null;
  private awake: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private db: Db, private log: FastifyBaseLogger, private concurrency = 2) {}

  register(kind: string, handler: Handler): void {
    this.handlers.set(kind, handler);
  }

  async enqueue(kind: string, payload: Record<string, unknown>, userId?: number): Promise<number> {
    const { rows } = await this.db.query<{ id: number }>(
      "INSERT INTO jobs (kind, payload, user_id) VALUES ($1, $2::jsonb, $3) RETURNING id",
      [kind, JSON.stringify(payload), userId ?? null],
    );
    this.kick();
    return Number(rows[0].id);
  }

  async start(): Promise<void> {
    // a job that was running when the server died 3 times is what killed it: stop it instead of crash-looping
    const { rows: stuck } = await this.db.query<{ id: number; kind: string; payload: Record<string, unknown> }>(
      `UPDATE jobs SET status = 'failed', error = 'Stopped: this job interrupted the server several times (too large for this server?)',
         updated_at = now() WHERE status = 'running' AND attempts >= 3 RETURNING id, kind, payload`);
    for (const j of stuck) {
      this.log.warn({ jobId: j.id, kind: j.kind }, "job stopped after repeated crashes");
      if (j.kind === "ingest" && j.payload?.paperId)
        await this.db.query("UPDATE papers SET status = 'failed', status_detail = 'Could not be processed on this server (too large?)' WHERE id = $1",
          [Number(j.payload.paperId)]).catch(() => undefined);
    }
    await this.db.query("UPDATE jobs SET status = 'queued', message = 'resumed after restart' WHERE status = 'running'");
    await this.repairStuckPapers().catch((e) => this.log.warn({ err: e }, "stuck-paper check failed"));
    this.timer = setInterval(() => this.kick(), 1500);
    this.sweeper = setInterval(() => void this.repairStuckPapers().catch(() => undefined), 2 * 60_000);
    this.sweeper.unref();
    // free hosts (Render) sleep after ~15 min without visitors, which would pause imports mid-way:
    // while there is work, visit our own public URL so the queue finishes even if everyone left
    const self = process.env.RENDER_EXTERNAL_URL;
    if (self) {
      this.awake = setInterval(() => {
        if (this.active > 0) void fetch(`${self}/api/health`, { signal: AbortSignal.timeout(20_000) }).catch(() => undefined);
      }, 4 * 60_000);
      this.awake.unref();
    }
    this.kick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of [this.timer, this.sweeper, this.awake]) if (t) clearInterval(t);
  }

  /**
   * Papers left "queued"/"processing" with no job that will finish them (lost to a restart, or
   * failed before failures were recorded on the paper) are queued again with their last job's
   * settings; after a few tries in an hour, or with no earlier job, they are marked failed instead.
   */
  async repairStuckPapers(): Promise<void> {
    const { rows } = await this.db.query<{ id: number; payload: Record<string, unknown> | null; recent: number }>(
      `SELECT p.id,
         (SELECT j.payload FROM jobs j WHERE j.kind = 'ingest' AND j.payload->>'paperId' = p.id::text ORDER BY j.id DESC LIMIT 1) AS payload,
         (SELECT count(*)::int FROM jobs j WHERE j.kind = 'ingest' AND j.payload->>'paperId' = p.id::text
            AND j.created_at > now() - interval '1 hour') AS recent
       FROM papers p
       WHERE p.status IN ('queued', 'processing') AND p.updated_at < now() - interval '2 minutes'
         AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.kind = 'ingest' AND j.status IN ('queued', 'running')
                           AND j.payload->>'paperId' = p.id::text)
       ORDER BY p.id LIMIT 20`);
    for (const r of rows) {
      const id = Number(r.id);
      if (r.payload && Number(r.recent) < 3) {
        await this.db.query("UPDATE papers SET status = 'queued', status_detail = 'Waiting to be processed', updated_at = now() WHERE id = $1", [id]);
        await this.enqueue("ingest", r.payload, r.payload.userId ? Number(r.payload.userId) : undefined);
        this.log.info({ paperId: id }, "re-queued a stuck paper");
      } else {
        await this.db.query("UPDATE papers SET status = 'failed', status_detail = $2, updated_at = now() WHERE id = $1",
          [id, paperFailure("processing was interrupted")]);
        this.log.warn({ paperId: id }, "marked a stuck paper as failed");
      }
    }
  }

  /** Start workers up to the concurrency limit; each one claims a job, and re-kicks if it found work. */
  private kick(): void {
    while (!this.stopped && this.running < this.concurrency) {
      this.running++;
      void this.runNext()
        .catch((e) => this.log.error({ err: e }, "job worker crashed"))
        .then((didWork) => {
          this.running--;
          if (didWork) this.kick();
        });
    }
  }

  private async runNext(): Promise<boolean> {
    // claim the oldest queued job atomically
    const { rows } = await this.db.query<JobRow>(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = now()
       WHERE id = (SELECT id FROM jobs q WHERE q.status = 'queued'
                    -- one topics/map rebuild per account at a time, so the newest library state always wins
                    AND NOT (q.kind IN ('cluster','graph') AND EXISTS (SELECT 1 FROM jobs r WHERE r.status = 'running'
                         AND r.kind IN ('cluster','graph') AND r.user_id = q.user_id))
                  ORDER BY q.created_at, q.id LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING id, kind, payload`,
    );
    const job = rows[0];
    if (!job) return false;
    const id = Number(job.id);
    const handler = this.handlers.get(job.kind);
    const ctx: JobContext = {
      progress: async (fraction, message) => {
        await this.db.query("UPDATE jobs SET progress = $2, message = COALESCE($3, message), updated_at = now() WHERE id = $1",
          [id, Math.max(0, Math.min(1, fraction)), message ?? null]);
      },
    };
    const started = Date.now();
    this.log.info({ jobId: id, kind: job.kind }, "job started");
    this.active++;
    let timeout: NodeJS.Timeout | undefined;
    try {
      if (!handler) throw new Error(`no handler for job kind "${job.kind}"`);
      const result = await Promise.race([
        handler(job.payload, ctx),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`it took longer than ${Math.round(JOB_TIMEOUT_MS / 60_000)} minutes`)), JOB_TIMEOUT_MS);
        }),
      ]);
      this.log.info({ jobId: id, kind: job.kind, ms: Date.now() - started }, "job done");
      await this.db.query("UPDATE jobs SET status = 'done', progress = 1, result = $2::jsonb, updated_at = now() WHERE id = $1",
        [id, JSON.stringify(result ?? null)]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log.warn({ jobId: id, kind: job.kind, err: msg }, "job failed");
      // the paper must leave "processing" too, or the library shows it as busy forever
      const paperId = job.kind === "ingest" ? Number(job.payload?.paperId) : NaN;
      if (paperId) {
        await this.db.query(
          `UPDATE papers SET status = 'failed', status_detail = $2, updated_at = now()
           WHERE id = $1 AND status IN ('queued', 'processing')
             AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id <> $3 AND j.kind = 'ingest' AND j.status IN ('queued', 'running')
                               AND j.payload->>'paperId' = $1::text)`,
          [paperId, paperFailure(msg), id]).catch((err) => this.log.warn({ err, paperId }, "could not mark paper failed"));
      }
      await this.db.query("UPDATE jobs SET status = 'failed', error = $2, updated_at = now() WHERE id = $1", [id, msg.slice(0, 1000)]);
    } finally {
      clearTimeout(timeout);
      this.active--;
    }
    return true;
  }

  async get(id: number, userId: number): Promise<JobRow | null> {
    const { rows } = await this.db.query<JobRow>("SELECT * FROM jobs WHERE id = $1 AND user_id = $2", [id, userId]);
    return rows[0] ?? null;
  }

  async list(userId: number, limit = 50): Promise<JobRow[]> {
    const { rows } = await this.db.query<JobRow>("SELECT * FROM jobs WHERE user_id = $1 ORDER BY id DESC LIMIT $2", [userId, limit]);
    return rows;
  }

  /** Queue one topics+graph refresh for a user once their imports are done (debounced). */
  async scheduleRefresh(userId: number): Promise<void> {
    const { rows } = await this.db.query<{ ingest: number; refresh: number; papers: number }>(
      `SELECT
         (SELECT count(*)::int FROM jobs WHERE user_id = $1 AND kind = 'ingest' AND status IN ('queued','running')) AS ingest,
         (SELECT count(*)::int FROM jobs WHERE user_id = $1 AND kind = 'cluster' AND status = 'queued') AS refresh,
         (SELECT count(*)::int FROM library l JOIN papers p ON p.id = l.paper_id WHERE l.user_id = $1 AND p.embedding IS NOT NULL) AS papers`,
      [userId],
    );
    const r = rows[0];
    // the calling ingest job is still "running": allow 1
    if (Number(r.ingest) <= 1 && Number(r.refresh) === 0) {
      // the cluster job also handles < 3 papers (it clears old topics) and then rebuilds the map
      await this.enqueue("cluster", { userId, algorithm: "hdbscan", auto: true }, userId);
    }
  }
}
