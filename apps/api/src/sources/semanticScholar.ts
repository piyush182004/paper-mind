/** Semantic Scholar Graph API: free (shared rate limit without a key; a free key raises it). */
import { config } from "../config.js";
import { getJson, throttle } from "../lib/http.js";
import { cleanDoi, type DiscoverQuery, type DiscoveredPaper } from "./types.js";

const queue = throttle(config.SEMANTIC_SCHOLAR_API_KEY ? 1100 : 1500);
const FIELDS = "title,abstract,year,venue,externalIds,citationCount,openAccessPdf,authors,publicationDate,url,isOpenAccess";

interface S2Paper {
  paperId: string;
  title?: string;
  abstract?: string | null;
  year?: number | null;
  venue?: string | null;
  externalIds?: { DOI?: string; ArXiv?: string } | null;
  citationCount?: number | null;
  openAccessPdf?: { url?: string | null } | null;
  isOpenAccess?: boolean;
  authors?: { name: string }[];
  publicationDate?: string | null;
  url?: string | null;
}

export async function searchSemanticScholar(q: DiscoverQuery): Promise<DiscoveredPaper[]> {
  const p = new URLSearchParams({ query: q.q, limit: String(Math.min(q.limit, 50)), fields: FIELDS });
  if (q.yearFrom || q.yearTo) p.set("year", `${q.yearFrom ?? ""}-${q.yearTo ?? ""}`);
  if (q.openAccessOnly) p.set("openAccessPdf", "");
  const headers: Record<string, string> = config.SEMANTIC_SCHOLAR_API_KEY ? { "x-api-key": config.SEMANTIC_SCHOLAR_API_KEY } : {};
  const data = await queue(() =>
    getJson<{ data?: S2Paper[] }>(`https://api.semanticscholar.org/graph/v1/paper/search?${p}`, { headers, retries: 1 }),
  );
  return (data.data ?? [])
    .filter((x) => x.title)
    .map((x) => ({
      source: "semantic_scholar" as const,
      sourceId: x.paperId,
      title: x.title!.trim(),
      abstract: x.abstract ?? null,
      year: x.year ?? null,
      publishedOn: x.publicationDate ?? null,
      venue: x.venue || null,
      url: x.url ?? `https://www.semanticscholar.org/paper/${x.paperId}`,
      pdfUrl: x.openAccessPdf?.url || (x.externalIds?.ArXiv ? `https://arxiv.org/pdf/${x.externalIds.ArXiv}` : null),
      doi: cleanDoi(x.externalIds?.DOI),
      arxivId: x.externalIds?.ArXiv ?? null,
      openalexId: null,
      s2Id: x.paperId,
      isOpenAccess: Boolean(x.isOpenAccess || x.openAccessPdf?.url),
      citationCount: x.citationCount ?? 0,
      authors: (x.authors ?? []).map((a) => ({ name: a.name })),
      concepts: [],
      referencedWorks: [],
    }));
}
