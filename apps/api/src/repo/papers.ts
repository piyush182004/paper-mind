/** Relational persistence for papers, authors, chunks (+BM25 postings), entities, claims and citations. */
import { type Db, vec } from "../db/client.js";
import { normKey, termFrequencies, tokenize } from "../lib/text.js";
import type { DiscoveredPaper } from "../sources/types.js";
import type { ChunkDraft } from "../ingest/chunker.js";
import type { ExtractedClaim, ExtractedEntity } from "../ingest/extract.js";

export interface PaperRow {
  id: number;
  source: string;
  doi: string | null;
  arxiv_id: string | null;
  openalex_id: string | null;
  s2_id: string | null;
  title: string;
  abstract: string | null;
  year: number | null;
  published_on: string | null;
  venue: string | null;
  url: string | null;
  pdf_url: string | null;
  is_open_access: boolean;
  citation_count: number;
  referenced_works: string[];
  status: string;
  status_detail: string | null;
  has_fulltext: boolean;
  page_count: number | null;
  created_at: string;
}

const PAPER_COLS = `id, source, doi, arxiv_id, openalex_id, s2_id, title, abstract, year, published_on::text, venue, url, pdf_url,
  is_open_access, citation_count, referenced_works, status, status_detail, has_fulltext, page_count, created_at::text`;

/** Same paper = same arXiv id, DOI or OpenAlex id; a preprint and its published version share only the
 *  title, so an exact normalised-title match also counts. Private uploads (owner_id set) never match. */
export const titleKey = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, "");

export async function findExisting(db: Db, p: Pick<DiscoveredPaper, "doi" | "arxivId" | "openalexId"> & { title?: string }): Promise<number | null> {
  const { rows } = await db.query<{ id: number }>(
    `SELECT id FROM papers WHERE owner_id IS NULL AND (
       (arxiv_id IS NOT NULL AND arxiv_id = $1) OR (doi IS NOT NULL AND lower(doi) = lower($2))
       OR (openalex_id IS NOT NULL AND openalex_id = $3)
       OR ($4::text IS NOT NULL AND length($4::text) > 20 AND regexp_replace(lower(title), '[^a-z0-9]', '', 'g') = $4::text))
     ORDER BY has_fulltext DESC, id LIMIT 1`,
    [p.arxivId, p.doi, p.openalexId, p.title ? titleKey(p.title) : null],
  );
  return rows[0] ? Number(rows[0].id) : null;
}

