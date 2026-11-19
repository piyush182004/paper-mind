/**
 * Research intelligence over the indexed collection. Every output carries the evidence (claims with
 * paper + page) that produced it; nothing is generated. Results are *candidates* for a researcher to verify.
 */
import { type Db, parseVec } from "../db/client.js";
import { clusterMetrics, slope } from "./metrics.js";

interface ClaimEv { claimId: number; paperId: number; title: string; page: number | null; text: string; polarity: number }

// ---------------------------------------------------------------------------------- contradictions
export async function contradictions(db: Db, userId: number, limit = 30) {
  const { rows } = await db.query<{
    a_id: number; b_id: number; pa: number; pb: number; ta: string; tb: string; titlea: string; titleb: string; pga: number | null; pgb: number | null;
    pola: number; polb: number; kindb: string; sim: number; shared: string[] | null;
  }>(
    `SELECT a.id AS a_id, b.id AS b_id, a.paper_id AS pa, b.paper_id AS pb, a.text AS ta, b.text AS tb, a.page AS pga, b.page AS pgb,
            pa_.title AS titlea, pb_.title AS titleb, a.polarity AS pola, b.polarity AS polb, b.kind AS kindb, b.sim,
            (SELECT array_agg(DISTINCT e.name) FROM claim_entities ca JOIN claim_entities cb ON cb.entity_id = ca.entity_id
               JOIN entities e ON e.id = ca.entity_id WHERE ca.claim_id = a.id AND cb.claim_id = b.id) AS shared
     FROM claims a
     JOIN papers pa_ ON pa_.id = a.paper_id
     CROSS JOIN LATERAL (
       SELECT c.*, (1 - (c.embedding <=> a.embedding))::float8 AS sim FROM claims c
       LEFT JOIN chunks ch ON ch.id = c.chunk_id
       WHERE c.paper_id <> a.paper_id AND c.embedding IS NOT NULL AND c.paper_id IN (SELECT paper_id FROM library WHERE user_id = $1)
         AND ((c.kind = 'finding' AND c.polarity = -1)
              -- only a paper's *own* limitations count (not motivation text about prior work)
              OR (c.kind = 'limitation' AND (ch.section ~* 'limitation|discussion|conclusion|future|threats'
                  OR c.text ~* '\\m(our|we|this (work|paper|study|approach|method|model|framework))\\M')))
       ORDER BY c.embedding <=> a.embedding LIMIT 6) b
     JOIN papers pb_ ON pb_.id = b.paper_id
     WHERE a.kind = 'finding' AND a.polarity = 1 AND a.embedding IS NOT NULL AND b.sim >= 0.62 AND a.paper_id IN (SELECT paper_id FROM library WHERE user_id = $1)`,
    [userId],
  );
  const seen = new Set<string>();
  const out = [];
  for (const r of rows) {
    const key = [Math.min(r.a_id, r.b_id), Math.max(r.a_id, r.b_id)].join("-");
    if (seen.has(key)) continue;
    seen.add(key);
    const shared = r.shared ?? [];
    const type = r.kindb === "finding" ? "opposite_findings" : "finding_vs_limitation";
    const components = {
      similarity: +Number(r.sim).toFixed(3),
      sharedEntities: +Math.min(1, shared.length / 2).toFixed(3),
      conflict: type === "opposite_findings" ? 1 : 0.6, // explicit opposite results weigh more than a limitation
    };
    const score = +(0.55 * components.similarity + 0.25 * components.sharedEntities + 0.2 * components.conflict).toFixed(3);
    out.push({
      type, score, components, shared,
      a: { claimId: Number(r.a_id), paperId: Number(r.pa), title: r.titlea, page: r.pga, text: r.ta, polarity: r.pola } as ClaimEv,
      b: { claimId: Number(r.b_id), paperId: Number(r.pb), title: r.titleb, page: r.pgb, text: r.tb, polarity: r.polb } as ClaimEv,
    });
  }
  // require either shared entities or very high similarity: topical overlap alone is not a contradiction
  return out.filter((c) => c.shared.length > 0 || c.components.similarity >= 0.75).sort((a, b) => b.score - a.score).slice(0, limit);
}

