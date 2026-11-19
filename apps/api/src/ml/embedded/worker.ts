/**
 * Child process for the in-process ML (embeddings, PDF parsing, clustering).
 *  - CPU-heavy work never blocks the web server's event loop (health checks stay instant).
 *  - It polices its own memory: above ML_WORKER_MAX_RSS_MB it exits, so one oversized document
 *    fails one job instead of the host killing the whole server for exceeding its memory limit.
 *  - It exits after a few idle minutes, returning the model's memory to the instance.
 * Requests are handled one at a time so two large inputs never overlap in memory.
 */
const MAX_RSS_MB = Number(process.env.ML_WORKER_MAX_RSS_MB ?? 300);
const IDLE_MS = Number(process.env.ML_WORKER_IDLE_MS ?? 5 * 60_000);
export const OOM_EXIT_CODE = 70;

type Msg = { id: number; op: "embed" | "parsePdf" | "cluster"; args: unknown[] };

let busy = 0;
let idle: NodeJS.Timeout | undefined;
const armIdle = () => {
  clearTimeout(idle);
  if (busy === 0) idle = setTimeout(() => process.exit(0), IDLE_MS);
};

setInterval(() => {
  if (process.memoryUsage().rss / 1e6 > MAX_RSS_MB) process.exit(OOM_EXIT_CODE);
}, 200);

async function handle({ id, op, args }: Msg): Promise<void> {
  try {
    let result: unknown;
    if (op === "embed") {
      const { embed } = await import("./embed.js");
      result = await embed(args[0] as string[], args[1] as boolean);
    } else if (op === "parsePdf") {
      const { parsePdf } = await import("./pdf.js");
      result = await parsePdf(args[0] as Uint8Array);
    } else {
      const { cluster } = await import("./cluster.js");
      result = await cluster(args[0] as number[][], args[1] as string[], args[2] as "hdbscan" | "kmeans", args[3] as { k?: number });
    }
    process.send?.({ id, result });
  } catch (e) {
    process.send?.({ id, error: e instanceof Error ? e.message : String(e) });
  }
}

let chain = Promise.resolve();
process.on("message", (msg: Msg) => {
  busy++;
  clearTimeout(idle);
  chain = chain.then(() => handle(msg)).finally(() => {
    busy--;
    armIdle();
  });
});
process.on("disconnect", () => process.exit(0)); // the server stopped
armIdle();
