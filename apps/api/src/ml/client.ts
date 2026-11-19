/** Client for the internal Python ML service (embeddings, reranking, PDF parsing, clustering). */
import { config } from "../config.js";

export class MlUnavailableError extends Error {
  readonly status = 503;
  constructor(message = "The ML service is unavailable. Start services/ml (see README).") {
    super(message);
  }
}

export interface PdfBlock {
  page: number;
  kind: "heading" | "text" | "table" | "figure" | "equation";
  section: string;
  text: string;
}
export interface ParsedPdf {
  pages: number;
  parsed_pages: number;
  title: string | null;
  author: string | null;
  blocks: PdfBlock[];
}
export interface ClusterOut {
  algorithm: string;
  params: Record<string, unknown>;
  labels: number[];
  probabilities: number[];
  outlier_scores: number[];
  xy: [number, number][];
  clusters: { label: number; name: string; keywords: { term: string; score: number }[]; size: number; coherence: number; parent: number | null }[];
  parents: { label: number; name: string; keywords: { term: string; score: number }[]; children: number[]; size: number }[];
  silhouette: number | null;
  n_noise: number;
}

async function call<T>(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? config.ML_TIMEOUT_MS);
  try {
    const res = await fetch(`${config.ML_SERVICE_URL}${path}`, {
      ...init,
      signal: ctrl.signal,
      headers: {
        ...(init.headers ?? {}),
        ...(config.ML_SERVICE_TOKEN ? { "X-Internal-Token": config.ML_SERVICE_TOKEN } : {}),
      },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      if (res.status >= 500) throw new MlUnavailableError(`ML service error ${res.status}`);
      const err = new Error(`ML service rejected ${path}: ${res.status} ${detail.slice(0, 200)}`) as Error & { status: number };
      err.status = res.status;
      throw err;
    }
    return (await res.json()) as T;
  } catch (e) {
    if (e instanceof MlUnavailableError || (e as { status?: number }).status) throw e;
    throw new MlUnavailableError(); // connection refused, timeout, DNS…
  } finally {
    clearTimeout(timer);
  }
}

const json = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const ml = {
  health: () => call<{ status: string; embed_model: string }>("/health", { timeoutMs: 3000 }),

  async embed(texts: string[], isQuery = false): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 64) {
      const r = await call<{ embeddings: number[][] }>("/embed", json({ texts: texts.slice(i, i + 64), is_query: isQuery }));
      out.push(...r.embeddings);
    }
    return out;
  },

  async embedQuery(text: string): Promise<number[]> {
    return (await ml.embed([text], true))[0];
  },

  rerank: (query: string, documents: string[]) =>
    call<{ scores: number[] }>("/rerank", json({ query, documents })).then((r) => r.scores),

  parsePdf: (pdf: Uint8Array) =>
    call<ParsedPdf>("/parse-pdf", { method: "POST", headers: { "Content-Type": "application/pdf" }, body: pdf }),

  cluster: (embeddings: number[][], docs: string[], algorithm: "hdbscan" | "kmeans", opts: { minClusterSize?: number; k?: number } = {}) =>
    call<ClusterOut>("/cluster", json({ embeddings, docs, algorithm, min_cluster_size: opts.minClusterSize, k: opts.k })),
};
