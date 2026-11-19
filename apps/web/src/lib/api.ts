/** Typed client for the PaperMind API (same origin in production; proxied by Vite in dev). */
const BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, "") ?? "";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (method !== "GET") headers.set("X-PaperMind", "1"); // CSRF guard: browsers can't add this cross-site
  const res = await fetch(`${BASE}/api${path}`, { ...init, headers, credentials: "include" });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith("/auth/")) window.dispatchEvent(new Event("pm:signed-out"));
  if (!res.ok) {
    const issues = Array.isArray(body?.issues) ? `: ${body.issues.map((i: { path: string; message: string }) => `${i.path} ${i.message}`).join("; ")}` : "";
    throw new ApiError((body?.error ?? `Request failed (${res.status})`) + issues, res.status);
  }
  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
  upload: <T>(path: string, files: File[]) => {
    const fd = new FormData();
    files.forEach((f) => fd.append("file", f, f.name));
    return request<T>(path, { method: "POST", body: fd });
  },
};

export const qs = (o: Record<string, string | number | boolean | undefined | null>) =>
  new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => [k, String(v)])).toString();

// ------------------------------------------------------------------------- types
export type SourceName = "openalex" | "arxiv";

export interface Health { status: string; db: string; ml: "ok" | "unavailable"; llm: string | null }

export interface DiscoveredPaper {
  source: SourceName; sourceId: string; title: string; abstract: string | null; year: number | null; publishedOn: string | null;
  venue: string | null; url: string | null; pdfUrl: string | null; doi: string | null; arxivId: string | null; openalexId: string | null;
  s2Id: string | null; isOpenAccess: boolean; citationCount: number; authors: { name: string; openalexId?: string | null; orcid?: string | null }[];
  concepts: { name: string; score: number }[]; referencedWorks: string[]; foundIn: SourceName[]; libraryId: number | null;
}

export interface PaperListItem {
  id: number; source: string; doi: string | null; arxiv_id: string | null; title: string; abstract: string | null; year: number | null;
  venue: string | null; url: string | null; pdf_url: string | null; citation_count: number; status: string; status_detail: string | null;
  has_fulltext: boolean; page_count: number | null; created_at: string; authors: string | null; chunks: number;
}

export interface PaperDetail {
  paper: PaperListItem & { openalex_id: string | null; referenced_works: string[] };
  authors: { id: number; name: string; orcid: string | null }[];
  entities: { id: number; type: string; name: string; mentions: number; source: string; score: number | null; evidence: string | null }[];
  claims: { id: number; kind: "finding" | "limitation" | "contribution"; text: string; page: number | null; polarity: number }[];
  sections: { section: string | null; kind: string; page: number | null; chunks: number }[];
  cluster: { id: number; name: string } | null;
  references: { id: number; title: string; year: number | null }[];
  citedBy: { id: number; title: string; year: number | null }[];
}

export interface Job {
  id: number; kind: string; status: "queued" | "running" | "done" | "failed"; progress: number; message: string | null;
  payload: Record<string, unknown>; result: Record<string, unknown> | null; error: string | null; created_at: string; updated_at: string;
}

export interface Hit {
  chunkId: number; paperId: number; title: string; year: number | null; venue: string | null; section: string | null; kind: string;
  pageStart: number | null; pageEnd: number | null; content: string; context?: { before: string | null; after: string | null };
  via: "retrieval" | "graph"; graphReason?: string;
  scores: { bm25?: number; bm25Rank?: number; dense?: number; denseRank?: number; paperRank?: number; rrf: number; rerank?: number; final: number };
}
export interface SearchResult { query: string; hits: Hit[]; degraded: string[]; timings: Record<string, number> }

