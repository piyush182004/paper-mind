/** Clustering runs: paper vectors -> ML service (UMAP + HDBSCAN | K-Means + c-TF-IDF) -> relational storage. */
import type { Db } from "../db/client.js";
import { parseVec } from "../db/client.js";
import { ml } from "../ml/client.js";

export interface ClusterRunSummary {
  runId: number;
  algorithm: string;
  papers: number;
  clusters: number;
  noise: number;
  silhouette: number | null;
}

export async function runClustering(db: Db, userId: number, opts: { algorithm: "hdbscan" | "kmeans"; minClusterSize?: number; k?: number }): Promise<ClusterRunSummary> {
  const { rows } = await db.query<{ id: number; title: string; abstract: string | null; embedding: string; concepts: string | null }>(
    `SELECT p.id, p.title, p.abstract, p.embedding::text AS embedding,
       (SELECT string_agg(e.name, ' ') FROM paper_entities pe JOIN entities e ON e.id = pe.entity_id
         WHERE pe.paper_id = p.id AND e.type <> 'metric') AS concepts
     FROM papers p WHERE p.embedding IS NOT NULL AND p.id IN (SELECT paper_id FROM library WHERE user_id = $1) ORDER BY p.id`,
    [userId],
  );
  if (rows.length < 3) {
    // too few papers for topics: retire the old grouping instead of showing stale topics
    await db.query("UPDATE cluster_runs SET is_active = FALSE WHERE is_active AND user_id = $1", [userId]);
    return { runId: 0, algorithm: opts.algorithm, papers: rows.length, clusters: 0, noise: 0, silhouette: null };
  }

  const out = await ml.cluster(
    rows.map((r) => Array.from(parseVec(r.embedding))),
    rows.map((r) => `${r.title}. ${r.abstract ?? ""} ${r.concepts ?? ""}`),
    opts.algorithm,
    { minClusterSize: opts.minClusterSize, k: opts.k },
  );

  return db.tx(async (t) => {
    await t.query("UPDATE cluster_runs SET is_active = FALSE WHERE is_active AND user_id = $1", [userId]);
    const { rows: run } = await t.query<{ id: number }>(
      `INSERT INTO cluster_runs (algorithm, params, n_papers, n_clusters, n_noise, silhouette, is_active, user_id)
       VALUES ($1, $2::jsonb, $3, $4, $5, $6, TRUE, $7) RETURNING id`,
      [out.algorithm, JSON.stringify(out.params), rows.length, out.clusters.length, out.n_noise, out.silhouette, userId],
    );
    const runId = Number(run[0].id);

    const parentIds = new Map<number, number>();
    for (const p of out.parents) {
      const { rows: r } = await t.query<{ id: number }>(
        `INSERT INTO clusters (run_id, label, level, name, keywords, size) VALUES ($1, $2, 1, $3, $4::jsonb, $5) RETURNING id`,
        [runId, p.label, p.name, JSON.stringify(p.keywords), p.size],
      );
      parentIds.set(p.label, Number(r[0].id));
    }
    const clusterIds = new Map<number, number>();
    for (const c of out.clusters) {
      const { rows: r } = await t.query<{ id: number }>(
        `INSERT INTO clusters (run_id, label, parent_id, level, name, keywords, size, coherence)
         VALUES ($1, $2, $3, 0, $4, $5::jsonb, $6, $7) RETURNING id`,
        [runId, c.label, c.parent != null ? parentIds.get(c.parent) ?? null : null, c.name, JSON.stringify(c.keywords), c.size, c.coherence],
      );
      clusterIds.set(c.label, Number(r[0].id));
    }
    await t.query(
      `INSERT INTO paper_clusters (run_id, paper_id, cluster_id, probability, outlier_score, x, y)
       SELECT $1, x.pid, x.cid, x.prob, x.outl, x.px, x.py
       FROM unnest($2::bigint[], $3::bigint[], $4::real[], $5::real[], $6::real[], $7::real[]) AS x(pid, cid, prob, outl, px, py)
       WHERE x.pid IN (SELECT paper_id FROM library WHERE user_id = $8)`,
      [runId, rows.map((r) => Number(r.id)), out.labels.map((l) => (l >= 0 ? clusterIds.get(l) ?? null : null)),
        out.probabilities, out.outlier_scores, out.xy.map((p) => p[0]), out.xy.map((p) => p[1]), userId],
    );
    return { runId, algorithm: out.algorithm, papers: rows.length, clusters: out.clusters.length, noise: out.n_noise, silhouette: out.silhouette };
  });
}

export async function activeClusters(db: Db, userId: number) {
  const { rows: runs } = await db.query<{ id: number; algorithm: string; params: unknown; n_papers: number; n_clusters: number; n_noise: number; silhouette: number | null; created_at: string }>(
    "SELECT id, algorithm, params, n_papers, n_clusters, n_noise, silhouette, created_at::text FROM cluster_runs WHERE is_active AND user_id = $1 ORDER BY id DESC LIMIT 1",
    [userId],
  );
  const run = runs[0];
  if (!run) return { run: null, clusters: [], parents: [], points: [] };
  const runId = Number(run.id);
  const { rows: clusters } = await db.query(
    `SELECT c.id, c.label, c.parent_id, c.level, c.name, c.keywords,
       CASE WHEN c.level = 0 THEN (SELECT count(*)::int FROM paper_clusters pc WHERE pc.cluster_id = c.id) ELSE c.size END AS size, c.coherence,
       (SELECT round(avg(p.year)) FROM paper_clusters pc JOIN papers p ON p.id = pc.paper_id WHERE pc.cluster_id = c.id) AS mean_year
     FROM clusters c WHERE c.run_id = $1 ORDER BY c.level DESC, c.size DESC`,
    [runId],
  );
  const { rows: points } = await db.query(
    `SELECT pc.paper_id, p.title, p.year, p.citation_count, pc.cluster_id, pc.probability, pc.outlier_score, pc.x, pc.y
     FROM paper_clusters pc JOIN papers p ON p.id = pc.paper_id WHERE pc.run_id = $1`,
    [runId],
  );
  return {
    run: { ...run, id: runId },
    clusters: clusters.filter((c) => Number(c.level) === 0),
    parents: clusters.filter((c) => Number(c.level) === 1),
    points,
  };
}
