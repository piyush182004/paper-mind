/**
 * In-process embeddings: the same BAAI/bge-small-en-v1.5 model as the Python service (CLS pooling,
 * L2-normalised, 384-dim, BGE query prefix), run with ONNX Runtime via transformers.js. The 8-bit
 * build (~35 MB) keeps the whole app inside a 512 MB free-tier instance.
 */
import path from "node:path";
import { config } from "../../config.js";

const MODEL = "Xenova/bge-small-en-v1.5";
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
// one text per run: no padding to the longest text in a batch, so it is both faster and lighter on one CPU
const BATCH = Number(process.env.ML_EMBED_BATCH ?? 1);

type Extractor = (texts: string[], opts: { pooling: "cls"; normalize: boolean }) => Promise<{ tolist(): number[][] }>;
let loading: Promise<Extractor> | null = null;

export function loadEmbedder(): Promise<Extractor> {
  loading ??= (async () => {
    const t = await import("@huggingface/transformers");
    t.env.cacheDir = path.resolve(config.MODELS_DIR);
    t.env.localModelPath = path.resolve(config.MODELS_DIR); // pre-placed model files are used without any download
    const pipe = await t.pipeline("feature-extraction", MODEL, {
      dtype: "q8",
      // no memory arena/pattern caching and one thread: ONNX Runtime otherwise keeps the peak
      // allocation of every batch, which grows past a 512 MB free instance. "basic" graph
      // optimisation skips the fused weight copies of the full level: ~45 MB less, same vectors.
      session_options: { enableCpuMemArena: false, enableMemPattern: false, graphOptimizationLevel: "basic",
        intraOpNumThreads: 1, interOpNumThreads: 1, executionMode: "sequential" },
    } as Parameters<typeof t.pipeline>[2]);
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
