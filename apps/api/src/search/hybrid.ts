/**
 * Hybrid retrieval over the relational store:
 *
 *   lexical   exact Okapi BM25 in SQL over the chunk_terms inverted index (k1 = 1.2, b = 0.75)
 *   dense     pgvector HNSW cosine over chunk embeddings (BGE, query instruction prefix)
 *   hierarch. paper-level retrieval (paper vectors + Postgres full-text) -> chunk search inside the
 *             best papers ("coarse-to-fine")
 *   fusion    weighted Reciprocal Rank Fusion
 *   rerank    cross-encoder on the fused shortlist
 *   context   small-to-big: neighbouring chunks of every hit
 *   graph     GraphRAG expansion: papers linked to the hits by shared entities or citations
 *
 * Metadata filters (year, venue, author, cluster, entity, chunk kind, paper ids) apply to every
 * retriever. Every hit carries its component scores so ranking is explainable.
 */
import { config } from "../config.js";
import { type Db, vec } from "../db/client.js";
import { tokenize } from "../lib/text.js";
import { ml, MlUnavailableError } from "../ml/client.js";

export interface SearchFilters {
  /** Restrict to this user's library (always set by the API from the session, never from the client). */
  userId?: number;
  yearFrom?: number;
  yearTo?: number;
  venue?: string;
  author?: string;
  clusterId?: number;
  entityId?: number;
  paperIds?: number[];
  kinds?: ("abstract" | "text" | "table" | "figure" | "equation")[];
  fulltextOnly?: boolean;
}

export interface SearchOptions {
  k?: number;
  rerank?: boolean;
  hierarchical?: boolean;
  graph?: boolean;
  context?: boolean;
  maxPerPaper?: number;
}

export interface Hit {
  chunkId: number;
  paperId: number;
  title: string;
  year: number | null;
  venue: string | null;
  section: string | null;
  kind: string;
  pageStart: number | null;
  pageEnd: number | null;
  content: string;
  context?: { before: string | null; after: string | null };
  via: "retrieval" | "graph";
  graphReason?: string;
  scores: { bm25?: number; bm25Rank?: number; dense?: number; denseRank?: number; paperRank?: number; rrf: number; rerank?: number; final: number };
}

export interface SearchResult {
  query: string;
  hits: Hit[];
  degraded: string[]; // components that were unavailable (e.g. dense retrieval when the ML service is down)
  timings: Record<string, number>;
}

const RRF_K = 60;

function filterSql(f: SearchFilters, start: number): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  const add = (cond: string, val: unknown) => {
    params.push(val);
    parts.push(cond.replace("?", `$${start + params.length}`));
  };
  if (f.userId) add("p.id IN (SELECT paper_id FROM library WHERE user_id = ?)", f.userId);
  if (f.yearFrom) add("p.year >= ?", f.yearFrom);
  if (f.yearTo) add("p.year <= ?", f.yearTo);
  if (f.venue) add("p.venue ILIKE ?", `%${f.venue}%`);
  if (f.paperIds?.length) add("p.id = ANY(?::bigint[])", f.paperIds);
  if (f.kinds?.length) add("c.kind = ANY(?::text[])", f.kinds);
  if (f.clusterId) add("p.id IN (SELECT paper_id FROM paper_clusters WHERE cluster_id = ?)", f.clusterId);
  if (f.entityId) add("EXISTS (SELECT 1 FROM paper_entities pe WHERE pe.paper_id = p.id AND pe.entity_id = ?)", f.entityId);
  if (f.author)
    add("EXISTS (SELECT 1 FROM paper_authors pa JOIN authors a ON a.id = pa.author_id WHERE pa.paper_id = p.id AND a.name ILIKE ?)", `%${f.author}%`);
  if (f.fulltextOnly) parts.push("p.has_fulltext");
  return { sql: parts.length ? ` AND ${parts.join(" AND ")}` : "", params };
}

