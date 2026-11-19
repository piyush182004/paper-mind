/** arXiv Atom API (free, no key). arXiv asks clients to wait ≥3 s between requests: we throttle. */
import { XMLParser } from "fast-xml-parser";
import { HttpError, fetchWithRetry, throttle } from "../lib/http.js";
import { cleanDoi, type DiscoverQuery, type DiscoveredPaper } from "./types.js";

const queue = throttle(3100);
/** interactive searches get their own lane so they never wait behind background PDF downloads */
const searchQueue = throttle(3100);
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", isArray: (n) => ["entry", "author", "link", "category"].includes(n) });

interface Entry {
  id: string;
  title: string;
  summary: string;
  published: string;
  updated?: string;
  author?: { name: string }[];
  link?: { "@_href": string; "@_title"?: string; "@_type"?: string }[];
  "arxiv:doi"?: string | { "#text": string };
  "arxiv:journal_ref"?: string | { "#text": string };
  "arxiv:primary_category"?: { "@_term": string };
}

const text = (v: unknown) => (typeof v === "string" ? v : (v as { "#text"?: string } | undefined)?.["#text"] ?? "");
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

export function mapEntry(e: Entry): DiscoveredPaper {
  const id = e.id.replace(/^https?:\/\/arxiv\.org\/abs\//, "");
  const base = id.replace(/v\d+$/, "");
  const pdf = e.link?.find((l) => l["@_title"] === "pdf")?.["@_href"] ?? `https://arxiv.org/pdf/${id}`;
  return {
    source: "arxiv",
    sourceId: base,
    title: squash(text(e.title)),
    abstract: squash(text(e.summary)) || null,
    year: e.published ? Number(e.published.slice(0, 4)) : null,
    publishedOn: e.published ? e.published.slice(0, 10) : null,
    venue: squash(text(e["arxiv:journal_ref"])) || (e["arxiv:primary_category"] ? `arXiv ${e["arxiv:primary_category"]["@_term"]}` : "arXiv"),
    url: `https://arxiv.org/abs/${base}`,
    pdfUrl: pdf.replace(/^http:/, "https:"),
    doi: cleanDoi(text(e["arxiv:doi"])) ?? `10.48550/arxiv.${base}`.toLowerCase(),
    arxivId: base,
    openalexId: null,
    s2Id: null,
    isOpenAccess: true,
    citationCount: 0,
    authors: (e.author ?? []).map((a) => ({ name: squash(text(a.name)) })),
    concepts: [],
    referencedWorks: [],
  };
}

export async function searchArxiv(q: DiscoverQuery): Promise<DiscoveredPaper[]> {
  const terms = q.q.replace(/[^\w\s-]/g, " ").trim().split(/\s+/).filter(Boolean).slice(0, 12);
  if (!terms.length) return [];
  const search = terms.map((t) => `all:${t}`).join("+AND+");
  const url = `https://export.arxiv.org/api/query?search_query=${search}&start=0&max_results=${Math.min(q.limit, 50)}&sortBy=relevance`;
  const xml = await searchQueue(async () => {
    const res = await fetchWithRetry(url, { timeoutMs: 12_000, retries: 1, maxRetryWaitMs: 2000 });
    if (!res.ok) throw new HttpError(`arXiv responded ${res.status}`, res.status, url);
    return res.text();
  });
  const feed = parser.parse(xml)?.feed;
  let out = ((feed?.entry ?? []) as Entry[]).filter((e) => e.id && e.title).map(mapEntry);
  if (q.yearFrom) out = out.filter((p) => !p.year || p.year >= q.yearFrom!);
  if (q.yearTo) out = out.filter((p) => !p.year || p.year <= q.yearTo!);
  return out;
}

/** Download an arXiv PDF through the same throttle (bulk downloads should respect arXiv's limits too). */
export const arxivThrottled = queue;
