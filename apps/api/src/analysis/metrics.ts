/**
 * Research analytics over one user's library, with explainable normalised components (0..1). No LLM involved.
 *
 *  citation_impact  ln(1 + citations / age) / library max          (age-normalised impact)
 *  graph_influence  PageRank / library max                          (knowledge-graph centrality)
 *  novelty          min cosine distance to earlier papers / max     (how far it moved from prior work)
 *  centrality       cosine to its topic centroid                    (how representative of its topic)
 *  composite        weighted mean of the available components (weights returned with every score)
 */
import type { Db } from "../db/client.js";

export const WEIGHTS = { citation_impact: 0.3, graph_influence: 0.3, novelty: 0.2, centrality: 0.2 } as const;
const LIB = "SELECT paper_id FROM library WHERE user_id = $1";

export function slope(points: [number, number][]): number {
  const n = points.length;
  if (n < 2) return 0;
  const mx = points.reduce((s, p) => s + p[0], 0) / n;
  const my = points.reduce((s, p) => s + p[1], 0) / n;
  const num = points.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0);
  const den = points.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
  return den ? num / den : 0;
}

export async function libraryOverview(db: Db, userId: number) {
  const q = async <T>(sql: string) => (await db.query<T>(sql, [userId])).rows;
  const [counts] = await q<Record<string, number>>(`WITH lp AS (${LIB}) SELECT
      (SELECT count(*)::int FROM lp) AS papers,
      (SELECT count(*)::int FROM papers WHERE has_fulltext AND id IN (SELECT paper_id FROM lp)) AS fulltext,
      (SELECT count(*)::int FROM papers WHERE status IN ('queued','processing') AND id IN (SELECT paper_id FROM lp)) AS processing,
      (SELECT count(*)::int FROM papers WHERE status = 'failed' AND id IN (SELECT paper_id FROM lp)) AS failed,
      (SELECT count(*)::int FROM chunks WHERE paper_id IN (SELECT paper_id FROM lp)) AS chunks,
      (SELECT count(*)::int FROM chunk_terms ct JOIN chunks c ON c.id = ct.chunk_id WHERE c.paper_id IN (SELECT paper_id FROM lp)) AS postings,
      (SELECT count(DISTINCT author_id)::int FROM paper_authors WHERE paper_id IN (SELECT paper_id FROM lp)) AS authors,
      (SELECT count(DISTINCT entity_id)::int FROM paper_entities WHERE paper_id IN (SELECT paper_id FROM lp)) AS entities,
      (SELECT count(*)::int FROM claims WHERE paper_id IN (SELECT paper_id FROM lp)) AS claims,
      (SELECT count(*)::int FROM citations WHERE citing_id IN (SELECT paper_id FROM lp) AND cited_id IN (SELECT paper_id FROM lp)) AS citations,
      (SELECT coalesce(sum(page_count), 0)::int FROM papers WHERE id IN (SELECT paper_id FROM lp)) AS pages`);
  const byType = await q<{ type: string; n: number }>(`SELECT e.type, count(DISTINCT e.id)::int AS n FROM entities e JOIN paper_entities pe ON pe.entity_id = e.id
    WHERE pe.paper_id IN (${LIB}) GROUP BY e.type ORDER BY n DESC`);
  const claimKinds = await q<{ kind: string; n: number }>(`SELECT kind, count(*)::int AS n FROM claims WHERE paper_id IN (${LIB}) GROUP BY kind`);
  const chunkKinds = await q<{ kind: string; n: number }>(`SELECT kind, count(*)::int AS n FROM chunks WHERE paper_id IN (${LIB}) GROUP BY kind`);
  const years = await q<{ year: number; n: number }>(`SELECT year, count(*)::int AS n FROM papers WHERE year IS NOT NULL AND id IN (${LIB}) GROUP BY year ORDER BY year`);
  const topEntities = await q<{ type: string; name: string; papers: number }>(
    `SELECT e.type, e.name, count(*)::int AS papers FROM paper_entities pe JOIN entities e ON e.id = pe.entity_id
     WHERE e.type IN ('method','model','dataset','task') AND pe.paper_id IN (${LIB}) GROUP BY e.type, e.name ORDER BY papers DESC LIMIT 15`);
  return {
    ...counts,
    coverage: counts.papers ? +(counts.fulltext / counts.papers).toFixed(3) : 0, // share of papers with full text indexed
    entitiesByType: byType, claimsByKind: claimKinds, chunksByKind: chunkKinds, papersByYear: years, topEntities,
  };
}

