/** Fastify application: plugins, security, validation, error mapping, routes, and the built web UI. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { ZodError } from "zod";
import { config } from "./config.js";
import { DbError, type Db } from "./db/client.js";
import { JobQueue } from "./jobs/queue.js";
import { ingestPaper, type IngestPayload } from "./ingest/pipeline.js";
import { runClustering } from "./analysis/clustering.js";
import { recomputeGraphMetrics } from "./graph/graph.js";
import { authHook, authRoutes } from "./auth.js";
import { libraryRoutes } from "./routes/library.js";
import { researchRoutes } from "./routes/research.js";
import { assistantRoutes } from "./routes/assistant.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    jobs: JobQueue;
  }
}

export async function buildApp(db: Db): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: ["req.headers.authorization", "req.headers.cookie", "req.headers[\"x-internal-token\"]"],
    },
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: true,
  });

  const jobs = new JobQueue(db, app.log, config.INGEST_CONCURRENCY);
  jobs.register("ingest", async (p, ctx) => {
    const out = await ingestPaper(db, p as unknown as IngestPayload, ctx);
    if (p.userId) await jobs.scheduleRefresh(Number(p.userId)); // topics & graph update by themselves
    return out;
  });
  jobs.register("cluster", async (p, ctx) => {
    const userId = Number(p.userId);
    await ctx.progress(0.1, "Finding research topics");
    const r = await runClustering(db, userId, p as { algorithm: "hdbscan" | "kmeans"; minClusterSize?: number; k?: number });
    await ctx.progress(0.7, "Mapping connections");
    const g = await recomputeGraphMetrics(db, userId);
    return { ...r, graph: g };
  });
  jobs.register("graph", async (p) => recomputeGraphMetrics(db, Number(p.userId)));
  app.decorate("db", db);
  app.decorate("jobs", jobs);

  await app.register(cors, { origin: config.CORS_ORIGINS.split(",").map((s) => s.trim()), methods: ["GET", "POST", "DELETE"], credentials: true });
  await app.register(rateLimit, { max: config.RATE_LIMIT_PER_MIN, timeWindow: "1 minute" });
  await app.register(multipart, { limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 10, fields: 5 } });

  app.addHook("onSend", async (req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (req.url.startsWith("/api/")) reply.header("Cache-Control", "no-store");
  });

  app.setErrorHandler((error: unknown, req, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({ error: "Invalid request", issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    }
    if (error instanceof DbError) {
      req.log.error({ code: error.code, sql: error.sql, msg: error.message }, "database error");
      return reply.status(500).send({ error: "Database error" });
    }
    const err = error as Error & { status?: number; statusCode?: number };
    const status = err.status ?? err.statusCode ?? 500;
    if (status >= 500 && status !== 503) req.log.error({ err }, "request failed");
    return reply.status(status).send({ error: status >= 500 && status !== 503 ? "Internal server error" : err.message });
  });

  app.decorateRequest("user", null);
  app.addHook("onRequest", authHook(db));
  await app.register(authRoutes, { prefix: "/api" });
  await app.register(libraryRoutes, { prefix: "/api" });
  await app.register(researchRoutes, { prefix: "/api" });
  await app.register(assistantRoutes, { prefix: "/api" });

  // built React app (production): same origin, no CORS needed
  const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  if (fs.existsSync(path.join(web, "index.html"))) {
    // wildcard: files are resolved per request, so a rebuilt UI (new hashed chunks) works without a restart
    await app.register(fastifyStatic, {
      root: web, wildcard: true, cacheControl: false,
      // index.html must always be revalidated (it points at the current build); hashed assets never change
      setHeaders: (res, file) =>
        res.header("Cache-Control", path.basename(path.dirname(file)) === "assets" ? "public, max-age=31536000, immutable" : "no-cache"),
    });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/") ? reply.status(404).send({ error: "Not found" }) : reply.header("Cache-Control", "no-cache").sendFile("index.html"),
    );
  }
  return app;
}
