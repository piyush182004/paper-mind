/** Discovery, import, upload, library listing, paper details, jobs. Everything is scoped to the signed-in user. */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { config, llmEnabled } from "../config.js";
import { userId } from "../auth.js";
import { ml } from "../ml/client.js";
import { availableSources, discover } from "../sources/index.js";
import type { DiscoveredPaper } from "../sources/types.js";
import { findExisting, getPaper, upsertDiscovered } from "../repo/papers.js";
import { uploadsDir } from "../ingest/pipeline.js";

const SourceName = z.enum(["openalex", "arxiv"]);
const Id = z.object({ id: z.coerce.number().int() });

const DiscoveredSchema = z.object({
  source: SourceName, sourceId: z.string(), title: z.string().min(1).max(1000), abstract: z.string().max(20000).nullable(),
  year: z.number().int().nullable(), publishedOn: z.string().nullable(), venue: z.string().max(500).nullable(), url: z.string().nullable(),
  pdfUrl: z.string().nullable(), doi: z.string().nullable(), arxivId: z.string().nullable(), openalexId: z.string().nullable(),
  s2Id: z.string().nullable(), isOpenAccess: z.boolean(), citationCount: z.number().int(),
  authors: z.array(z.object({ name: z.string(), openalexId: z.string().nullable().optional(), orcid: z.string().nullable().optional() })).max(100),
  concepts: z.array(z.object({ name: z.string(), score: z.number() })).max(30),
  referencedWorks: z.array(z.string()).max(1000),
});

