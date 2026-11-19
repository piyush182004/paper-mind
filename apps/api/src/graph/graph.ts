/**
 * Knowledge graph per user library: stored relationally (papers, authors, entities, typed edge tables),
 * loaded into graphology for algorithms, cached back into `graph_metrics` (keyed by user).
 *
 * Nodes: paper | author | concept | method | model | dataset | metric | task
 * Edges: AUTHORED_BY, MENTIONS (weighted by mention count), CITES, SIMILAR_TO (embedding kNN, cos >= 0.75)
 * Metrics: PageRank, Louvain communities, betweenness centrality (exact up to ~2.5k nodes), degree.
 */
import type { Db } from "../db/client.js";
import { betweenness, Graph, type GraphInstance, louvain, pagerank } from "./libs.js";

export type NodeType = "paper" | "author" | "concept" | "method" | "model" | "dataset" | "metric" | "task";
export interface GNode { key: string; type: NodeType; label: string; year?: number | null; citations?: number; clusterId?: number | null }
export interface GEdge { source: string; target: string; type: "AUTHORED_BY" | "MENTIONS" | "CITES" | "SIMILAR_TO"; weight: number }

const LIB = "SELECT paper_id FROM library WHERE user_id = $1";

export async function loadGraph(db: Db, userId: number, opts: { types?: NodeType[]; similarity?: boolean } = {}): Promise<{ nodes: GNode[]; edges: GEdge[] }> {
  const want = new Set<NodeType>(opts.types ?? ["paper", "author", "concept", "method", "model", "dataset", "task"]);
  const nodes: GNode[] = [];
  const edges: GEdge[] = [];

  const { rows: papers } = await db.query<{ id: number; title: string; year: number | null; citation_count: number; cluster_id: number | null }>(
    `SELECT p.id, p.title, p.year, p.citation_count,
       (SELECT pc.cluster_id FROM paper_clusters pc JOIN cluster_runs r ON r.id = pc.run_id AND r.is_active AND r.user_id = $1
         WHERE pc.paper_id = p.id) AS cluster_id
     FROM papers p WHERE p.status IN ('ready', 'metadata_only') AND p.id IN (${LIB})`, [userId]);
  for (const p of papers)
    nodes.push({ key: `paper:${p.id}`, type: "paper", label: p.title, year: p.year, citations: p.citation_count, clusterId: p.cluster_id ? Number(p.cluster_id) : null });

  const { rows: cites } = await db.query<{ citing_id: number; cited_id: number }>(
    `SELECT citing_id, cited_id FROM citations WHERE citing_id IN (${LIB}) AND cited_id IN (${LIB})`, [userId]);
  for (const c of cites) edges.push({ source: `paper:${c.citing_id}`, target: `paper:${c.cited_id}`, type: "CITES", weight: 2 });

  if (want.has("author")) {
    // only authors with >= 2 papers in this library connect anything; singletons are clutter
    const { rows } = await db.query<{ id: number; name: string; paper_id: number }>(
      `WITH lp AS (${LIB}),
       multi AS (SELECT author_id FROM paper_authors WHERE paper_id IN (SELECT paper_id FROM lp) GROUP BY author_id HAVING count(*) >= 2)
       SELECT a.id, a.name, pa.paper_id FROM authors a JOIN paper_authors pa ON pa.author_id = a.id
       WHERE a.id IN (SELECT author_id FROM multi) AND pa.paper_id IN (SELECT paper_id FROM lp)`, [userId]);
    const seen = new Set<number>();
    for (const r of rows) {
      if (!seen.has(r.id)) nodes.push({ key: `author:${r.id}`, type: "author", label: r.name });
      seen.add(r.id);
      edges.push({ source: `paper:${r.paper_id}`, target: `author:${r.id}`, type: "AUTHORED_BY", weight: 1 });
    }
  }

  const entityTypes = [...want].filter((t) => t !== "paper" && t !== "author");
  if (entityTypes.length) {
    const { rows } = await db.query<{ id: number; type: NodeType; name: string; paper_id: number; mentions: number }>(
      `SELECT e.id, e.type, e.name, pe.paper_id, pe.mentions FROM entities e JOIN paper_entities pe ON pe.entity_id = e.id
       WHERE e.type = ANY($2::text[]) AND (pe.source = 'openalex' OR pe.mentions >= 2) AND pe.paper_id IN (${LIB})`,
      [userId, entityTypes]);
    const seen = new Set<string>();
    for (const r of rows) {
      const key = `${r.type}:${r.id}`;
      if (!seen.has(key)) nodes.push({ key, type: r.type, label: r.name });
      seen.add(key);
      edges.push({ source: `paper:${r.paper_id}`, target: key, type: "MENTIONS", weight: Math.min(5, 1 + Math.log1p(r.mentions)) });
    }
  }

  if (opts.similarity !== false) {
    const { rows } = await db.query<{ a: number; b: number; sim: number }>(
      `SELECT p.id AS a, n.id AS b, n.sim FROM papers p
       CROSS JOIN LATERAL (SELECT q.id, (1 - (q.embedding <=> p.embedding))::float8 AS sim FROM papers q
         WHERE q.id <> p.id AND q.embedding IS NOT NULL AND q.id IN (${LIB}) ORDER BY q.embedding <=> p.embedding LIMIT 3) n
       WHERE p.embedding IS NOT NULL AND p.id IN (${LIB}) AND n.sim >= 0.75 AND p.id < n.id`, [userId]);
    for (const r of rows) edges.push({ source: `paper:${r.a}`, target: `paper:${r.b}`, type: "SIMILAR_TO", weight: Number(r.sim) });
  }
  return { nodes, edges };
}

