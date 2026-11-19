/**
 * Hierarchical chunking: paper -> sections -> sentence-packed windows (~180 words, 1-sentence overlap).
 * Tables, figure captions and equations become their own chunks (kind) so they can be retrieved and
 * cited on their own. Every chunk keeps its page range for page-level citations.
 */
import type { PdfBlock } from "../ml/client.js";
import { sentences, stripControl } from "../lib/text.js";

export interface ChunkDraft {
  ord: number;
  section: string | null;
  kind: "abstract" | "text" | "table" | "figure" | "equation";
  pageStart: number | null;
  pageEnd: number | null;
  content: string;
}

const TARGET_WORDS = 180;
const MAX_WORDS = 260;
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

export function chunkPaper(title: string, abstract: string | null, blocks: PdfBlock[]): ChunkDraft[] {
  const out: ChunkDraft[] = [];
  const push = (c: Omit<ChunkDraft, "ord">) => {
    const content = stripControl(c.content).trim();
    if (content.length >= 40) out.push({ ...c, content, section: c.section && stripControl(c.section), ord: out.length });
  };

  if (abstract) push({ section: "Abstract", kind: "abstract", pageStart: 1, pageEnd: 1, content: `${title}. ${abstract}` });

  // group consecutive text blocks by section, flushing on special blocks
  let buf: { text: string; page: number }[] = [];
  let section: string | null = null;

  const flush = () => {
    if (!buf.length) return;
    const sents: { s: string; page: number }[] = [];
    for (const b of buf) for (const s of sentences(b.text).length ? sentences(b.text) : [b.text]) sents.push({ s, page: b.page });
    let cur: typeof sents = [];
    let count = 0;
    let fresh = 0; // sentences in `cur` not yet emitted (the carried-over overlap sentence is not fresh)
    const emit = () => {
      if (!cur.length) return;
      push({
        section,
        kind: "text",
        pageStart: cur[0].page,
        pageEnd: cur[cur.length - 1].page,
        content: cur.map((x) => x.s).join(" "),
      });
    };
    for (const x of sents) {
      const w = words(x.s);
      if (count + w > MAX_WORDS && fresh > 0) {
        emit();
        cur = cur.slice(-1); // one-sentence overlap keeps context across boundaries
        count = words(cur[0].s);
        fresh = 0;
      }
      cur.push(x);
      count += w;
      fresh++;
      if (count >= TARGET_WORDS) {
        emit();
        cur = cur.slice(-1);
        count = words(cur[0].s);
        fresh = 0;
      }
    }
    if (fresh > 0) emit(); // never drop trailing (or single-sentence) content
    buf = [];
  };

  for (const b of blocks) {
    if (b.kind === "heading") {
      flush();
      section = b.section || b.text;
      continue;
    }
    if (/^abstract$/i.test(section ?? "") && abstract) continue; // already have the clean abstract
    if (b.kind === "text") {
      if (b.section && b.section !== section) {
        flush();
        section = b.section;
      }
      buf.push({ text: b.text, page: b.page });
    } else {
      flush();
      push({ section: b.section || section, kind: b.kind, pageStart: b.page, pageEnd: b.page, content: b.text.slice(0, 4000) });
    }
  }
  flush();
  return out;
}

/** Fallback when no full text is available: the abstract is the only evidence. */
export const abstractOnly = (title: string, abstract: string | null): ChunkDraft[] =>
  chunkPaper(title, abstract ?? title, []);
