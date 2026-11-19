/**
 * ML operations: embeddings, PDF parsing, clustering (and reranking with the Python service).
 * ML_MODE=embedded runs them in-process; ML_MODE=service calls services/ml.
 */
import { config } from "../config.js";

const embedded = config.ML_MODE === "embedded";
const worker = () => import("./embedded/pool.js").then((m) => m.runInWorker);

export class MlUnavailableError extends Error {
  readonly status = 503;
  constructor(message = "The ML service is unavailable. Start services/ml (see README).") {
    super(message);
  }
}

/** The in-process model ran out of memory on this document even on a fresh process. */
export class MlMemoryError extends Error {
  readonly status = 503;
  readonly oom = true;
  constructor(message = "This document needs more memory than this server has.") {
    super(message);
  }
}

const EMBED_SLICE = 12;

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
  /** in-process models can't rerank (that needs the Python service's cross-encoder) */
  canRerank: !embedded,

  health: (): Promise<{ status: string; embed_model: string }> =>
    embedded ? Promise.resolve({ status: "ok", embed_model: "bge-small-en-v1.5 (in-process)" })
      : call<{ status: string; embed_model: string }>("/health", { timeoutMs: 3000 }),

  /** onProgress(done, total) is called after each slice, so long documents can report how far they got */
  async embed(texts: string[], isQuery = false, onProgress?: (done: number, total: number) => unknown): Promise<number[][]> {
    const out: number[][] = [];
    if (embedded) {
      const run = await worker();
      // small slices: a memory-guard restart costs one slice (retried once on a fresh process), not the document
      for (let i = 0; i < texts.length; i += EMBED_SLICE) {
        const slice = texts.slice(i, i + EMBED_SLICE);
        try {
          out.push(...(await run<number[][]>("embed", [slice, isQuery]).catch(async (e) => {
            if (!(e as { oom?: boolean }).oom) throw e;
            await new Promise((r) => setTimeout(r, 1500)); // let the stopped process's memory return first
            return run<number[][]>("embed", [slice, isQuery]);
          })));
        } catch (e) {
          if ((e as { oom?: boolean }).oom) throw new MlMemoryError();
          throw new MlUnavailableError(`Embedding failed: ${(e as Error).message}`);
        }
        await onProgress?.(out.length, texts.length);
      }
      return out;
    }
    for (let i = 0; i < texts.length; i += 64) {
      const r = await call<{ embeddings: number[][] }>("/embed", json({ texts: texts.slice(i, i + 64), is_query: isQuery }));
      out.push(...r.embeddings);
      await onProgress?.(out.length, texts.length);
    }
    return out;
  },

  async embedQuery(text: string): Promise<number[]> {
    return (await ml.embed([text], true))[0];
  },

  rerank: (query: string, documents: string[]) =>
    call<{ scores: number[] }>("/rerank", json({ query, documents })).then((r) => r.scores),

  async parsePdf(pdf: Uint8Array): Promise<ParsedPdf> {
    if (embedded) {
      const run = await worker();
      try {
        const copy = new Uint8Array(pdf); // own buffer, moved (not copied) to the worker
        return await run<ParsedPdf>("parsePdf", [copy], [copy.buffer as ArrayBuffer]);
      } catch (e) {
        const err = new Error(`Could not read this PDF: ${(e as Error).message}`) as Error & { status: number };
        err.status = 422;
        throw err;
      }
    }
    return call<ParsedPdf>("/parse-pdf", { method: "POST", headers: { "Content-Type": "application/pdf" }, body: pdf });
  },

  async cluster(embeddings: number[][], docs: string[], algorithm: "hdbscan" | "kmeans", opts: { minClusterSize?: number; k?: number } = {}): Promise<ClusterOut> {
    if (embedded) {
      const run = await worker();
      return run<ClusterOut>("cluster", [embeddings, docs, algorithm, { k: opts.k }]);
    }
    return call<ClusterOut>("/cluster", json({ embeddings, docs, algorithm, min_cluster_size: opts.minClusterSize, k: opts.k }));
  },
};
