/**
 * Worker thread for the in-process ML (embeddings, PDF parsing, clustering). This CPU-heavy work
 * must not run on the main thread: on a small instance it would block HTTP requests (including
 * the host's health checks) for many seconds. A worker that runs out of memory only fails the
 * current job; the server keeps running and the next call starts a fresh worker.
 */
import { parentPort } from "node:worker_threads";

type Msg = { id: number; op: "embed" | "parsePdf" | "cluster"; args: unknown[] };

parentPort!.on("message", async ({ id, op, args }: Msg) => {
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
    parentPort!.postMessage({ id, result });
  } catch (e) {
    parentPort!.postMessage({ id, error: e instanceof Error ? e.message : String(e) });
  }
});
