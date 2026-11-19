"""PDF -> structured blocks with page numbers (PyMuPDF).

Every block keeps its page so answers can cite "p. 4". Detects section headings (font size /
weight relative to body text), tables (PyMuPDF table finder -> Markdown), figure/table captions,
display equations, and drops running headers/footers, page numbers and the reference list.
"""
from __future__ import annotations

import re
import statistics
import time
from collections import Counter
from dataclasses import asdict, dataclass

import pymupdf as fitz  # PyMuPDF

CANONICAL_HEADINGS = re.compile(
    r"^(?:\d+(?:\.\d+)*\.?\s*)?(abstract|introduction|related work|background|preliminaries|"
    r"methods?|methodology|approach|model|experiments?|experimental (?:setup|results)|evaluation|results|"
    r"analysis|discussion|limitations?|conclusions?|future work|acknowledge?ments?|appendix|references|bibliography)\b",
    re.I,
)
STOP_SECTIONS = re.compile(r"^(?:\d+\.?\s*)?(references|bibliography)\s*$", re.I)
CAPTION = re.compile(r"^(fig(?:ure)?\.?|table)\s*(\d+|[ivx]+)\s*[.:|]", re.I)
MATH_CHARS = set("=+−-×·∑∏∫∂∇≈≤≥≠±∞√λθαβγδσμπφψωΩΣΔ^_{}()|")
PAGE_NUMBER = re.compile(r"^\s*(?:page\s*)?\d{1,4}\s*$", re.I)


@dataclass
class Block:
    page: int
    kind: str  # heading | text | table | figure | equation
    section: str
    text: str


CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f￾￿]")


def _clean(text: str) -> str:
    text = CONTROL.sub("", text).replace("­", "")  # NUL & co. break Postgres text columns
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)  # de-hyphenate line breaks
    text = re.sub(r"\s*\n\s*", " ", text)
    return re.sub(r"[ \t]{2,}", " ", text).strip()


def _is_equation(text: str) -> bool:
    t = text.strip()
    if len(t) < 3 or len(t) > 300:
        return False
    math = sum(ch in MATH_CHARS for ch in t)
    words = re.findall(r"[A-Za-z]{4,}", t)
    return math / max(1, len(t)) > 0.12 and len(words) <= 4


TABLE_CAPTION_ON_PAGE = re.compile(r"(?m)^\s*table\s*(\d+|[ivx]+)\b", re.I)


def parse_pdf(data: bytes, max_pages: int = 60, table_pages: int = 8, table_budget_s: float = 20.0) -> dict:
    """Structured table extraction is expensive (1-5 s/page), so it only runs on pages that carry a
    "Table N" caption, for at most ``table_pages`` pages / ``table_budget_s`` seconds. Tables beyond
    the budget are still indexed: their cells remain ordinary text blocks next to the caption."""
    doc = fitz.open(stream=data, filetype="pdf")
    try:
        meta = doc.metadata or {}
        raw: list[tuple[int, str, float, bool, tuple]] = []  # page, text, size, bold, bbox
        tables: list[Block] = []
        n_pages = min(len(doc), max_pages)
        table_time = 0.0
        table_done = 0

        for pno in range(n_pages):
            page = doc[pno]
            table_boxes: list[fitz.Rect] = []
            if (table_done < table_pages and table_time < table_budget_s
                    and TABLE_CAPTION_ON_PAGE.search(page.get_text())):
                t0 = time.perf_counter()
                try:
                    for t in page.find_tables().tables:
                        md = CONTROL.sub("", t.to_markdown()).strip()
                        if md and md.count("|") >= 6:
                            table_boxes.append(fitz.Rect(t.bbox))
                            tables.append(Block(pno + 1, "table", "", md[:6000]))
                except Exception:  # table detection is best-effort
                    pass
                table_time += time.perf_counter() - t0
                table_done += 1
            for b in page.get_text("dict").get("blocks", []):
                if b.get("type") != 0:
                    continue
                rect = fitz.Rect(b["bbox"])
                if any(rect.intersects(tb) for tb in table_boxes):
                    continue
                spans = [s for line in b.get("lines", []) for s in line.get("spans", [])]
                if not spans:
                    continue
                text = "\n".join("".join(s["text"] for s in line.get("spans", [])) for line in b["lines"])
                text = _clean(text)
                if not text:
                    continue
                size = max(s["size"] for s in spans)
                bold = any(s["flags"] & 16 for s in spans) or any("bold" in s.get("font", "").lower() for s in spans)
                raw.append((pno + 1, text, size, bold, tuple(b["bbox"])))

        # running headers/footers: identical short lines on many pages
        repeated = Counter(t for _, t, _, _, _ in raw if len(t) < 90)
        boiler = {t for t, c in repeated.items() if c >= max(3, n_pages // 2)}
        body_sizes = [s for _, t, s, _, _ in raw if len(t) > 80]
        body = statistics.median(body_sizes) if body_sizes else 10.0

        blocks: list[Block] = []
        section = "Front matter"
        stopped = False
        for page, text, size, bold, _ in raw:
            if text in boiler or PAGE_NUMBER.match(text):
                continue
            short = len(text) < 120 and not text.endswith((".", ",", ";")) and len(text.split()) <= 14
            is_heading = short and (size >= body + 1.2 or (bold and (CANONICAL_HEADINGS.match(text) or re.match(r"^\d+(\.\d+)*\s+[A-Z]", text))))
            if is_heading or (short and CANONICAL_HEADINGS.match(text) and len(text.split()) <= 5):
                if STOP_SECTIONS.match(text):
                    stopped = True  # skip the reference list: citations come from structured metadata
                    continue
                if stopped and not re.match(r"^(appendix|[A-Z]\s)", text, re.I):
                    continue
                stopped = False
                section = re.sub(r"^\d+(\.\d+)*\.?\s*", "", text)[:120] or section
                blocks.append(Block(page, "heading", section, text))
                continue
            if stopped:
                continue
            if CAPTION.match(text):
                kind = "table" if text.lower().startswith("table") else "figure"
                blocks.append(Block(page, kind, section, text[:2000]))
            elif _is_equation(text):
                blocks.append(Block(page, "equation", section, text))
            else:
                blocks.append(Block(page, "text", section, text))

        # attach detected tables after the text of their page, labelled with the current section
        by_page_section = {b.page: b.section for b in blocks}
        for t in tables:
            t.section = by_page_section.get(t.page, "")
        blocks.extend(tables)
        blocks.sort(key=lambda b: (b.page, 0 if b.kind != "table" else 1))

        return {
            "pages": len(doc),
            "parsed_pages": n_pages,
            "title": (meta.get("title") or "").strip() or None,
            "author": (meta.get("author") or "").strip() or None,
            "blocks": [asdict(b) for b in blocks],
        }
    finally:
        doc.close()
