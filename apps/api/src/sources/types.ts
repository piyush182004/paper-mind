export type SourceName = "openalex" | "arxiv" | "semantic_scholar" | "core";

/** A paper as returned by any discovery source, normalised to one shape. */
export interface DiscoveredPaper {
  source: SourceName;
  sourceId: string;
  title: string;
  abstract: string | null;
  year: number | null;
  publishedOn: string | null;
  venue: string | null;
  url: string | null;
  pdfUrl: string | null;
  doi: string | null;
  arxivId: string | null;
  openalexId: string | null;
  s2Id: string | null;
  isOpenAccess: boolean;
  citationCount: number;
  authors: { name: string; openalexId?: string | null; orcid?: string | null }[];
  concepts: { name: string; score: number }[]; // structured topics (OpenAlex) for the knowledge graph
  referencedWorks: string[];                     // OpenAlex work ids / DOIs of references
}

export interface DiscoverQuery {
  q: string;
  sources: SourceName[];
  limit: number;
  yearFrom?: number;
  yearTo?: number;
  openAccessOnly?: boolean;
}

export const cleanDoi = (d: string | null | undefined) =>
  d ? d.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi:/i, "").trim().toLowerCase() || null : null;

export const arxivFromUrl = (u: string | null | undefined): string | null => {
  const m = u?.match(/arxiv\.org\/(?:abs|pdf)\/([0-9]{4}\.[0-9]{4,5}|[a-z\-]+(?:\.[A-Z]{2})?\/[0-9]{7})/i);
  return m ? m[1] : null;
};