// ---------------------------------------------------------------------------------- trends
export async function trends(db: Db, userId: number) {
  const { rows } = await db.query<{ type: string; name: string; year: number; n: number }>(
    `SELECT e.type, e.name, p.year, count(DISTINCT p.id)::int AS n FROM paper_entities pe
     JOIN entities e ON e.id = pe.entity_id JOIN papers p ON p.id = pe.paper_id
     WHERE p.year IS NOT NULL AND e.type IN ('method','model','dataset','task','concept') AND p.id IN (SELECT paper_id FROM library WHERE user_id = $1)
     GROUP BY e.type, e.name, p.year`,
    [userId],
  );
  const { rows: totals } = await db.query<{ year: number; n: number }>("SELECT year, count(*)::int AS n FROM papers WHERE year IS NOT NULL AND id IN (SELECT paper_id FROM library WHERE user_id = $1) GROUP BY year", [userId]);
  const total = new Map(totals.map((t) => [Number(t.year), Number(t.n)]));
  const years = [...total.keys()].sort();
  const maxYear = years[years.length - 1] ?? new Date().getFullYear();
  const window = years.filter((y) => y >= maxYear - 5);

  const series = new Map<string, { type: string; name: string; byYear: Record<number, number>; papers: number; first: number }>();
  for (const r of rows) {
    const k = `${r.type}:${r.name}`;
    const s = series.get(k) ?? { type: r.type, name: r.name, byYear: {}, papers: 0, first: 9999 };
    s.byYear[r.year] = Number(r.n);
    s.papers += Number(r.n);
    s.first = Math.min(s.first, r.year);
    series.set(k, s);
  }
  const scored = [...series.values()].filter((s) => s.papers >= 2).map((s) => {
    const share = window.map((y) => [y, (s.byYear[y] ?? 0) / Math.max(1, total.get(y) ?? 1)] as [number, number]);
    return { ...s, growth: +slope(share).toFixed(4), emerging: s.first >= maxYear - 2, share: share.map(([y, v]) => ({ year: y, share: +v.toFixed(3) })) };
  });
  return {
    window,
    rising: scored.filter((s) => s.growth > 0).sort((a, b) => b.growth - a.growth).slice(0, 12),
    declining: scored.filter((s) => s.growth < 0).sort((a, b) => a.growth - b.growth).slice(0, 8),
    emerging: scored.filter((s) => s.emerging).sort((a, b) => b.papers - a.papers).slice(0, 10),
    topics: (await clusterMetrics(db, userId)).map((c) => ({ id: c.id, name: c.name, growth: c.growth, size: c.size, recentShare: c.recentShare })),
  };
}

// ---------------------------------------------------------------------------------- research gaps
function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s; // embeddings are L2-normalised
}

export async function gaps(db: Db, userId: number) {
  // (1) popular methods/models never evaluated on popular datasets/tasks in this collection
  const { rows: pairs } = await db.query<{ method: string; m_papers: number[]; target: string; t_type: string; t_papers: number[] }>(
    `WITH pe AS (SELECT pe.paper_id, e.id, e.type, e.name FROM paper_entities pe JOIN entities e ON e.id = pe.entity_id
                 WHERE e.type IN ('method','model','dataset','task') AND (pe.mentions >= 2 OR pe.source = 'openalex') AND pe.paper_id IN (SELECT paper_id FROM library WHERE user_id = $1)),
     m AS (SELECT id, name, array_agg(DISTINCT paper_id) AS papers FROM pe WHERE type IN ('method','model') GROUP BY id, name HAVING count(DISTINCT paper_id) >= 2),
     d AS (SELECT id, name, type, array_agg(DISTINCT paper_id) AS papers FROM pe WHERE type IN ('dataset','task') GROUP BY id, name, type HAVING count(DISTINCT paper_id) >= 2)
     SELECT m.name AS method, m.papers AS m_papers, d.name AS target, d.type AS t_type, d.papers AS t_papers
     FROM m CROSS JOIN d
     WHERE NOT (m.papers && d.papers)
       -- a gap is only meaningful inside one research topic: both sides must share an active cluster
       AND (NOT EXISTS (SELECT 1 FROM cluster_runs WHERE is_active AND user_id = $1)
            OR EXISTS (SELECT 1 FROM paper_clusters a JOIN paper_clusters b ON b.cluster_id = a.cluster_id AND b.run_id = a.run_id
                       JOIN cluster_runs r ON r.id = a.run_id AND r.is_active AND r.user_id = $1
                       WHERE a.paper_id = ANY(m.papers) AND b.paper_id = ANY(d.papers)))`,
    [userId],
  );
  const untested = pairs
    .map((p) => ({ method: p.method, target: p.target, targetType: p.t_type, methodPapers: p.m_papers.map(Number), targetPapers: p.t_papers.map(Number),
      score: +Math.sqrt(p.m_papers.length * p.t_papers.length).toFixed(2) }))
    .sort((a, b) => b.score - a.score).slice(0, 15);

  // (2) limitations reported by several independent papers (greedy semantic grouping)
  const { rows: lims } = await db.query<{ id: number; paper_id: number; title: string; page: number | null; text: string; embedding: string }>(
    `SELECT c.id, c.paper_id, p.title, c.page, c.text, c.embedding::text AS embedding FROM claims c JOIN papers p ON p.id = c.paper_id
     WHERE c.kind = 'limitation' AND c.embedding IS NOT NULL AND c.paper_id IN (SELECT paper_id FROM library WHERE user_id = $1) ORDER BY c.id LIMIT 2000`,
    [userId],
  );
  const vecs = lims.map((l) => parseVec(l.embedding));
  const used = new Set<number>();
  const groups: { claims: ClaimEv[]; papers: number }[] = [];
  lims.forEach((l, i) => {
    if (used.has(i)) return;
    const members = [i];
    for (let j = i + 1; j < lims.length; j++)
      if (!used.has(j) && lims[j].paper_id !== l.paper_id && cosine(vecs[i], vecs[j]) >= 0.72) members.push(j);
    const papers = new Set(members.map((m) => lims[m].paper_id));
    if (papers.size >= 2) {
      members.forEach((m) => used.add(m));
      groups.push({
        papers: papers.size,
        claims: members.map((m) => ({ claimId: Number(lims[m].id), paperId: Number(lims[m].paper_id), title: lims[m].title, page: lims[m].page, text: lims[m].text, polarity: 0 })),
      });
    }
  });
  groups.sort((a, b) => b.papers - a.papers);

  // (3) growing topics with thin coverage
  const topics = await clusterMetrics(db, userId);
  const medianSize = topics.length ? topics.map((t) => t.size).sort((a, b) => a - b)[Math.floor(topics.length / 2)] : 0;
  const underExplored = topics.filter((t) => t.growth > 0 && t.size <= medianSize)
    .map((t) => ({ clusterId: t.id, name: t.name, size: t.size, growth: t.growth, coverage: t.coverage }));

  return { untestedCombinations: untested, recurringLimitations: groups.slice(0, 12), underExploredTopics: underExplored };
}