export async function bm25(db: Db, terms: string[], f: SearchFilters, limit: number): Promise<{ id: number; score: number }[]> {
  const uniq = [...new Set(terms)];
  if (!uniq.length) return [];
  const flt = filterSql(f, 1);
  const { rows } = await db.query<{ id: number; score: number }>(
    `WITH q AS (SELECT DISTINCT unnest($1::text[]) AS term),
          stats AS (SELECT count(*)::float8 AS n, greatest(avg(length), 1)::float8 AS avgdl FROM chunks),
          df AS (SELECT ct.term, count(*)::float8 AS df FROM chunk_terms ct JOIN q ON q.term = ct.term GROUP BY ct.term)
     SELECT ct.chunk_id AS id,
            sum(ln(1 + (stats.n - df.df + 0.5) / (df.df + 0.5)) * (ct.tf * 2.2) / (ct.tf + 1.2 * (0.25 + 0.75 * c.length / stats.avgdl)))::float8 AS score
     FROM chunk_terms ct JOIN df ON df.term = ct.term JOIN chunks c ON c.id = ct.chunk_id JOIN papers p ON p.id = c.paper_id CROSS JOIN stats
     WHERE true${flt.sql}
     GROUP BY ct.chunk_id ORDER BY score DESC LIMIT ${Math.floor(limit)}`,
    [uniq, ...flt.params],
  );
  return rows.map((r) => ({ id: Number(r.id), score: Number(r.score) }));
}

export async function dense(db: Db, qvec: number[], f: SearchFilters, limit: number): Promise<{ id: number; score: number }[]> {
  const flt = filterSql(f, 1);
  const { rows } = await db.query<{ id: number; score: number }>(
    `SELECT c.id, (1 - (c.embedding <=> $1::vector))::float8 AS score
     FROM chunks c JOIN papers p ON p.id = c.paper_id
     WHERE c.embedding IS NOT NULL${flt.sql}
     ORDER BY c.embedding <=> $1::vector LIMIT ${Math.floor(limit)}`,
    [vec(qvec), ...flt.params],
  );
  return rows.map((r) => ({ id: Number(r.id), score: Number(r.score) }));
}

/** Coarse stage: rank papers by abstract-level vectors and Postgres full-text, fused with RRF. */
export async function rankPapers(db: Db, query: string, qvec: number[] | null, f: SearchFilters, limit: number): Promise<number[]> {
  const flt = filterSql({ ...f, kinds: undefined }, 1);
  const rankings: number[][] = [];
  const fts = await db.query<{ id: number }>(
    `SELECT p.id FROM papers p WHERE p.tsv @@ websearch_to_tsquery('english', $1)${flt.sql}
     ORDER BY ts_rank_cd(p.tsv, websearch_to_tsquery('english', $1), 32) DESC LIMIT ${limit * 2}`,
    [query, ...flt.params],
  );
  rankings.push(fts.rows.map((r) => Number(r.id)));
  if (qvec) {
    const d = await db.query<{ id: number }>(
      `SELECT p.id FROM papers p WHERE p.embedding IS NOT NULL${flt.sql}
       ORDER BY p.embedding <=> $1::vector LIMIT ${limit * 2}`,
      [vec(qvec), ...flt.params],
    );
    rankings.push(d.rows.map((r) => Number(r.id)));
  }
  return [...rrf(rankings).entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => id);
}

export function rrf(rankings: number[][], weights?: number[]): Map<number, number> {
  const fused = new Map<number, number>();
  rankings.forEach((ranking, i) => {
    const w = weights?.[i] ?? 1;
    ranking.forEach((id, rank) => fused.set(id, (fused.get(id) ?? 0) + w / (RRF_K + rank + 1)));
  });
  return fused;
}

interface ChunkRow {
  id: number; paper_id: number; title: string; year: number | null; venue: string | null; section: string | null;
  kind: string; page_start: number | null; page_end: number | null; content: string; ord: number;
}

async function loadChunks(db: Db, ids: number[]): Promise<Map<number, ChunkRow>> {
  if (!ids.length) return new Map();
  const { rows } = await db.query<ChunkRow>(
    `SELECT c.id, c.paper_id, p.title, p.year, p.venue, c.section, c.kind, c.page_start, c.page_end, c.content, c.ord
     FROM chunks c JOIN papers p ON p.id = c.paper_id WHERE c.id = ANY($1::bigint[])`,
    [ids],
  );
  return new Map(rows.map((r) => [Number(r.id), { ...r, id: Number(r.id), paper_id: Number(r.paper_id) }]));
}

async function addContext(db: Db, hits: Hit[]): Promise<void> {
  if (!hits.length) return;
  const { rows } = await db.query<{ id: number; before: string | null; after: string | null }>(
    `SELECT c.id,
       (SELECT b.content FROM chunks b WHERE b.paper_id = c.paper_id AND b.ord = c.ord - 1 AND b.kind <> 'abstract') AS before,
       (SELECT a.content FROM chunks a WHERE a.paper_id = c.paper_id AND a.ord = c.ord + 1) AS after
     FROM chunks c WHERE c.id = ANY($1::bigint[])`,
    [hits.map((h) => h.chunkId)],
  );
  const m = new Map(rows.map((r) => [Number(r.id), r]));
  for (const h of hits) {
    const r = m.get(h.chunkId);
    if (r) h.context = { before: r.before, after: r.after };
  }
}

