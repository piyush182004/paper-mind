/** Fan-out discovery across sources, merged and de-duplicated (DOI > arXiv id > normalised title). */
import { normKey } from "../lib/text.js";
import { searchArxiv } from "./arxiv.js";
import { coreEnabled, searchCore } from "./core.js";
import { searchOpenAlex } from "./openalex.js";
import { searchSemanticScholar } from "./semanticScholar.js";
import type { DiscoverQuery, DiscoveredPaper, SourceName } from "./types.js";

const SEARCHERS: Record<SourceName, (q: DiscoverQuery) => Promise<DiscoveredPaper[]>> = {
  openalex: searchOpenAlex,
  arxiv: searchArxiv,
  semantic_scholar: searchSemanticScholar,
  core: searchCore,
};

export const availableSources = (): { name: SourceName; enabled: boolean; note?: string }[] => [
  { name: "openalex", enabled: true },
  { name: "arxiv", enabled: true },
  { name: "semantic_scholar", enabled: true, note: "shared rate limit without a key" },
  { name: "core", enabled: coreEnabled(), note: coreEnabled() ? undefined : "set CORE_API_KEY (free) to enable" },
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

export async function discover(q: DiscoverQuery): Promise<{ results: (DiscoveredPaper & { foundIn: SourceName[] })[]; errors: Record<string, string> }> {
  const enabled = q.sources.filter((s) => s !== "core" || coreEnabled());
  const settled = await Promise.allSettled(enabled.map((s) => SEARCHERS[s](q)));
  const errors: Record<string, string> = {};
  const merged = new Map<string, DiscoveredPaper & { foundIn: SourceName[] }>();
  settled.forEach((r, i) => {
    const src = enabled[i];
    if (r.status === "rejected") {
      errors[src] = r.reason instanceof Error ? r.reason.message : String(r.reason);
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
