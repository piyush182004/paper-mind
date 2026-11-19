/**
 * Ingestion pipeline for one paper:
 *   enrich metadata (OpenAlex) -> fetch PDF -> parse (ML service) -> hierarchical chunks
 *   -> embeddings (chunks, paper, claims) -> entity & claim extraction -> atomic store -> citation links
 * Without an open PDF the paper is still indexed from its abstract and marked metadata_only.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { type Db, vec } from "../db/client.js";
import { fetchWithRetry } from "../lib/http.js";
import { ml, MlMemoryError, type ParsedPdf } from "../ml/client.js";
import { addConcepts, getPaper, linkCitations, replaceContent, replaceExtraction, setAuthors, setStatus } from "../repo/papers.js";
import { arxivThrottled } from "../sources/arxiv.js";
import { getOpenAlexWork } from "../sources/openalex.js";
import type { JobContext } from "../jobs/queue.js";
import { abstractOnly, type ChunkDraft, chunkPaper } from "./chunker.js";
import { extractClaims, extractEntities } from "./extract.js";

export const uploadsDir = () => path.resolve(config.DATA_DIR, "uploads");

async function downloadPdf(url: string): Promise<Uint8Array> {
  const isArxiv = /arxiv\.org/.test(url);
  const doFetch = async () => {
    const res = await fetchWithRetry(url, { timeoutMs: 45_000, retries: 1, redirect: "follow" });
    if (!res.ok) throw new Error(`PDF download failed (${res.status})`);
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > config.MAX_UPLOAD_MB * 1024 * 1024) throw new Error("PDF too large");
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > config.MAX_UPLOAD_MB * 1024 * 1024) throw new Error("PDF too large");
    if (!(buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46)) throw new Error("link did not return a PDF");
    return buf;
  };
  return isArxiv ? arxivThrottled(doFetch) : doFetch();
}

async function enrich(db: Db, paperId: number): Promise<void> {
  const p = await getPaper(db, paperId);
  if (!p) return;
  const { rows } = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM paper_entities WHERE paper_id = $1 AND source = 'openalex'", [paperId]);
  if (p.openalex_id && p.referenced_works.length && Number(rows[0].n) > 0) return;
  const w = await getOpenAlexWork({ openalexId: p.openalex_id, doi: p.doi, arxivId: p.arxiv_id });
  if (!w) return;
  await db.query(
    `UPDATE papers SET openalex_id = COALESCE(openalex_id, $2), referenced_works = CASE WHEN cardinality(referenced_works) = 0 THEN $3 ELSE referenced_works END,
       citation_count = GREATEST(citation_count, $4), venue = COALESCE(venue, $5), year = COALESCE(year, $6),
       abstract = CASE WHEN length(coalesce(abstract,'')) < length(coalesce($7,'')) THEN $7 ELSE abstract END,
       pdf_url = COALESCE(pdf_url, $8), updated_at = now() WHERE id = $1`,
    [paperId, w.openalexId, w.referencedWorks, w.citationCount, w.venue, w.year, w.abstract, w.pdfUrl],
  ).catch(() => undefined); // a unique-id clash means another record already owns that OpenAlex id
  const { rows: authors } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM paper_authors WHERE paper_id = $1", [paperId]);
  if (Number(authors[0].n) === 0) await setAuthors(db, paperId, w.authors);
  if (w.concepts.length) await addConcepts(db, paperId, w.concepts);
}

export interface IngestPayload {
  paperId: number;
  uploadPath?: string; // manual upload: local file instead of downloading
  fulltext?: boolean;  // false = index title + abstract only (fast), even if a PDF link is known
}

export async function ingestPaper(db: Db, payload: IngestPayload, ctx: JobContext): Promise<Record<string, unknown>> {
  const { paperId } = payload;
  // progress goes to the job and to the paper, so the library shows what is happening
  const step = async (fraction: number, message: string) => {
    await ctx.progress(fraction, message);
    await db.query("UPDATE papers SET status_detail = $2 WHERE id = $1 AND status = 'processing'", [paperId, message]);
  };
  await setStatus(db, paperId, "processing", "Starting");
  await step(0.05, "Enriching metadata (OpenAlex)");
  await enrich(db, paperId).catch(() => undefined);

  const paper = await getPaper(db, paperId);
  if (!paper) throw new Error(`paper ${paperId} not found`);

  // ---- full text
  let parsed: ParsedPdf | null = null;
  let note: string | null = null;
  try {
    let bytes: Uint8Array | null = null;
    if (payload.uploadPath) {
      bytes = await fs.readFile(payload.uploadPath).then((b) => new Uint8Array(b), (e: NodeJS.ErrnoException) => {
        if (e.code !== "ENOENT") throw e;
        // free hosts wipe their disk on restart: the file is gone, so say what to do instead of failing obscurely
        throw Object.assign(new Error("The uploaded file is no longer on the server (it restarted). Please upload the PDF again."), { fatal: true });
      });
    } else if (payload.fulltext !== false && paper.pdf_url) {
      await step(0.15, "Downloading PDF");
      bytes = await downloadPdf(paper.pdf_url);
    }
    if (bytes) {
      await step(0.3, "Reading the PDF (text, sections, tables, equations)");
      parsed = await ml.parsePdf(bytes);
      if (!parsed.blocks.some((b) => b.kind === "text")) {
        parsed = null;
        note = "PDF had no extractable text (scanned?); indexed abstract only";
      }
    } else note = payload.fulltext === false ? "Imported as abstract-only" : "No open-access PDF; indexed title and abstract only";
  } catch (e) {
    if ((e as { status?: number }).status === 503 || (e as { fatal?: boolean }).fatal) throw e; // ML service down / file gone
    note = `Full text unavailable (${(e as Error).message}); indexed abstract only`;
  }

  // a manual upload may have no metadata yet: take the title from the PDF
  if (paper.source === "upload" && parsed?.title && /^(untitled|upload)/i.test(paper.title)) {
    await db.query("UPDATE papers SET title = $2 WHERE id = $1", [paperId, parsed.title]);
    paper.title = parsed.title;
  }

  let chunks = parsed ? chunkPaper(paper.title, paper.abstract, parsed.blocks) : abstractOnly(paper.title, paper.abstract);
  if (!chunks.length) throw new Error("Nothing to index: no abstract and no readable full text");

  // ---- embeddings (title + section give each chunk context without changing what is shown)
  const embedChunks = (cs: ChunkDraft[]) => {
    const total = cs.length;
    return ml.embed(cs.map((c) => `${paper.title}. ${c.section ?? ""}: ${c.content}`), false,
      (done) => step(0.4 + 0.35 * (done / total), `Indexing text: ${done} of ${total} passages`));
  };
  await step(0.4, `Indexing text: 0 of ${chunks.length} passages`);
  let chunkVecs: number[][];
  try {
    chunkVecs = await embedChunks(chunks);
  } catch (e) {
    if (!(e instanceof MlMemoryError) || !parsed) throw e;
    // the full text doesn't fit this server's memory: keep the paper usable from its title + abstract
    parsed = null;
    note = "Full text is too large for this server, so it was indexed from its title and abstract";
    chunks = abstractOnly(paper.title, paper.abstract);
    if (!chunks.length) throw new Error("This PDF is too large for this server and the paper has no abstract to index instead");
    chunkVecs = await embedChunks(chunks);
  }
  const [paperVec] = await ml.embed([`${paper.title}. ${paper.abstract ?? ""}`]);

  await step(0.78, "Extracting entities and claims");
  const entities = extractEntities(chunks);
  let claims = extractClaims(chunks);
  const claimVecs = claims.length
    ? await ml.embed(claims.map((c) => c.text)).catch((e) => {
      if (!(e instanceof MlMemoryError)) throw e;
      claims = []; // optional extras: keep the indexed text rather than fail the paper
      return [];
    })
    : [];

  await step(0.9, "Saving");
  const stats = await replaceContent(db, paperId, {
    chunks: chunks.map((c, i) => ({ ...c, embedding: chunkVecs[i] })),
    entities,
    claims: claims.map((c, i) => ({ ...c, embedding: claimVecs[i] })),
  });
  await db.query(
    "UPDATE papers SET embedding = $2::vector, has_fulltext = $3, page_count = $4, updated_at = now() WHERE id = $1",
    [paperId, vec(paperVec), Boolean(parsed), parsed?.pages ?? null],
  );
  const newCitations = await linkCitations(db, paperId);
  await setStatus(db, paperId, parsed ? "ready" : "metadata_only", note);

  return { paperId, chunks: stats.chunks, terms: stats.terms, entities: entities.length, claims: claims.length,
    citationsLinked: newCitations, fulltext: Boolean(parsed), note };
}

/** Re-read stored chunks with the current extractors (no download, no re-embedding of chunks). */
export async function reextractPaper(db: Db, paperId: number): Promise<{ entities: number; claims: number }> {
  const { rows } = await db.query<{ ord: number; section: string | null; kind: ChunkDraft["kind"]; page_start: number | null; page_end: number | null; content: string }>(
    "SELECT ord, section, kind, page_start, page_end, content FROM chunks WHERE paper_id = $1 ORDER BY ord", [paperId]);
  const chunks: ChunkDraft[] = rows.map((r) => ({ ord: Number(r.ord), section: r.section, kind: r.kind, pageStart: r.page_start, pageEnd: r.page_end, content: r.content }));
  if (!chunks.length) return { entities: 0, claims: 0 };
  const entities = extractEntities(chunks);
  const claims = extractClaims(chunks);
  const vecs = claims.length ? await ml.embed(claims.map((c) => c.text)) : [];
  await replaceExtraction(db, paperId, entities, claims.map((c, i) => ({ ...c, embedding: vecs[i] })));
  return { entities: entities.length, claims: claims.length };
}