/** GraphRAG expansion: papers connected to the hits through shared entities or citation edges. */
async function graphExpand(db: Db, qvec: number[] | null, hits: Hit[], f: SearchFilters, limit: number): Promise<Hit[]> {
  const seeds = [...new Set(hits.slice(0, 5).map((h) => h.paperId))];
  if (!seeds.length || !qvec) return [];
  const { rows: related } = await db.query<{ paper_id: number; shared: string[]; cites: boolean }>(
    `WITH seed_entities AS (
        SELECT DISTINCT pe.entity_id FROM paper_entities pe JOIN entities e ON e.id = pe.entity_id
        WHERE pe.paper_id = ANY($1::bigint[]) AND e.type IN ('method','model','dataset','task') AND pe.mentions >= 2),
      entity_df AS (                          -- how many papers mention each entity (rarer = more informative)
        SELECT entity_id, count(*)::float8 AS df FROM paper_entities WHERE entity_id IN (SELECT entity_id FROM seed_entities)
        GROUP BY entity_id),
      via_entities AS (
        SELECT pe.paper_id, array_agg(e.name ORDER BY d.df) AS shared, sum(1.0 / ln(1 + d.df)) AS strength FROM paper_entities pe
        JOIN seed_entities s ON s.entity_id = pe.entity_id JOIN entities e ON e.id = pe.entity_id JOIN entity_df d ON d.entity_id = pe.entity_id
        WHERE NOT (pe.paper_id = ANY($1::bigint[])) GROUP BY pe.paper_id),
      via_citations AS (
        SELECT CASE WHEN citing_id = ANY($1::bigint[]) THEN cited_id ELSE citing_id END AS paper_id FROM citations
        WHERE (citing_id = ANY($1::bigint[]) OR cited_id = ANY($1::bigint[])))
     SELECT coalesce(v.paper_id, c.paper_id) AS paper_id, coalesce(v.shared, '{}') AS shared, (c.paper_id IS NOT NULL) AS cites
     FROM via_entities v FULL OUTER JOIN (SELECT DISTINCT paper_id FROM via_citations WHERE NOT (paper_id = ANY($1::bigint[]))) c
       ON c.paper_id = v.paper_id
     ORDER BY (c.paper_id IS NOT NULL) DESC, coalesce(v.strength, 0) DESC LIMIT ${limit}`,
    [seeds],
  );
  if (!related.length) return [];
  const ids = related.map((r) => Number(r.paper_id));
  const flt = filterSql({ ...f, paperIds: ids }, 1);
  const { rows } = await db.query<ChunkRow & { score: number }>(
    `SELECT DISTINCT ON (c.paper_id) c.id, c.paper_id, p.title, p.year, p.venue, c.section, c.kind, c.page_start, c.page_end,
            c.content, c.ord, (1 - (c.embedding <=> $1::vector))::float8 AS score
     FROM chunks c JOIN papers p ON p.id = c.paper_id WHERE c.embedding IS NOT NULL${flt.sql}
     ORDER BY c.paper_id, c.embedding <=> $1::vector`,
    [vec(qvec), ...flt.params],
  );
  const reason = new Map(related.map((r) => [Number(r.paper_id), r]));
  return rows
    .filter((r) => Number(r.score) >= 0.65) // BGE cosines between unrelated papers sit ~0.5-0.6: below this is noise
    .sort((a, b) => Number(b.score) - Number(a.score))
    .map((r) => {
      const why = reason.get(Number(r.paper_id))!;
      const parts = [why.cites ? "citation link to a top result" : null, why.shared.length ? `shares ${why.shared.slice(0, 3).join(", ")}` : null];
      const s = +Number(r.score).toFixed(4);
      return toHit(r, "graph", { rrf: 0, final: +(s * 0.5).toFixed(4), dense: s }, parts.filter(Boolean).join("; "));
    });
}

function toHit(r: ChunkRow, via: Hit["via"], scores: Hit["scores"], graphReason?: string): Hit {
  return {
    chunkId: Number(r.id), paperId: Number(r.paper_id), title: r.title, year: r.year, venue: r.venue, section: r.section,
    kind: r.kind, pageStart: r.page_start, pageEnd: r.page_end, content: r.content, via, graphReason, scores,
  };
}