export function toGraphology(nodes: GNode[], edges: GEdge[]): GraphInstance {
  const g = new Graph({ type: "undirected", multi: false, allowSelfLoops: false });
  for (const n of nodes) g.mergeNode(n.key, n);
  for (const e of edges) {
    if (!g.hasNode(e.source) || !g.hasNode(e.target) || e.source === e.target) continue;
    if (g.hasEdge(e.source, e.target)) g.updateEdgeAttribute(e.source, e.target, "weight", (w: number) => (w ?? 0) + e.weight);
    else g.addEdge(e.source, e.target, { type: e.type, weight: e.weight });
  }
  return g;
}

/** Run PageRank, Louvain and betweenness over the user's graph and cache the results. */
export async function recomputeGraphMetrics(db: Db, userId: number): Promise<{ nodes: number; edges: number; communities: number; betweenness: boolean }> {
  const { nodes, edges } = await loadGraph(db, userId, { types: ["paper", "author", "concept", "method", "model", "dataset", "task"] });
  const g = toGraphology(nodes, edges);
  await db.query("DELETE FROM graph_metrics WHERE user_id = $1", [userId]);
  if (g.order === 0) return { nodes: 0, edges: 0, communities: 0, betweenness: false };
  const pr = pagerank(g, { getEdgeWeight: "weight", alpha: 0.85, tolerance: 1e-6, maxIterations: 200 });
  const comm: Record<string, number> = g.size > 0 ? louvain(g, { getEdgeWeight: "weight", resolution: 1 }) : {};
  const doBetweenness = g.order <= 2500; // exact Brandes is O(V·E): bounded for responsiveness
  const bc = doBetweenness ? betweenness(g, { normalized: true }) : null;
  const keys = g.nodes();
  for (let i = 0; i < keys.length; i += 5000) {
    const part = keys.slice(i, i + 5000);
    await db.query(
      `INSERT INTO graph_metrics (user_id, node_key, node_type, pagerank, betweenness, degree, community)
       SELECT $1, * FROM unnest($2::text[], $3::text[], $4::real[], $5::real[], $6::int[], $7::int[])`,
      [userId, part, part.map((k) => g.getNodeAttribute(k, "type")), part.map((k) => pr[k] ?? 0), part.map((k) => (bc ? bc[k] ?? 0 : null)),
        part.map((k) => g.degree(k)), part.map((k) => comm[k] ?? 0)],
    );
  }
  return { nodes: g.order, edges: g.size, communities: new Set(Object.values(comm)).size, betweenness: doBetweenness };
}

/** Graph view for the UI: top nodes by PageRank, with their metrics and the edges among them. */
export async function graphView(db: Db, userId: number, opts: { types?: NodeType[]; limit?: number; clusterId?: number; focus?: string }) {
  const { nodes, edges } = await loadGraph(db, userId, { types: opts.types });
  const { rows: metrics } = await db.query<{ node_key: string; pagerank: number; betweenness: number | null; degree: number; community: number }>(
    "SELECT node_key, pagerank, betweenness, degree, community FROM graph_metrics WHERE user_id = $1", [userId]);
  const m = new Map(metrics.map((r) => [r.node_key, r]));
  let keep = nodes;
  if (opts.clusterId) {
    const inCluster = new Set(nodes.filter((n) => n.type === "paper" && n.clusterId === opts.clusterId).map((n) => n.key));
    const linked = new Set(edges.filter((e) => inCluster.has(e.source)).map((e) => e.target));
    keep = nodes.filter((n) => inCluster.has(n.key) || linked.has(n.key));
  }
  if (opts.focus) {
    const nb = new Set([opts.focus]);
    for (const e of edges) {
      if (e.source === opts.focus) nb.add(e.target);
      if (e.target === opts.focus) nb.add(e.source);
    }
    keep = keep.filter((n) => nb.has(n.key));
  }
  // drop entities connected to a single paper: they add clutter, not connections
  const degree = new Map<string, number>();
  for (const e of edges) degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  keep = keep.filter((n) => n.type === "paper" || (degree.get(n.key) ?? 0) >= 2 || opts.focus);
  const limit = Math.min(opts.limit ?? 150, 1500);
  keep = keep
    .map((n) => ({ ...n, pagerank: Number(m.get(n.key)?.pagerank ?? 0), betweenness: m.get(n.key)?.betweenness ?? null,
      degree: Number(m.get(n.key)?.degree ?? 0), community: Number(m.get(n.key)?.community ?? 0) }))
    .sort((a, b) => Number(b.type === "paper") - Number(a.type === "paper") || b.pagerank - a.pagerank)
    .slice(0, limit);
  const keys = new Set(keep.map((n) => n.key));
  return { nodes: keep, edges: edges.filter((e) => keys.has(e.source) && keys.has(e.target)), metricsComputed: metrics.length > 0 };
}