export const libraryRoutes: FastifyPluginAsync = async (app) => {
  const { db, jobs } = app;
  const inLibrary = async (uid: number, paperId: number) =>
    (await db.query("SELECT 1 FROM library WHERE user_id = $1 AND paper_id = $2", [uid, paperId])).rows.length > 0;

  app.get("/health", async () => {
    const mlStatus = await ml.health().then(() => "ok").catch(() => "unavailable");
    await db.query("SELECT 1");
    return { status: "ok", db: db.kind, ml: mlStatus, llm: llmEnabled() ? config.OPENROUTER_MODEL : null };
  });

  app.get("/sources", async () => ({ sources: availableSources() }));

  app.get("/discover", async (req) => {
    const uid = userId(req);
    const q = z.object({
      q: z.string().trim().min(2).max(300),
      sources: z.string().default("openalex,arxiv").transform((s) => {
        // unknown or retired source names are ignored rather than failing the search
        const list = s.split(",").map((x) => SourceName.safeParse(x.trim())).flatMap((r) => (r.success ? [r.data] : []));
        return list.length ? list : SourceName.options;
      }),
      limit: z.coerce.number().int().min(1).max(50).default(15),
      yearFrom: z.coerce.number().int().min(1900).max(2100).optional(),
      yearTo: z.coerce.number().int().min(1900).max(2100).optional(),
      oa: z.coerce.boolean().optional(),
    }).parse(req.query);
    const out = await discover({ q: q.q, sources: q.sources, limit: q.limit, yearFrom: q.yearFrom, yearTo: q.yearTo, openAccessOnly: q.oa });
    const ids = await Promise.all(out.results.map((p) => findExisting(db, p)));
    const mine = await Promise.all(ids.map((id) => (id ? inLibrary(uid, id).then((ok) => (ok ? id : null)) : null)));
    return { ...out, results: out.results.map((p, i) => ({ ...p, libraryId: mine[i] })) };
  });

  app.post("/papers/import", async (req) => {
    const uid = userId(req);
    const body = z.object({ papers: z.array(DiscoveredSchema).min(1).max(50), fulltext: z.boolean().default(true) }).parse(req.body);
    const out = [];
    let queued = 0;
    for (const p of body.papers as DiscoveredPaper[]) {
      const { id, created } = await upsertDiscovered(db, p);
      await db.query("INSERT INTO library (user_id, paper_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [uid, id]);
      const paper = await getPaper(db, id);
      // shared public papers are processed once: reuse an existing index unless more is needed
      const indexed = paper && (paper.status === "ready" || (paper.status === "metadata_only" && !body.fulltext));
      const busy = paper && (paper.status === "processing" || (paper.status === "queued" && !created));
      let jobId: number | null = null;
      if (!indexed && !busy) {
        jobId = await jobs.enqueue("ingest", { paperId: id, fulltext: body.fulltext, userId: uid }, uid);
        await db.query("UPDATE papers SET status = 'queued' WHERE id = $1 AND status <> 'processing'", [id]);
        queued++;
      }
      out.push({ paperId: id, created, jobId, reused: Boolean(indexed) });
    }
    if (!queued) await jobs.scheduleRefresh(uid); // nothing to ingest: refresh topics/graph now
    return { imported: out };
  });

  app.post("/papers/upload", async (req, reply) => {
    const uid = userId(req);
    const results = [];
    const dir = uploadsDir();
    await fs.mkdir(dir, { recursive: true });
    for await (const part of req.files()) {
      const buf = await part.toBuffer();
      if (buf.subarray(0, 4).toString("latin1") !== "%PDF") {
        results.push({ file: part.filename, error: "not a PDF" });
        continue;
      }
      const title = path.basename(part.filename, path.extname(part.filename)).replace(/[_-]+/g, " ").trim().slice(0, 300) || "Uploaded paper";
      // private: owner_id set, never de-duplicated with other users' papers
      const { rows } = await db.query<{ id: number }>(
        "INSERT INTO papers (source, title, is_open_access, status, owner_id) VALUES ('upload', $1, FALSE, 'queued', $2) RETURNING id", [title, uid]);
      const id = Number(rows[0].id);
      await db.query("INSERT INTO library (user_id, paper_id) VALUES ($1, $2)", [uid, id]);
      const file = path.join(dir, `${id}-${crypto.randomBytes(8).toString("hex")}.pdf`);
      await fs.writeFile(file, buf);
      const jobId = await jobs.enqueue("ingest", { paperId: id, uploadPath: file, userId: uid }, uid);
      results.push({ file: part.filename, paperId: id, jobId });
    }
    if (!results.length) return reply.status(400).send({ error: "Attach at least one PDF." });
    return { uploaded: results };
  });

  app.get("/papers", async (req) => {
    const uid = userId(req);
    const q = z.object({
      q: z.string().trim().max(200).optional(), status: z.string().max(20).optional(),
      clusterId: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(500).default(50),
      offset: z.coerce.number().int().min(0).default(0), sort: z.enum(["recent", "year", "citations", "title"]).default("recent"),
    }).parse(req.query);
    const where: string[] = ["l.user_id = $1"];
    const params: unknown[] = [uid];
    const add = (cond: string, v: unknown) => { params.push(v); where.push(cond.replace("?", `$${params.length}`)); };
    if (q.q) add("p.tsv @@ websearch_to_tsquery('english', ?)", q.q);
    if (q.status) add("p.status = ?", q.status);
    if (q.clusterId) add("p.id IN (SELECT paper_id FROM paper_clusters WHERE cluster_id = ?)", q.clusterId);
    const order = { recent: "l.added_at DESC", year: "p.year DESC NULLS LAST", citations: "p.citation_count DESC", title: "p.title" }[q.sort];
    const w = `FROM papers p JOIN library l ON l.paper_id = p.id WHERE ${where.join(" AND ")}`;
    const { rows } = await db.query(
      `SELECT p.id, p.source, p.doi, p.arxiv_id, p.title, p.abstract, p.year, p.venue, p.url, p.pdf_url, p.citation_count,
         p.status, p.status_detail, p.has_fulltext, p.page_count, l.added_at::text AS created_at,
         (SELECT string_agg(a.name, ', ' ORDER BY pa.position) FROM paper_authors pa JOIN authors a ON a.id = pa.author_id WHERE pa.paper_id = p.id AND pa.position < 4) AS authors,
         (SELECT count(*)::int FROM chunks c WHERE c.paper_id = p.id) AS chunks
       ${w} ORDER BY ${order} LIMIT ${q.limit} OFFSET ${q.offset}`, params);
    const { rows: total } = await db.query<{ n: number }>(`SELECT count(*)::int AS n ${w}`, params);
    return { papers: rows, total: Number(total[0].n) };
  });

  app.get("/papers/:id", async (req, reply) => {
    const uid = userId(req);
    const { id } = Id.parse(req.params);
    if (!(await inLibrary(uid, id))) return reply.status(404).send({ error: "Paper not found" });
    const paper = await getPaper(db, id);
    if (!paper) return reply.status(404).send({ error: "Paper not found" });
    const LIB = "SELECT paper_id FROM library WHERE user_id = $2";
    const [authors, entities, claims, sections, cluster, citesOut, citesIn] = await Promise.all([
      db.query("SELECT a.id, a.name, a.orcid FROM paper_authors pa JOIN authors a ON a.id = pa.author_id WHERE pa.paper_id = $1 ORDER BY pa.position", [id]),
      db.query(`SELECT e.id, e.type, e.name, pe.mentions, pe.source, pe.score, pe.evidence FROM paper_entities pe JOIN entities e ON e.id = pe.entity_id
                WHERE pe.paper_id = $1 ORDER BY e.type, pe.mentions DESC`, [id]),
      db.query("SELECT id, kind, text, page, polarity FROM claims WHERE paper_id = $1 ORDER BY kind, id", [id]),
      db.query(`SELECT section, kind, min(page_start) AS page, count(*)::int AS chunks FROM chunks WHERE paper_id = $1
                GROUP BY section, kind ORDER BY min(ord)`, [id]),
      db.query(`SELECT c.id, c.name FROM paper_clusters pc JOIN clusters c ON c.id = pc.cluster_id
                JOIN cluster_runs r ON r.id = pc.run_id AND r.is_active AND r.user_id = $2 WHERE pc.paper_id = $1`, [id, uid]),
      db.query(`SELECT p.id, p.title, p.year FROM citations c JOIN papers p ON p.id = c.cited_id WHERE c.citing_id = $1 AND p.id IN (${LIB})`, [id, uid]),
      db.query(`SELECT p.id, p.title, p.year FROM citations c JOIN papers p ON p.id = c.citing_id WHERE c.cited_id = $1 AND p.id IN (${LIB})`, [id, uid]),
    ]);
    return { paper, authors: authors.rows, entities: entities.rows, claims: claims.rows, sections: sections.rows,
      cluster: cluster.rows[0] ?? null, references: citesOut.rows, citedBy: citesIn.rows };
  });

  /** Removes the paper from *your* library. The shared index is deleted only when nobody else uses it. */
  app.delete("/papers/:id", async (req) => {
    const uid = userId(req);
    const { id } = Id.parse(req.params);
    await db.query("DELETE FROM library WHERE user_id = $1 AND paper_id = $2", [uid, id]);
    await db.query("DELETE FROM papers WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM library WHERE paper_id = $1)", [id]);
    await jobs.scheduleRefresh(uid);
    return { removed: id };
  });

  app.post("/papers/:id/reingest", async (req, reply) => {
    const uid = userId(req);
    const { id } = Id.parse(req.params);
    if (!(await inLibrary(uid, id))) return reply.status(404).send({ error: "Paper not found" });
    return { jobId: await jobs.enqueue("ingest", { paperId: id, userId: uid }, uid) };
  });

  app.get("/jobs", async (req) => ({ jobs: await jobs.list(userId(req), 60) }));
  app.get("/jobs/:id", async (req, reply) => {
    const job = await jobs.get(Id.parse(req.params).id, userId(req));
    return job ?? reply.status(404).send({ error: "Job not found" });
  });
};
