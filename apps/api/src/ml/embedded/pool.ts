/** Runs in-process ML calls on one background worker thread (see worker.ts); restarts it if it dies. */
import { Worker } from "node:worker_threads";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function spawn(): Worker {
  const isTs = import.meta.url.endsWith(".ts"); // dev (tsx) runs sources, production runs dist/*.js
  const w = new Worker(new URL(`./worker.${isTs ? "ts" : "js"}`, import.meta.url), {
    execArgv: isTs ? ["--import", "tsx"] : [],
    // caps the worker's JS heap (pdf.js, tokenizer, UMAP); exceeding it fails one job, not the server
    resourceLimits: { maxOldGenerationSizeMb: 160 },
  });
  w.on("message", ({ id, result, error }: { id: number; result?: unknown; error?: string }) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (error !== undefined) p.reject(new Error(error));
    else p.resolve(result);
  });
  const fail = (err: Error) => {
    if (worker === w) worker = null;
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  w.on("error", (e) => fail(e instanceof Error ? e : new Error(String(e))));
  w.on("exit", (code) => fail(new Error(code === 0 ? "ML worker stopped" : `ML worker stopped (code ${code}): the document may be too large for this server`)));
  w.unref(); // never keeps the process alive on shutdown
  return w;
}

export function runInWorker<T>(op: "embed" | "parsePdf" | "cluster", args: unknown[], transfer: ArrayBuffer[] = []): Promise<T> {
  worker ??= spawn();
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    worker!.postMessage({ id, op, args }, transfer);
  });
}