export async function hybridSearch(db: Db, query: string, filters: SearchFilters = {}, opts: SearchOptions = {}): Promise<SearchResult> {
  const k = Math.min(opts.k ?? 10, 50);
  const t: Record<string, number> = {};
  const degraded: string[] = [];
  const time = async <T>(name: string, fn: () => Promise<T>) => {
    const s = performance.now();
    try {
      return await fn();
    } finally {
      t[name] = Math.round(performance.now() - s);
    }
  };

  const terms = tokenize(query);
  let qvec: number[] | null = null;
  try {
    qvec = await time("embed", () => ml.embedQuery(query));
  } catch (e) {
    if (!(e instanceof MlUnavailableError)) throw e;
    degraded.push("dense", "rerank");
  }

  const pool = Math.max(50, k * 5);
  const [lex, den, papers] = await Promise.all([
    time("bm25", () => bm25(db, terms, filters, pool)),
    qvec ? time("dense", () => dense(db, qvec!, filters, pool)) : Promise.resolve([]),
    opts.hierarchical !== false ? time("papers", () => rankPapers(db, query, qvec, filters, 8)) : Promise.resolve([]),
  ]);

  const rankings = [lex.map((x) => x.id), den.map((x) => x.id)];
  const weights = [1, 1];
  if (papers.length) {
    const scoped = { ...filters, paperIds: papers };
    const [sLex, sDen] = await time("scoped", () => Promise.all([bm25(db, terms, scoped, 30), qvec ? dense(db, qvec, scoped, 30) : Promise.resolve([])]));
    rankings.push(sLex.map((x) => x.id), sDen.map((x) => x.id));
    weights.push(0.5, 0.7);
  }
  const fused = rrf(rankings, weights);
  const lexMap = new Map(lex.map((x, i) => [x.id, { s: x.score, r: i + 1 }]));
  const denMap = new Map(den.map((x, i) => [x.id, { s: x.score, r: i + 1 }]));
  const paperRank = new Map(papers.map((id, i) => [id, i + 1]));

  const shortlist = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, Math.max(30, k * 3));
  const rows = await loadChunks(db, shortlist.map(([id]) => id));
  const maxRrf = shortlist[0]?.[1] ?? 1;
  let hits: Hit[] = shortlist
    .filter(([id]) => rows.has(id))
    .map(([id, score]) => {
      const r = rows.get(id)!;
      return toHit(r, "retrieval", {
        bm25: lexMap.get(id)?.s, bm25Rank: lexMap.get(id)?.r, dense: denMap.get(id)?.s, denseRank: denMap.get(id)?.r,
        paperRank: paperRank.get(Number(r.paper_id)), rrf: +(score / maxRrf).toFixed(4), final: +(score / maxRrf).toFixed(4),
      });
    });

  if (opts.rerank !== false && config.ENABLE_RERANKER && ml.canRerank && qvec && hits.length) {
    try {
      // cross-encoder cost grows with candidates x length: rerank a bounded head with trimmed passages
      const head = hits.slice(0, Math.max(15, k * 2));
      const scores = await time("rerank", () => ml.rerank(query, head.map((h) => `${h.title}. ${h.section ?? ""}: ${h.content.slice(0, 900)}`)));
      head.forEach((h, i) => {
        h.scores.rerank = scores[i];
        h.scores.final = +(0.7 * scores[i] + 0.3 * h.scores.rrf).toFixed(4); // cross-encoder dominates, RRF breaks ties
      });
      hits.slice(head.length).forEach((h) => (h.scores.final = +(0.3 * h.scores.rrf).toFixed(4)));
    } catch (e) {
      if (!(e instanceof MlUnavailableError)) throw e;
      degraded.push("rerank");
    }
  }
  hits.sort((a, b) => b.scores.final - a.scores.final);

  // diversity: at most N chunks per paper in the final list
  const perPaper = new Map<number, number>();
  const maxPer = opts.maxPerPaper ?? 3;
  hits = hits.filter((h) => {
    const n = perPaper.get(h.paperId) ?? 0;
    perPaper.set(h.paperId, n + 1);
    return n < maxPer;
  }).slice(0, k);

  if (opts.graph) hits.push(...(await time("graph", () => graphExpand(db, qvec, hits, filters, 4))));
  if (opts.context) await time("context", () => addContext(db, hits));
  return { query, hits, degraded: [...new Set(degraded)], timings: t };
}
