/**
 * PDF -> structured blocks with page numbers, in-process (pdf.js via unpdf). Port of the Python
 * parser: section headings from font size, figure/table captions, display equations, running
 * headers/footers and page numbers dropped, reference list skipped. (Structured table cells need
 * the Python service; here table text stays ordinary text next to its caption.)
 */
import type { ParsedPdf, PdfBlock } from "../client.js";

const CANONICAL_HEADINGS = new RegExp(
  "^(?:\\d+(?:\\.\\d+)*\\.?\\s*)?(abstract|introduction|related work|background|preliminaries|methods?|methodology|approach|model|" +
    "experiments?|experimental (?:setup|results)|evaluation|results|analysis|discussion|limitations?|conclusions?|future work|" +
    "acknowledge?ments?|appendix|references|bibliography)\\b", "i");
const STOP_SECTIONS = /^(?:\d+\.?\s*)?(references|bibliography)\s*$/i;
const CAPTION = /^(fig(?:ure)?\.?|table)\s*(\d+|[ivx]+)\s*[.:|]/i;
const MATH_CHARS = new Set("=+−-×·∑∏∫∂∇≈≤≥≠±∞√λθαβγδσμπφψωΩΣΔ^_{}()|");
const PAGE_NUMBER = /^\s*(?:page\s*)?\d{1,4}\s*$/i;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F￾￿]/g;
const NUMBERED = /^\d+(\.\d+)*\.?\s+[A-Z]/;

function clean(text: string): string {
  return text.replace(CONTROL, "").replace(/­/g, "")
    .replace(/(\w)-\n(\w)/g, "$1$2")
    .replace(/\s*\n\s*/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function isEquation(t: string): boolean {
  t = t.trim();
  if (t.length < 3 || t.length > 300) return false;
  let math = 0;
  for (const ch of t) if (MATH_CHARS.has(ch)) math++;
  const words = t.match(/[A-Za-z]{4,}/g) ?? [];
  return math / Math.max(1, t.length) > 0.12 && words.length <= 4;
}

/** "3 Experiments", "4.2 Results", "Conclusion": short, no sentence punctuation. */
const headingLike = (t: string) => {
  const s = t.trim();
  const w = s.split(/\s+/).length;
  return w <= 8 && s.length < 80 && !/[.,;:]$/.test(s) && (NUMBERED.test(s) || (CANONICAL_HEADINGS.test(s) && w <= 4));
};

interface Line { text: string; x: number; y: number; size: number; font: string }
interface Raw { page: number; text: string; size: number }

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 10;
};

export async function parsePdf(data: Uint8Array, maxPages = 60): Promise<ParsedPdf> {
  const { getDocumentProxy } = await import("unpdf");
  const doc = await getDocumentProxy(new Uint8Array(data));
  try {
    const nPages = Math.min(doc.numPages, maxPages);
    const meta = (await doc.getMetadata().catch(() => null))?.info as { Title?: string; Author?: string } | undefined;
    const raw: Raw[] = [];

    for (let pno = 1; pno <= nPages; pno++) {
      const page = await doc.getPage(pno);
      const tc = await page.getTextContent();
      // items -> lines (pdf.js gives content-stream order, which follows columns in most papers)
      const lines: Line[] = [];
      let cur: Line | null = null;
      for (const it of tc.items as { str: string; transform: number[]; hasEOL?: boolean; fontName?: string }[]) {
        if (typeof it.str !== "string") continue;
        if (Math.abs(it.transform[1]) > Math.abs(it.transform[0])) continue; // rotated margin text (arXiv stamp, line numbers)
        const size = Math.hypot(it.transform[2], it.transform[3]) || 10;
        const x = it.transform[4], y = it.transform[5];
        if (cur && Math.abs(cur.y - y) > Math.max(2, size * 0.5)) {
          lines.push(cur);
          cur = null;
        }
        if (!cur) cur = { text: "", x, y, size, font: it.fontName ?? "" };
        if (!cur.text.trim() && it.str.trim()) cur.font = it.fontName ?? cur.font;
        cur.text += it.str;
        cur.size = Math.max(cur.size, it.str.trim() ? size : 0);
        if (it.hasEOL) {
          lines.push(cur);
          cur = null;
        }
      }
      if (cur) lines.push(cur);

      // lines -> blocks: same font size, small vertical gap, no jump to another column
      let block: Line[] = [];
      const flush = () => {
        if (!block.length) return;
        const text = clean(block.map((l) => l.text).join("\n"));
        if (text) raw.push({ page: pno, text, size: Math.max(...block.map((l) => l.size)) });
        block = [];
      };
      for (const l of lines) {
        if (!l.text.trim()) continue;
        const prev = block[block.length - 1];
        if (prev) {
          const gap = prev.y - l.y; // pdf y grows upwards
          const sameSize = Math.abs(prev.size - l.size) <= 0.6;
          // a short line in another font (bold heading) or shaped like a heading starts its own block
          const fontSwitch = prev.font !== l.font && (headingLike(prev.text) || headingLike(l.text));
          if (!sameSize || fontSwitch || headingLike(l.text) || headingLike(prev.text) && block.length === 1 && prev.font !== l.font
            || gap <= 0 || gap > prev.size * 1.8 || Math.abs(prev.x - l.x) > prev.size * 12) flush();
        }
        block.push(l);
      }
      flush();
      page.cleanup();
    }

    // running headers/footers: identical short lines on many pages
    const counts = new Map<string, number>();
    for (const r of raw) if (r.text.length < 90) counts.set(r.text, (counts.get(r.text) ?? 0) + 1);
    const boiler = new Set([...counts].filter(([, c]) => c >= Math.max(3, Math.floor(nPages / 2))).map(([t]) => t));
    const body = median(raw.filter((r) => r.text.length > 80).map((r) => r.size));

    const blocks: PdfBlock[] = [];
    let section = "Front matter";
    let stopped = false;
    for (const { page, text, size } of raw) {
      if (boiler.has(text) || PAGE_NUMBER.test(text)) continue;
      const words = text.split(/\s+/).length;
      const short = text.length < 120 && !/[.,;]$/.test(text) && words <= 14;
      const isHeading = short && (size >= body + 1.2 || (words <= 8 && (CANONICAL_HEADINGS.test(text) || NUMBERED.test(text)) && !/\d{3,}/.test(text.slice(4))));
      if (isHeading || (short && CANONICAL_HEADINGS.test(text) && words <= 5)) {
        if (STOP_SECTIONS.test(text)) {
          stopped = true; // the reference list is skipped: citations come from structured metadata
          continue;
        }
        if (stopped && !/^(appendix|[A-Z]\s)/i.test(text)) continue;
        stopped = false;
        section = text.replace(/^\d+(\.\d+)*\.?\s*/, "").slice(0, 120) || section;
        blocks.push({ page, kind: "heading", section, text });
        continue;
      }
      if (stopped) continue;
      if (CAPTION.test(text)) blocks.push({ page, kind: text.toLowerCase().startsWith("table") ? "table" : "figure", section, text: text.slice(0, 2000) });
      else if (isEquation(text)) blocks.push({ page, kind: "equation", section, text });
      else blocks.push({ page, kind: "text", section, text });
    }

    return {
      pages: doc.numPages,
      parsed_pages: nPages,
      title: meta?.Title?.trim() || null,
      author: meta?.Author?.trim() || null,
      blocks,
    };
  } finally {
    await (doc as unknown as { destroy?: () => Promise<void> }).destroy?.();
  }
}
