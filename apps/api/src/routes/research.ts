/** Search, clustering, knowledge graph, analytics and research-intelligence endpoints. */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { hybridSearch } from "../search/hybrid.js";
import { activeClusters } from "../analysis/clustering.js";
import { graphView, type NodeType } from "../graph/graph.js";
import { clusterMetrics, libraryOverview, paperScores } from "../analysis/metrics.js";
import { comparePapers, contradictions, gaps, trends } from "../analysis/intelligence.js";
import { userId } from "../auth.js";

const Kinds = z.enum(["abstract", "text", "table", "figure", "equation"]);
const NodeTypes = z.enum(["paper", "author", "concept", "method", "model", "dataset", "metric", "task"]);

export const researchRoutes: FastifyPluginAsync = async (app) => {
  const { db, jobs } = app;

  app.post("/search", async (req) => {
    const b = z.object({
      query: z.string().trim().min(2).max(500),
      filters: z.object({
        yearFrom: z.number().int().optional(), yearTo: z.number().int().optional(), venue: z.string().max(200).optional(),
        author: z.string().max(200).optional(), clusterId: z.number().int().optional(), entityId: z.number().int().optional(),
        paperIds: z.array(z.number().int()).max(200).optional(), kinds: z.array(Kinds).optional(), fulltextOnly: z.boolean().optional(),
      }).default({}),
      options: z.object({
        k: z.number().int().min(1).max(50).default(10), rerank: z.boolean().default(true), hierarchical: z.boolean().default(true),
        graph: z.boolean().default(true), context: z.boolean().default(true), maxPerPaper: z.number().int().min(1).max(10).default(3),
      }).default({ k: 10, rerank: true, hierarchical: true, graph: true, context: true, maxPerPaper: 3 }),
    }).parse(req.body);
    return hybridSearch(db, b.query, { ...b.filters, userId: userId(req) }, b.options);
  });

  // ---- clustering
  app.get("/clusters", async (req) => activeClusters(db, userId(req)));
  app.get("/clusters/metrics", async (req) => ({ clusters: await clusterMetrics(db, userId(req)) }));
  app.post("/clusters/run", async (req) => {
    const b = z.object({
      algorithm: z.enum(["hdbscan", "kmeans"]).default("hdbscan"),
      minClusterSize: z.number().int().min(2).max(200).optional(), k: z.number().int().min(2).max(60).optional(),
    }).parse(req.body ?? {});
    const uid = userId(req);
    return { jobId: await jobs.enqueue("cluster", { ...b, userId: uid }, uid) };
  });

  // ---- knowledge graph
  app.get("/graph", async (req) => {
    const q = z.object({
      types: z.string().optional().transform((s) => (s ? s.split(",").map((t) => NodeTypes.parse(t.trim())) : undefined)),
      limit: z.coerce.number().int().min(10).max(1500).default(250),
      clusterId: z.coerce.number().int().optional(),
      focus: z.string().regex(/^[a-z]+:\d+$/).optional(),
    }).parse(req.query);
    return graphView(db, userId(req), { types: q.types as NodeType[] | undefined, limit: q.limit, clusterId: q.clusterId, focus: q.focus });
  });
  app.post("/graph/recompute", async (req) => {
    const uid = userId(req);
    return { jobId: await jobs.enqueue("graph", { userId: uid }, uid) };
  });
  app.get("/graph/node/:key", async (req, reply) => {
    const { key } = z.object({ key: z.string().regex(/^[a-z]+:\d+$/) }).parse(req.params);
    const [type, idStr] = key.split(":");
    const id = Number(idStr);
    const uid = userId(req);
    const LIB = "SELECT paper_id FROM library WHERE user_id = $2";
    const metrics = (await db.query("SELECT pagerank, betweenness, degree, community FROM graph_metrics WHERE node_key = $1 AND user_id = $2", [key, uid])).rows[0] ?? null;
    if (type === "paper") {
      const { rows } = await db.query(`SELECT id, title, year, venue, citation_count FROM papers WHERE id = $1 AND id IN (${LIB})`, [id, uid]);
      return rows[0] ? { key, type, ...rows[0], metrics } : reply.status(404).send({ error: "Not found" });
    }
    if (type === "author") {
      const { rows } = await db.query(
        `SELECT a.name, json_agg(json_build_object('id', p.id, 'title', p.title, 'year', p.year)) AS papers
         FROM authors a JOIN paper_authors pa ON pa.author_id = a.id JOIN papers p ON p.id = pa.paper_id WHERE a.id = $1 AND p.id IN (${LIB}) GROUP BY a.name`, [id, uid]);
      return rows[0] ? { key, type, ...rows[0], metrics } : reply.status(404).send({ error: "Not found" });
    }
    const { rows } = await db.query(
      `SELECT e.name, e.type, json_agg(json_build_object('id', p.id, 'title', p.title, 'year', p.year, 'mentions', pe.mentions, 'evidence', pe.evidence)
         ORDER BY pe.mentions DESC) AS papers
       FROM entities e JOIN paper_entities pe ON pe.entity_id = e.id JOIN papers p ON p.id = pe.paper_id WHERE e.id = $1 AND p.id IN (${LIB}) GROUP BY e.name, e.type`, [id, uid]);
    return rows[0] ? { key, ...rows[0], metrics } : reply.status(404).send({ error: "Not found" });
  });

  // ---- analytics & intelligence
  app.get("/analytics/overview", async (req) => libraryOverview(db, userId(req)));
  app.get("/analytics/papers", async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), clusterId: z.coerce.number().int().optional() }).parse(req.query);
    return { papers: await paperScores(db, userId(req), q) };
  });
  app.get("/intelligence/contradictions", async (req) => ({ contradictions: await contradictions(db, userId(req), 40) }));
  app.get("/intelligence/trends", async (req) => trends(db, userId(req)));
  app.get("/intelligence/gaps", async (req) => gaps(db, userId(req)));
  app.post("/intelligence/compare", async (req) => {
    const b = z.object({ paperIds: z.array(z.number().int()).min(2).max(6) }).parse(req.body);
    return comparePapers(db, userId(req), b.paperIds);
  });
};
