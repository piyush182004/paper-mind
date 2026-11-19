/** Fan-out discovery across sources, merged and de-duplicated (DOI > arXiv id > normalised title). */
import { HttpError } from "../lib/http.js";
import { normKey } from "../lib/text.js";
import { searchArxiv } from "./arxiv.js";
import { searchOpenAlex } from "./openalex.js";
import type { DiscoverQuery, DiscoveredPaper, SourceName } from "./types.js";

const SEARCHERS: Record<SourceName, (q: DiscoverQuery) => Promise<DiscoveredPaper[]>> = {
  openalex: searchOpenAlex,
  arxiv: searchArxiv,
};

export const availableSources = (): { name: SourceName; enabled: boolean; note?: string }[] => [
  { name: "openalex", enabled: true },
  { name: "arxiv", enabled: true },
];

export function dedupeKey(p: Pick<DiscoveredPaper, "doi" | "arxivId" | "title">): string {
  if (p.arxivId) return `arxiv:${p.arxivId.replace(/v\d+$/, "")}`;
  if (p.doi) return p.doi.startsWith("10.48550/arxiv.") ? `arxiv:${p.doi.slice(15)}` : `doi:${p.doi}`;
  return `title:${normKey(p.title)}`;
}

/** Merge two records of the same paper, keeping the richest value of every field. */
function merge(a: DiscoveredPaper, b: DiscoveredPaper): DiscoveredPaper {
  return {
    ...a,
    abstract: (a.abstract?.length ?? 0) >= (b.abstract?.length ?? 0) ? a.abstract : b.abstract,
    pdfUrl: a.pdfUrl ?? b.pdfUrl,
    doi: a.doi ?? b.doi,
    arxivId: a.arxivId ?? b.arxivId,
    openalexId: a.openalexId ?? b.openalexId,
    s2Id: a.s2Id ?? b.s2Id,
    isOpenAccess: a.isOpenAccess || b.isOpenAccess,
    citationCount: Math.max(a.citationCount, b.citationCount),
    authors: a.authors.length >= b.authors.length ? a.authors : b.authors,
    concepts: a.concepts.length ? a.concepts : b.concepts,
    referencedWorks: a.referencedWorks.length ? a.referencedWorks : b.referencedWorks,
    venue: a.venue ?? b.venue,
  };
}

/** Plain-language reason a source could not answer (shown to the user next to the other results). */
function friendly(e: unknown): string {
  if (e instanceof HttpError && e.status === 429) return "busy right now, so these results come from the other source. Try again in a minute for more.";
  if (e instanceof Error && (e.name === "AbortError" || /abort|timeout/i.test(e.message))) return "did not respond in time; showing results from the other source.";
  return "could not be reached right now; showing results from the other source.";
}

type DiscoverResult = { results: (DiscoveredPaper & { foundIn: SourceName[] })[]; errors: Record<string, string> };
const cache = new Map<string, { at: number; value: DiscoverResult }>();
const CACHE_MS = 15 * 60_000;

/** Same search again (paging back, re-importing) is instant; only complete answers are cached. */
export async function discover(q: DiscoverQuery): Promise<DiscoverResult> {
  const key = JSON.stringify([q.q.toLowerCase(), [...q.sources].sort(), q.limit, q.yearFrom, q.yearTo, q.openAccessOnly]);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await discoverUncached(q);
  if (!Object.keys(value.errors).length) {
    cache.set(key, { at: Date.now(), value });
    if (cache.size > 300) cache.delete(cache.keys().next().value!);
  }
  return value;
}

async function discoverUncached(q: DiscoverQuery): Promise<DiscoverResult> {
  const enabled = [...new Set(q.sources)].filter((s) => s in SEARCHERS);
  const settled = await Promise.allSettled(enabled.map((s) => SEARCHERS[s](q)));
  const errors: Record<string, string> = {};
  const merged = new Map<string, DiscoveredPaper & { foundIn: SourceName[] }>();
  settled.forEach((r, i) => {
    const src = enabled[i];
    if (r.status === "rejected") {
      errors[src] = friendly(r.reason);
      return;
    }
    for (const p of r.value) {
      const key = dedupeKey(p);
      const prev = merged.get(key);
      merged.set(key, prev ? { ...merge(prev, p), foundIn: [...new Set([...prev.foundIn, src])] } : { ...p, foundIn: [src] });
    }
  });
  // second pass: a preprint and its published version have different ids but the same title
  const byTitle = new Map<string, DiscoveredPaper & { foundIn: SourceName[] }>();
  for (const p of merged.values()) {
    const k = normKey(p.title).replace(/\s/g, "");
    const prev = byTitle.get(k);
    byTitle.set(k, prev ? { ...merge(prev, p), foundIn: [...new Set([...prev.foundIn, ...p.foundIn])] } : p);
  }
  // papers confirmed by several sources first, then by citations
  const results = [...byTitle.values()].sort((a, b) => b.foundIn.length - a.foundIn.length || b.citationCount - a.citationCount);
  return { results: results.slice(0, q.limit * 2), errors };
}
