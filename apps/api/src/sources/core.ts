/** CORE (core.ac.uk): open-access full texts. Requires a free API key; disabled without one. */
import { config } from "../config.js";
import { getJson } from "../lib/http.js";
import { arxivFromUrl, cleanDoi, type DiscoverQuery, type DiscoveredPaper } from "./types.js";

interface CoreWork {
  id: number;
  title?: string;
  abstract?: string | null;
  yearPublished?: number | null;
  publishedDate?: string | null;
  doi?: string | null;
  downloadUrl?: string | null;
  sourceFulltextUrls?: string[];
  publisher?: string | null;
  journals?: { title?: string }[];
  citationCount?: number | null;
  authors?: { name: string }[];
  links?: { type: string; url: string }[];
}

export const coreEnabled = () => Boolean(config.CORE_API_KEY);

export async function searchCore(q: DiscoverQuery): Promise<DiscoveredPaper[]> {
  if (!config.CORE_API_KEY) return [];
  const parts = [q.q];
  if (q.yearFrom) parts.push(`yearPublished>=${q.yearFrom}`);
  if (q.yearTo) parts.push(`yearPublished<=${q.yearTo}`);
  const p = new URLSearchParams({ q: parts.join(" AND "), limit: String(Math.min(q.limit, 50)) });
  const data = await getJson<{ results?: CoreWork[] }>(`https://api.core.ac.uk/v3/search/works?${p}`, {
    headers: { Authorization: `Bearer ${config.CORE_API_KEY}` },
    timeoutMs: 30_000,
  });
  return (data.results ?? [])
    .filter((w) => w.title)
    .map((w) => {
      const landing = w.links?.find((l) => l.type === "display")?.url ?? null;
      return {
        source: "core" as const,
        sourceId: String(w.id),
        title: w.title!.trim(),
        abstract: w.abstract ?? null,
        year: w.yearPublished ?? null,
        publishedOn: w.publishedDate?.slice(0, 10) ?? null,
        venue: w.journals?.[0]?.title ?? w.publisher ?? null,
        url: landing ?? `https://core.ac.uk/works/${w.id}`,
        pdfUrl: w.downloadUrl ?? w.sourceFulltextUrls?.find((u) => u.endsWith(".pdf")) ?? null,
        doi: cleanDoi(w.doi),
        arxivId: arxivFromUrl(landing) ?? w.sourceFulltextUrls?.map(arxivFromUrl).find(Boolean) ?? null,
        openalexId: null,
        s2Id: null,
        isOpenAccess: true,
        citationCount: w.citationCount ?? 0,
        authors: (w.authors ?? []).map((a) => ({ name: a.name })),
        concepts: [],
        referencedWorks: [],
      };
    });
}
