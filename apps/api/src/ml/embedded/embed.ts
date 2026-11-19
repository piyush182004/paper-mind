/**
 * In-process embeddings: the same BAAI/bge-small-en-v1.5 model as the Python service (CLS pooling,
 * L2-normalised, 384-dim, BGE query prefix), run with ONNX Runtime via transformers.js. The 8-bit
 * build (~35 MB) keeps the whole app inside a 512 MB free-tier instance.
 */
import path from "node:path";
import { config } from "../../config.js";

const MODEL = "Xenova/bge-small-en-v1.5";
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
const BATCH = 16; // bounds peak memory on small instances

type Extractor = (texts: string[], opts: { pooling: "cls"; normalize: boolean }) => Promise<{ tolist(): number[][] }>;
let loading: Promise<Extractor> | null = null;

export function loadEmbedder(): Promise<Extractor> {
  loading ??= (async () => {
    const t = await import("@huggingface/transformers");
    t.env.cacheDir = path.resolve(config.MODELS_DIR);
    const pipe = await t.pipeline("feature-extraction", MODEL, { dtype: "q8" });
    return pipe as unknown as Extractor;
  })().catch((e) => {
    loading = null; // allow a retry (e.g. the model download failed)
    throw e;
  });
  return loading;
}

export async function embed(texts: string[], isQuery = false): Promise<number[][]> {
  if (!texts.length) return [];
  const extractor = await loadEmbedder();
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH).map((t) => (isQuery ? QUERY_PREFIX + t : t).slice(0, 4000));
    const res = await extractor(batch, { pooling: "cls", normalize: true });
    out.push(...res.tolist().map((v) => v.map((x) => Math.round(x * 1e6) / 1e6)));
  }
  return out;
}
