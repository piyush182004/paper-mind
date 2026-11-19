/**
 * Runs in-process ML calls in one child process (see worker.ts), started on demand and restarted
 * after it exits (idle timeout, memory cap or crash). Killing a process returns all its memory,
 * which a worker thread can't guarantee for native ONNX Runtime allocations.
 */
import { type ChildProcess, fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const OOM_EXIT_CODE = 70; // keep in sync with worker.ts

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; msg: { id: number; op: string; args: unknown[] }; retried?: boolean };
let child: ChildProcess | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function spawn(): ChildProcess {
  const isTs = import.meta.url.endsWith(".ts"); // dev (tsx) runs sources, production runs dist/*.js
  const file = fileURLToPath(new URL(`./worker.${isTs ? "ts" : "js"}`, import.meta.url));
  const c = fork(file, [], {
    serialization: "advanced", // structured clone: Uint8Array / nested arrays without JSON blow-up
    execArgv: [...(isTs ? ["--import", "tsx"] : []), "--max-old-space-size=160"],
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  c.on("message", ({ id, result, error }: { id: number; result?: unknown; error?: string }) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (error !== undefined) p.reject(new Error(error));
    else p.resolve(result);
  });
  c.on("exit", (code) => {
    if (child === c) child = null;
    // exited while idle just as a request arrived: resend those once to a fresh worker
    if (code === 0) {
      const again = [...pending.values()].filter((p) => !p.retried);
      for (const p of again) {
        p.retried = true;
        child ??= spawn();
        child.send(p.msg);
      }
      if (again.length === pending.size) return;
    }
    const err = new Error(code === OOM_EXIT_CODE
      ? "This document needs more memory than this server has, so it was skipped (try importing it as abstract-only)."
      : `ML worker stopped unexpectedly (code ${code})`);
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  });
  c.on("error", () => undefined); // reported through "exit"
  c.unref();
  (c.channel as unknown as { unref?: () => void } | undefined)?.unref?.(); // never keeps the server alive on shutdown
  return c;
}

export function runInWorker<T>(op: "embed" | "parsePdf" | "cluster", args: unknown[], _transfer: ArrayBuffer[] = []): Promise<T> {
  if (!child || child.exitCode !== null || !child.connected) child = spawn();
  const id = nextId++;
  const c = child;
  return new Promise<T>((resolve, reject) => {
    const msg = { id, op, args };
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, msg });
    c.send(msg, (err) => {
      if (err && pending.delete(id)) reject(new Error(`ML worker unavailable: ${err.message}`));
    });
  });
}