export interface Cluster { id: number; label: number; parent_id: number | null; level: number; name: string; keywords: { term: string; score: number }[]; size: number; coherence: number | null; mean_year: number | null }
export interface ClusterPoint { paper_id: number; title: string; year: number | null; citation_count: number; cluster_id: number | null; probability: number | null; outlier_score: number | null; x: number; y: number }
export interface ClusterState {
  run: { id: number; algorithm: string; params: Record<string, unknown>; n_papers: number; n_clusters: number; n_noise: number; silhouette: number | null; created_at: string } | null;
  clusters: Cluster[]; parents: Cluster[]; points: ClusterPoint[];
}
export interface ClusterMetric { id: number; name: string; parent: string | null; size: number; coherence: number | null; years: Record<string, number>; coverage: number; growth: number; recentShare: number; citations: number }

export type NodeType = "paper" | "author" | "concept" | "method" | "model" | "dataset" | "metric" | "task";
export interface GraphNode { key: string; type: NodeType; label: string; year?: number | null; citations?: number; clusterId?: number | null; pagerank: number; betweenness: number | null; degree: number; community: number }
export interface GraphEdge { source: string; target: string; type: "AUTHORED_BY" | "MENTIONS" | "CITES" | "SIMILAR_TO"; weight: number }
export interface GraphView { nodes: GraphNode[]; edges: GraphEdge[]; metricsComputed: boolean }

export interface Overview {
  papers: number; fulltext: number; processing: number; failed: number; chunks: number; postings: number; authors: number; entities: number;
  claims: number; citations: number; pages: number; coverage: number;
  entitiesByType: { type: string; n: number }[]; claimsByKind: { kind: string; n: number }[]; chunksByKind: { kind: string; n: number }[];
  papersByYear: { year: number; n: number }[]; topEntities: { type: string; name: string; papers: number }[];
}
export interface PaperScore {
  id: number; title: string; year: number | null; citations: number; clusterId: number | null; cluster: string | null; composite: number;
  components: Record<"citation_impact" | "graph_influence" | "novelty" | "centrality", number | null>; weights: Record<string, number>; missing: string[];
}

export interface ClaimRef { claimId: number; paperId: number; title: string; page: number | null; text: string; polarity: number }
export interface Contradiction { type: "opposite_findings" | "finding_vs_limitation"; score: number; components: Record<string, number>; shared: string[]; a: ClaimRef; b: ClaimRef }
export interface TrendSeries { type: string; name: string; papers: number; first: number; growth: number; emerging: boolean; share: { year: number; share: number }[] }
export interface Trends { window: number[]; rising: TrendSeries[]; declining: TrendSeries[]; emerging: TrendSeries[]; topics: { id: number; name: string; growth: number; size: number; recentShare: number }[] }
export interface Gaps {
  untestedCombinations: { method: string; target: string; targetType: string; methodPapers: number[]; targetPapers: number[]; score: number }[];
  recurringLimitations: { papers: number; claims: ClaimRef[] }[];
  underExploredTopics: { clusterId: number; name: string; size: number; growth: number; coverage: number }[];
}
export interface Comparison {
  papers: {
    id: number; title: string; year: number | null; venue: string | null; citations: number; fulltext: boolean; cluster: string | null;
    topics: string[]; methods: string[]; models: string[]; datasets: string[]; metrics: string[]; tasks: string[];
    contributions: { claimId: number; text: string; page: number | null }[]; findings: { claimId: number; text: string; page: number | null }[];
    limitations: { claimId: number; text: string; page: number | null }[]; reportedNumbers: { value: string; claimId: number; page: number | null }[];
  }[];
  shared: string[];
  similarity: (number | null)[][];
}

export type AssistMode = "qa" | "explain" | "summarize" | "compare" | "review";
export interface AssistSource { sid: number; paperId: number; title: string; year: number | null; page: number | null; section: string | null; kind: string; chunkId?: number; claimId?: number; text: string; via?: string }
export interface AssistResponse {
  mode: AssistMode; answer: string; generatedBy: "llm" | "extractive"; model: string | null; sources: AssistSource[];
  grounding: { coverage: number; cited: number[]; invalidCitationsRemoved: number[]; injectionFlags: number; notice?: string };
  usage?: { prompt: number; completion: number; cached: boolean };
}
export interface LlmUsage { configured: boolean; model: string; budget: number; usedToday: number; byRoute: { route: string; calls: number; cached: number; failed: number; tokens: number }[] }
