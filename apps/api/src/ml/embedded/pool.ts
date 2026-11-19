/**
 * Runs in-process ML calls in one child process (see worker.ts), started on demand and restarted
 * after it exits (idle timeout, memory guard or crash). Killing a process returns all its memory,
 * which a worker thread can't guarantee for native ONNX Runtime allocations.
 */
import { type ChildProcess, fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const OOM_EXIT_CODE = 70; // keep in sync with worker.ts
/** a single call (one slice of texts, one PDF, one clustering run) never legitimately takes this long */
const CALL_TIMEOUT_MS = Number(process.env.ML_CALL_TIMEOUT_MS ?? 8 * 60_000);

/** The worker ran out of memory and was restarted: retrying a smaller piece on a fresh one can work. */
export class WorkerMemoryError extends Error {
  readonly oom = true;
}

type Msg = { id: number; op: string; args: unknown[] };
type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  msg: Msg;
  owner: ChildProcess; // the process working on it
  timer: NodeJS.Timeout;
  retried?: boolean;
};
let child: ChildProcess | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function settle(id: number): Pending | undefined {
  const p = pending.get(id);
  if (p) {
    clearTimeout(p.timer);
    pending.delete(id);
  }
  return p;
}

const ownedBy = (c: ChildProcess) => [...pending.entries()].filter(([, p]) => p.owner === c);

/** the current process, or a fresh one if it has exited or is being retired */
function current(): ChildProcess {
  if (!child || child.exitCode !== null || !child.connected) child = spawn();
  return child;
}

function spawn(): ChildProcess {
  const isTs = import.meta.url.endsWith(".ts"); // dev (tsx) runs sources, production runs dist/*.js
  const file = fileURLToPath(new URL(`./worker.${isTs ? "ts" : "js"}`, import.meta.url));
  const c = fork(file, [], {
    serialization: "advanced", // structured clone: Uint8Array / nested arrays without JSON blow-up
    execArgv: [...(isTs ? ["--import", "tsx"] : []), "--max-old-space-size=160"],
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    // glibc: fewer per-thread malloc arenas = less memory held by ONNX Runtime's native allocations
    env: { ...process.env, MALLOC_ARENA_MAX: "2" },
  });
  c.on("message", ({ id, result, error }: { id: number; result?: unknown; error?: string }) => {
    const p = settle(id);
    if (!p) return;
    if (error !== undefined) p.reject(new Error(error));
    else p.resolve(result);
    // a parsed PDF leaves pdf.js memory behind: retire this process so the embedding that
    // follows starts on a clean one (only when nothing else is waiting on it)
    if (p.msg.op === "parsePdf" && !ownedBy(c).length) {
      if (child === c) child = null;
      c.kill();
    }
  });
  c.on("exit", (code) => {
    if (child === c) child = null;
    const mine = ownedBy(c);
    if (!mine.length) return;
    // exited while idle just as a request arrived: resend those once to a fresh worker
    if (code === 0) {
      for (const [, p] of mine) {
        if (p.retried) continue;
        p.retried = true;
        p.owner = current();
        p.owner.send(p.msg);
      }
    }
    const err = code === OOM_EXIT_CODE
      ? new WorkerMemoryError("This document needs more memory than this server has.")
      : new Error(`ML worker stopped unexpectedly (code ${code})`);
    for (const [id, p] of mine) if (p.owner === c) settle(id)?.reject(err);
  });
  c.on("error", () => undefined); // reported through "exit"
  c.unref();
  (c.channel as unknown as { unref?: () => void } | undefined)?.unref?.(); // never keeps the server alive on shutdown
  return c;
}

export function runInWorker<T>(op: "embed" | "parsePdf" | "cluster", args: unknown[], _transfer: ArrayBuffer[] = []): Promise<T> {
  const c = current();
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    const msg = { id, op, args };
    // a hung call is stopped with its process (other calls on it are re-sent or fail), never awaited forever
    const timer = setTimeout(() => {
      const p = settle(id);
      if (!p) return;
      p.reject(new Error(`ML ${op} took longer than ${Math.round(CALL_TIMEOUT_MS / 60_000)} minutes and was stopped`));
      if (child === p.owner) child = null;
      p.owner.kill();
    }, CALL_TIMEOUT_MS);
    timer.unref();
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, msg, owner: c, timer });
    c.send(msg, (err) => {
      if (err) settle(id)?.reject(new Error(`ML worker unavailable: ${err.message}`));
    });
  });
}
