/** OpenAlex: free, no key, rich metadata (authors, topics, references, OA PDF links). */
import { config } from "../config.js";
import { getJson } from "../lib/http.js";
import { arxivFromUrl, cleanDoi, type DiscoverQuery, type DiscoveredPaper } from "./types.js";

const BASE = "https://api.openalex.org";
const SELECT = [
  "id", "doi", "title", "publication_year", "publication_date", "primary_location", "best_oa_location", "locations",
  "open_access", "cited_by_count", "authorships", "topics", "keywords", "referenced_works", "abstract_inverted_index", "ids",
].join(",");

interface Work {
  id: string;
  doi?: string | null;
  title?: string | null;
  publication_year?: number | null;
  publication_date?: string | null;
  primary_location?: { landing_page_url?: string | null; pdf_url?: string | null; source?: { display_name?: string } | null } | null;
  best_oa_location?: { pdf_url?: string | null; landing_page_url?: string | null } | null;
  locations?: { landing_page_url?: string | null; pdf_url?: string | null }[];
  open_access?: { is_oa?: boolean; oa_url?: string | null };
  cited_by_count?: number;
  authorships?: { author: { id?: string; display_name?: string; orcid?: string | null } }[];
  topics?: { display_name: string; score: number }[];
  keywords?: { display_name: string; score: number }[];
  referenced_works?: string[];
  abstract_inverted_index?: Record<string, number[]> | null;
}

const short = (id: string | null | undefined) => (id ? id.replace("https://openalex.org/", "") : null);
const params = (extra: Record<string, string>) => {
  const p = new URLSearchParams({ select: SELECT, ...extra });
  if (config.OPENALEX_MAILTO) p.set("mailto", config.OPENALEX_MAILTO);
  if (config.OPENALEX_API_KEY) p.set("api_key", config.OPENALEX_API_KEY);
  return p.toString();
};

/** OpenAlex ships abstracts as an inverted index (word -> positions) for licensing reasons. */
export function rebuildAbstract(inv: Record<string, number[]> | null | undefined): string | null {
  if (!inv) return null;
  const words: string[] = [];
  for (const [w, positions] of Object.entries(inv)) for (const p of positions) words[p] = w;
  const text = words.filter(Boolean).join(" ").trim();
  return text || null;
}

export function mapWork(w: Work): DiscoveredPaper {
  const urls = [w.primary_location?.landing_page_url, ...(w.locations ?? []).map((l) => l.landing_page_url)];
  const arxivId = urls.map(arxivFromUrl).find(Boolean) ?? null;
  const pdfUrl = w.best_oa_location?.pdf_url ?? w.primary_location?.pdf_url ?? (arxivId ? `https://arxiv.org/pdf/${arxivId}` : null);
  return {
    source: "openalex",
    sourceId: short(w.id)!,
    title: (w.title ?? "").trim() || "(untitled)",
    abstract: rebuildAbstract(w.abstract_inverted_index),
    year: w.publication_year ?? null,
    publishedOn: w.publication_date ?? null,
    venue: w.primary_location?.source?.display_name ?? null,
    url: w.doi ?? w.primary_location?.landing_page_url ?? w.id,
    pdfUrl,
    doi: cleanDoi(w.doi),
    arxivId,
    openalexId: short(w.id),
    s2Id: null,
    isOpenAccess: Boolean(w.open_access?.is_oa),
    citationCount: w.cited_by_count ?? 0,
    authors: (w.authorships ?? []).slice(0, 40).map((a) => ({
      name: a.author.display_name ?? "Unknown",
      openalexId: short(a.author.id),
      orcid: a.author.orcid ?? null,
    })),
    concepts: [
      ...(w.topics ?? []).slice(0, 5).map((t) => ({ name: t.display_name, score: t.score })),
      ...(w.keywords ?? []).slice(0, 6).map((k) => ({ name: k.display_name, score: k.score })),
    ],
    referencedWorks: (w.referenced_works ?? []).map((r) => short(r)!).slice(0, 400),
  };
}

export async function searchOpenAlex(q: DiscoverQuery): Promise<DiscoveredPaper[]> {
  const filters = [`has_abstract:true`];
  if (q.yearFrom) filters.push(`from_publication_date:${q.yearFrom}-01-01`);
  if (q.yearTo) filters.push(`to_publication_date:${q.yearTo}-12-31`);
  if (q.openAccessOnly) filters.push("is_oa:true");
  const data = await getJson<{ results: Work[] }>(
    `${BASE}/works?${params({ search: q.q, "per-page": String(Math.min(q.limit, 50)), filter: filters.join(",") })}`,
    { retries: 1, maxRetryWaitMs: 2000, timeoutMs: 8000 }, // someone is waiting on this: fail fast, never hang
  );
  return data.results.map(mapWork);
}

/** Look up one work by OpenAlex id, DOI or arXiv id (used to enrich papers found elsewhere). */
export async function getOpenAlexWork(ref: { openalexId?: string | null; doi?: string | null; arxivId?: string | null }): Promise<DiscoveredPaper | null> {
  try {
    if (ref.openalexId) return mapWork(await getJson<Work>(`${BASE}/works/${ref.openalexId}?${params({})}`));
    if (ref.doi) return mapWork(await getJson<Work>(`${BASE}/works/doi:${encodeURIComponent(ref.doi)}?${params({})}`));
    if (ref.arxivId) {
      const doi = `10.48550/arxiv.${ref.arxivId.replace(/v\d+$/, "")}`; // arXiv's DataCite DOI
      return mapWork(await getJson<Work>(`${BASE}/works/doi:${encodeURIComponent(doi)}?${params({})}`));
    }
  } catch {
    /* not indexed (yet): enrichment is optional */
  }
  return null;
}