/** Insert a discovered paper, or fill gaps on the existing record. Returns its id. */
export async function upsertDiscovered(db: Db, p: DiscoveredPaper): Promise<{ id: number; created: boolean }> {
  const existing = await findExisting(db, p);
  if (existing) {
    await db.query(
      `UPDATE papers SET doi = COALESCE(doi, $2), arxiv_id = COALESCE(arxiv_id, $3), openalex_id = COALESCE(openalex_id, $4),
         s2_id = COALESCE(s2_id, $5), abstract = CASE WHEN length(coalesce(abstract,'')) < length(coalesce($6,'')) THEN $6 ELSE abstract END,
         pdf_url = COALESCE(pdf_url, $7), venue = COALESCE(venue, $8), citation_count = GREATEST(citation_count, $9),
         referenced_works = CASE WHEN cardinality(referenced_works) = 0 THEN $10 ELSE referenced_works END, updated_at = now()
       WHERE id = $1`,
      [existing, p.doi, p.arxivId, p.openalexId, p.s2Id, p.abstract, p.pdfUrl, p.venue, p.citationCount, p.referencedWorks],
    );
    return { id: existing, created: false };
  }
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO papers (source, doi, arxiv_id, openalex_id, s2_id, title, abstract, year, published_on, venue, url, pdf_url,
        is_open_access, citation_count, referenced_works)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10,$11,$12,$13,$14,$15) RETURNING id`,
    [p.source, p.doi, p.arxivId, p.openalexId, p.s2Id, p.title, p.abstract, p.year, p.publishedOn, p.venue, p.url, p.pdfUrl,
      p.isOpenAccess, p.citationCount, p.referencedWorks],
  );
  const id = Number(rows[0].id);
  await setAuthors(db, id, p.authors);
  if (p.concepts.length) await addConcepts(db, id, p.concepts);
  return { id, created: true };
}

export async function setAuthors(db: Db, paperId: number, authors: DiscoveredPaper["authors"]): Promise<void> {
  if (!authors.length) return;
  const names = authors.map((a) => a.name);
  const keys = authors.map((a) => a.openalexId ?? `name:${normKey(a.name)}`);
  await db.query(
    `INSERT INTO authors (name, name_key, openalex_id, orcid)
     SELECT n, k, o, r FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS t(n, k, o, r)
     ON CONFLICT (name_key) DO NOTHING`,
    [names, keys, authors.map((a) => a.openalexId ?? null), authors.map((a) => a.orcid ?? null)],
  );
  await db.query(
    `INSERT INTO paper_authors (paper_id, author_id, position)
     SELECT $1, a.id, t.pos FROM unnest($2::text[], $3::int[]) AS t(k, pos) JOIN authors a ON a.name_key = t.k
     ON CONFLICT DO NOTHING`,
    [paperId, keys, keys.map((_, i) => i)],
  );
}

async function upsertEntities(db: Db, items: { type: string; name: string; key: string }[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!items.length) return map;
  await db.query(
    `INSERT INTO entities (type, name, key) SELECT * FROM unnest($1::text[], $2::text[], $3::text[]) ON CONFLICT (type, key) DO NOTHING`,
    [items.map((e) => e.type), items.map((e) => e.name), items.map((e) => e.key)],
  );
  const { rows } = await db.query<{ id: number; type: string; key: string }>(
    `SELECT e.id, e.type, e.key FROM entities e JOIN unnest($1::text[], $2::text[]) AS t(type, key) ON e.type = t.type AND e.key = t.key`,
    [items.map((e) => e.type), items.map((e) => e.key)],
  );
  for (const r of rows) map.set(`${r.type}:${r.key}`, Number(r.id));
  return map;
}

/** Structured topics/keywords from OpenAlex become "concept" nodes of the knowledge graph. */
export async function addConcepts(db: Db, paperId: number, concepts: { name: string; score: number }[]): Promise<void> {
  const uniq = [...new Map(concepts.map((c) => [normKey(c.name), c])).values()].filter((c) => normKey(c.name));
  const ids = await upsertEntities(db, uniq.map((c) => ({ type: "concept", name: c.name, key: normKey(c.name) })));
  const rows = uniq.map((c) => ({ id: ids.get(`concept:${normKey(c.name)}`), score: c.score })).filter((r) => r.id);
  if (!rows.length) return;
  await db.query(
    `INSERT INTO paper_entities (paper_id, entity_id, mentions, source, score)
     SELECT $1, t.id, 1, 'openalex', t.score FROM unnest($2::bigint[], $3::real[]) AS t(id, score)
     ON CONFLICT (paper_id, entity_id) DO UPDATE SET score = EXCLUDED.score`,
    [paperId, rows.map((r) => r.id), rows.map((r) => r.score)],
  );
}

export interface EmbeddedContent {
  chunks: (ChunkDraft & { embedding: number[] })[];
  entities: ExtractedEntity[];
  claims: (ExtractedClaim & { embedding: number[] })[];
}

/** Replace a paper's full-text content atomically (chunks, BM25 postings, text entities, claims). */
export async function replaceContent(db: Db, paperId: number, c: EmbeddedContent): Promise<{ chunks: number; terms: number }> {
  return db.tx(async (t) => {
    await t.query("DELETE FROM chunks WHERE paper_id = $1", [paperId]); // cascades to chunk_terms, claims
    await t.query("DELETE FROM claims WHERE paper_id = $1", [paperId]);
    await t.query("DELETE FROM paper_entities WHERE paper_id = $1 AND source = 'text'", [paperId]);

    const toks = c.chunks.map((ch) => tokenize(`${ch.section ?? ""} ${ch.content}`));
    const { rows } = await t.query<{ id: number; ord: number }>(
      `INSERT INTO chunks (paper_id, ord, section, kind, page_start, page_end, content, length, embedding)
       SELECT $1, x.ord, x.section, x.kind, x.ps, x.pe, x.content, x.len, x.emb::vector
       FROM unnest($2::int[], $3::text[], $4::text[], $5::int[], $6::int[], $7::text[], $8::int[], $9::text[])
            AS x(ord, section, kind, ps, pe, content, len, emb)
       RETURNING id, ord`,
      [paperId, c.chunks.map((x) => x.ord), c.chunks.map((x) => x.section), c.chunks.map((x) => x.kind),
        c.chunks.map((x) => x.pageStart), c.chunks.map((x) => x.pageEnd), c.chunks.map((x) => x.content),
        toks.map((x) => x.length), c.chunks.map((x) => vec(x.embedding))],
    );
    const idByOrd = new Map(rows.map((r) => [Number(r.ord), Number(r.id)]));

    // BM25 postings
    const terms: string[] = [], chunkIds: number[] = [], tfs: number[] = [];
    c.chunks.forEach((ch, i) => {
      for (const [term, tf] of termFrequencies(toks[i])) {
        terms.push(term);
        chunkIds.push(idByOrd.get(ch.ord)!);
        tfs.push(tf);
      }
    });
    for (let i = 0; i < terms.length; i += 20_000) {
      await t.query(`INSERT INTO chunk_terms (term, chunk_id, tf) SELECT * FROM unnest($1::text[], $2::bigint[], $3::int[])`,
        [terms.slice(i, i + 20_000), chunkIds.slice(i, i + 20_000), tfs.slice(i, i + 20_000)]);
    }

    // entities mentioned in the text (+ any referenced only by claims)
    const ents = new Map(c.entities.map((e) => [`${e.type}:${e.key}`, e]));
    const entIds = await upsertEntities(t, [...ents.values()].map((e) => ({ type: e.type, name: e.name, key: e.key })));
    if (ents.size) {
      const list = [...ents.values()];
      await t.query(
        `INSERT INTO paper_entities (paper_id, entity_id, mentions, source, evidence_chunk_id, evidence)
         SELECT $1, x.eid, x.m, 'text', x.cid, x.ev FROM unnest($2::bigint[], $3::int[], $4::bigint[], $5::text[]) AS x(eid, m, cid, ev)
         ON CONFLICT (paper_id, entity_id) DO UPDATE SET mentions = EXCLUDED.mentions, evidence = EXCLUDED.evidence,
           evidence_chunk_id = EXCLUDED.evidence_chunk_id`,
        [paperId, list.map((e) => entIds.get(`${e.type}:${e.key}`)), list.map((e) => e.mentions),
          list.map((e) => idByOrd.get(e.evidenceOrd) ?? null), list.map((e) => e.evidence)],
      );
    }

    // claims (+ their entity links)
    if (c.claims.length) {
      const { rows: claimRows } = await t.query<{ id: number }>(
        `INSERT INTO claims (paper_id, chunk_id, page, kind, text, polarity, embedding)
         SELECT $1, x.cid, x.page, x.kind, x.text, x.pol, x.emb::vector
         FROM unnest($2::bigint[], $3::int[], $4::text[], $5::text[], $6::smallint[], $7::text[]) AS x(cid, page, kind, text, pol, emb)
         RETURNING id`,
        [paperId, c.claims.map((x) => idByOrd.get(x.ord) ?? null), c.claims.map((x) => x.page), c.claims.map((x) => x.kind),
          c.claims.map((x) => x.text), c.claims.map((x) => x.polarity), c.claims.map((x) => vec(x.embedding))],
      );
      const links: [number, number][] = [];
      claimRows.forEach((r, i) => {
        for (const k of c.claims[i].entityKeys) {
          const eid = entIds.get(k);
          if (eid) links.push([Number(r.id), eid]);
        }
      });
      if (links.length)
        await t.query(`INSERT INTO claim_entities SELECT * FROM unnest($1::bigint[], $2::bigint[]) ON CONFLICT DO NOTHING`,
          [links.map((l) => l[0]), links.map((l) => l[1])]);
    }
    return { chunks: rows.length, terms: terms.length };
  });
}

/** Link citation edges in both directions between this paper and papers already in the library. */
export async function linkCitations(db: Db, paperId: number): Promise<number> {
  const before = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM citations WHERE citing_id = $1 OR cited_id = $1", [paperId]);
  await db.query(
    `INSERT INTO citations (citing_id, cited_id)
     SELECT $1, c.id FROM papers p JOIN papers c ON c.openalex_id = ANY(p.referenced_works)
     WHERE p.id = $1 AND c.id <> $1 ON CONFLICT DO NOTHING`,
    [paperId],
  );
  await db.query(
    `INSERT INTO citations (citing_id, cited_id)
     SELECT c.id, $1 FROM papers p JOIN papers c ON p.openalex_id = ANY(c.referenced_works)
     WHERE p.id = $1 AND p.openalex_id IS NOT NULL AND c.id <> $1 ON CONFLICT DO NOTHING`,
    [paperId],
  );
  const after = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM citations WHERE citing_id = $1 OR cited_id = $1", [paperId]);
  return Number(after.rows[0].n) - Number(before.rows[0].n);
}

export async function getPaper(db: Db, id: number): Promise<PaperRow | null> {
  const { rows } = await db.query<PaperRow>(`SELECT ${PAPER_COLS} FROM papers WHERE id = $1`, [id]);
  return rows[0] ? { ...rows[0], id: Number(rows[0].id) } : null;
}

export async function setStatus(db: Db, id: number, status: string, detail: string | null = null): Promise<void> {
  await db.query("UPDATE papers SET status = $2, status_detail = $3, updated_at = now() WHERE id = $1", [id, status, detail]);
}

export { PAPER_COLS };

/** Re-run extraction for an already-indexed paper: replace its text entities and claims, keep chunks/vectors. */
export async function replaceExtraction(db: Db, paperId: number, entities: ExtractedEntity[], claims: (ExtractedClaim & { embedding: number[] })[]): Promise<void> {
  await db.tx(async (t) => {
    const { rows } = await t.query<{ id: number; ord: number }>("SELECT id, ord FROM chunks WHERE paper_id = $1", [paperId]);
    const idByOrd = new Map(rows.map((r) => [Number(r.ord), Number(r.id)]));
    await t.query("DELETE FROM claims WHERE paper_id = $1", [paperId]);
    await t.query("DELETE FROM paper_entities WHERE paper_id = $1 AND source = 'text'", [paperId]);
    const entIds = await upsertEntities(t, entities.map((e) => ({ type: e.type, name: e.name, key: e.key })));
    if (entities.length)
      await t.query(
        `INSERT INTO paper_entities (paper_id, entity_id, mentions, source, evidence_chunk_id, evidence)
         SELECT $1, x.eid, x.m, 'text', x.cid, x.ev FROM unnest($2::bigint[], $3::int[], $4::bigint[], $5::text[]) AS x(eid, m, cid, ev)
         ON CONFLICT (paper_id, entity_id) DO UPDATE SET mentions = EXCLUDED.mentions, evidence = EXCLUDED.evidence`,
        [paperId, entities.map((e) => entIds.get(`${e.type}:${e.key}`)), entities.map((e) => e.mentions),
          entities.map((e) => idByOrd.get(e.evidenceOrd) ?? null), entities.map((e) => e.evidence)]);
    if (claims.length) {
      const { rows: cr } = await t.query<{ id: number }>(
        `INSERT INTO claims (paper_id, chunk_id, page, kind, text, polarity, embedding)
         SELECT $1, x.cid, x.page, x.kind, x.text, x.pol, x.emb::vector
         FROM unnest($2::bigint[], $3::int[], $4::text[], $5::text[], $6::smallint[], $7::text[]) AS x(cid, page, kind, text, pol, emb) RETURNING id`,
        [paperId, claims.map((c) => idByOrd.get(c.ord) ?? null), claims.map((c) => c.page), claims.map((c) => c.kind),
          claims.map((c) => c.text), claims.map((c) => c.polarity), claims.map((c) => vec(c.embedding))]);
      const links: [number, number][] = [];
      cr.forEach((r, i) => claims[i].entityKeys.forEach((k) => { const e = entIds.get(k); if (e) links.push([Number(r.id), e]); }));
      if (links.length)
        await t.query("INSERT INTO claim_entities SELECT * FROM unnest($1::bigint[], $2::bigint[]) ON CONFLICT DO NOTHING",
          [links.map((l) => l[0]), links.map((l) => l[1])]);
    }
  });
}