// ---------------------------------------------------------------------------------- comparison
export async function comparePapers(db: Db, userId: number, requested: number[]) {
  const { rows: own } = await db.query<{ paper_id: number }>("SELECT paper_id FROM library WHERE user_id = $1 AND paper_id = ANY($2::bigint[])", [userId, requested]);
  const ids = own.map((r) => Number(r.paper_id)); // only papers in the caller's library
  const { rows: papers } = await db.query<{ id: number; title: string; year: number | null; venue: string | null; citation_count: number; has_fulltext: boolean; embedding: string | null; cluster: string | null }>(
    `SELECT p.id, p.title, p.year, p.venue, p.citation_count, p.has_fulltext, p.embedding::text AS embedding,
       (SELECT c.name FROM paper_clusters pc JOIN clusters c ON c.id = pc.cluster_id JOIN cluster_runs r ON r.id = pc.run_id AND r.is_active AND r.user_id = $2 WHERE pc.paper_id = p.id) AS cluster
     FROM papers p WHERE p.id = ANY($1::bigint[])`, [ids, userId]);
  const { rows: ents } = await db.query<{ paper_id: number; type: string; name: string; mentions: number }>(
    `SELECT pe.paper_id, e.type, e.name, pe.mentions FROM paper_entities pe JOIN entities e ON e.id = pe.entity_id
     WHERE pe.paper_id = ANY($1::bigint[]) ORDER BY pe.mentions DESC, pe.score DESC NULLS LAST`, [ids]);
  const { rows: claims } = await db.query<{ id: number; paper_id: number; kind: string; text: string; page: number | null }>(
    `SELECT id, paper_id, kind, text, page FROM claims WHERE paper_id = ANY($1::bigint[]) AND kind IN ('finding','limitation','contribution') ORDER BY id`, [ids]);

  const NUM = /(\d+(?:\.\d+)?)\s*(%|points?|pp|x\b|×)/gi;
  const vec = new Map(papers.map((p) => [Number(p.id), p.embedding ? parseVec(p.embedding) : null]));
  const perPaper = papers.map((p) => {
    const pid = Number(p.id);
    const mine = ents.filter((e) => Number(e.paper_id) === pid);
    const byType = (t: string) => mine.filter((e) => e.type === t).map((e) => e.name);
    const pc = claims.filter((c) => Number(c.paper_id) === pid);
    const pick = (k: string, n: number) => pc.filter((c) => c.kind === k).slice(0, n).map((c) => ({ claimId: Number(c.id), text: c.text, page: c.page }));
    return {
      id: pid, title: p.title, year: p.year, venue: p.venue, citations: p.citation_count, fulltext: p.has_fulltext, cluster: p.cluster,
      topics: byType("concept").slice(0, 6), methods: byType("method"), models: byType("model"), datasets: byType("dataset"), metrics: byType("metric"), tasks: byType("task"),
      contributions: pick("contribution", 3), findings: pick("finding", 4), limitations: pick("limitation", 3),
      reportedNumbers: pc.filter((c) => c.kind === "finding").flatMap((c) => [...c.text.matchAll(NUM)].map((m) => ({ value: m[0], claimId: Number(c.id), page: c.page }))).slice(0, 8),
    };
  });
  const all = perPaper.map((p) => new Set([...p.methods, ...p.models, ...p.datasets, ...p.tasks]));
  const shared = all.length ? [...all[0]].filter((x) => all.every((s) => s.has(x))) : [];
  const similarity = perPaper.map((a) => perPaper.map((b) => {
    const va = vec.get(a.id), vb = vec.get(b.id);
    return va && vb ? +cosine(va, vb).toFixed(3) : null;
  }));
  return { papers: perPaper, shared, similarity };
}