export async function paperScores(db: Db, userId: number, opts: { limit?: number; clusterId?: number } = {}) {
  const { rows } = await db.query<{
    id: number; title: string; year: number | null; citation_count: number; cluster_id: number | null; cluster: string | null;
    impact: number | null; influence: number | null; novelty: number | null; centrality: number | null;
  }>(
    `WITH lp AS (${LIB}),
     active AS (SELECT id FROM cluster_runs WHERE is_active AND user_id = $1 LIMIT 1),
     base AS (
       SELECT p.id, p.title, p.year, p.citation_count, p.embedding,
              greatest(1, extract(year FROM now())::int - coalesce(p.year, extract(year FROM now())::int) + 1) AS age,
              pc.cluster_id
       FROM papers p LEFT JOIN paper_clusters pc ON pc.paper_id = p.id AND pc.run_id = (SELECT id FROM active)
       WHERE p.embedding IS NOT NULL AND p.id IN (SELECT paper_id FROM lp)),
     cent AS (SELECT b.cluster_id, avg(b.embedding) AS c FROM base b WHERE b.cluster_id IS NOT NULL GROUP BY b.cluster_id),
     nov AS (SELECT b.id, (SELECT min(q.embedding <=> b.embedding) FROM base q WHERE q.year IS NOT NULL AND q.year < b.year) AS d FROM base b),
     pr AS (SELECT substr(node_key, 7)::bigint AS id, pagerank FROM graph_metrics WHERE user_id = $1 AND node_type = 'paper')
     SELECT b.id, b.title, b.year, b.citation_count, b.cluster_id, cl.name AS cluster,
       ln(1 + b.citation_count::float8 / b.age) / nullif((SELECT max(ln(1 + citation_count::float8 / age)) FROM base), 0) AS impact,
       pr.pagerank / nullif((SELECT max(pagerank) FROM pr), 0) AS influence,
       nov.d / nullif((SELECT max(d) FROM nov), 0) AS novelty,
       CASE WHEN cent.c IS NULL THEN NULL ELSE 1 - (b.embedding <=> cent.c) END AS centrality
     FROM base b LEFT JOIN cent ON cent.cluster_id = b.cluster_id LEFT JOIN nov ON nov.id = b.id
       LEFT JOIN pr ON pr.id = b.id LEFT JOIN clusters cl ON cl.id = b.cluster_id
     ${opts.clusterId ? "WHERE b.cluster_id = $2" : ""}`,
    opts.clusterId ? [userId, opts.clusterId] : [userId],
  );
  const scored = rows.map((r) => {
    const comps = { citation_impact: r.impact, graph_influence: r.influence, novelty: r.novelty, centrality: r.centrality } as Record<keyof typeof WEIGHTS, number | null>;
    let wsum = 0, total = 0;
    for (const [k, w] of Object.entries(WEIGHTS) as [keyof typeof WEIGHTS, number][]) {
      const v = comps[k];
      if (v == null || Number.isNaN(Number(v))) continue;
      total += w * Number(v);
      wsum += w;
    }
    const round = (v: number | null) => (v == null ? null : +Number(v).toFixed(3));
    return {
      id: Number(r.id), title: r.title, year: r.year, citations: r.citation_count, clusterId: r.cluster_id ? Number(r.cluster_id) : null, cluster: r.cluster,
      composite: wsum ? +(total / wsum).toFixed(3) : 0,
      components: Object.fromEntries(Object.entries(comps).map(([k, v]) => [k, round(v)])),
      weights: WEIGHTS,
      missing: Object.entries(comps).filter(([, v]) => v == null).map(([k]) => k), // e.g. novelty needs earlier papers
    };
  });
  return scored.sort((a, b) => b.composite - a.composite).slice(0, opts.limit ?? 100);
}

export async function clusterMetrics(db: Db, userId: number) {
  const { rows } = await db.query<{ id: number; name: string; size: number; coherence: number | null; parent: string | null; year: number | null; n: number; fulltext: number; citations: number }>(
    `SELECT c.id, c.name, c.size, c.coherence, par.name AS parent, p.year, count(*)::int AS n,
       sum(CASE WHEN p.has_fulltext THEN 1 ELSE 0 END)::int AS fulltext, sum(p.citation_count)::int AS citations
     FROM clusters c JOIN cluster_runs r ON r.id = c.run_id AND r.is_active AND r.user_id = $1
     LEFT JOIN clusters par ON par.id = c.parent_id
     JOIN paper_clusters pc ON pc.cluster_id = c.id JOIN papers p ON p.id = pc.paper_id
     WHERE c.level = 0 GROUP BY c.id, c.name, c.size, c.coherence, par.name, p.year`, [userId]);
  const byCluster = new Map<number, { id: number; name: string; parent: string | null; size: number; coherence: number | null; years: Record<number, number>; fulltext: number; citations: number }>();
  for (const r of rows) {
    const id = Number(r.id);
    const c = byCluster.get(id) ?? { id, name: r.name, parent: r.parent, size: Number(r.size), coherence: r.coherence, years: {}, fulltext: 0, citations: 0 };
    if (r.year) c.years[r.year] = (c.years[r.year] ?? 0) + Number(r.n);
    c.fulltext += Number(r.fulltext);
    c.citations += Number(r.citations);
    byCluster.set(id, c);
  }
  const thisYear = new Date().getFullYear();
  return [...byCluster.values()].map((c) => {
    const recent = Array.from({ length: 6 }, (_, i) => thisYear - 5 + i).map((y) => [y, c.years[y] ?? 0] as [number, number]);
    return {
      ...c,
      coverage: +(c.fulltext / Math.max(1, c.size)).toFixed(3),
      growth: +slope(recent).toFixed(3),            // papers/year trend over the last 6 years
      recentShare: +(recent.slice(-2).reduce((s, p) => s + p[1], 0) / Math.max(1, c.size)).toFixed(3),
    };
  }).sort((a, b) => b.size - a.size);
}
