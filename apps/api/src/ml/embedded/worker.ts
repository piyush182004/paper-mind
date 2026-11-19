/**
 * Child process for the in-process ML (embeddings, PDF parsing, clustering).
 *  - CPU-heavy work never blocks the web server's event loop (health checks stay instant).
 *  - It polices memory: when the whole instance (this process + the web server) gets close to the
 *    host's limit it exits, so the request fails and is retried on a fresh process instead of the
 *    host killing the whole server. On Linux the instance total comes from the container's cgroup;
 *    elsewhere this process's own size is capped at ML_WORKER_MAX_RSS_MB.
 *  - It exits after a few idle minutes, returning the model's memory to the instance.
 * Requests are handled one at a time so two large inputs never overlap in memory.
 */
import fs from "node:fs";

const MAX_RSS_MB = Number(process.env.ML_WORKER_MAX_RSS_MB ?? 340);
const IDLE_MS = Number(process.env.ML_WORKER_IDLE_MS ?? 5 * 60_000);
const HEADROOM_MB = 40; // stop this far below the instance limit
export const OOM_EXIT_CODE = 70;

type Msg = { id: number; op: "embed" | "parsePdf" | "cluster"; args: unknown[] };

/** Container memory in use (minus reclaimable file cache, like the host counts it) and its limit, in MB. */
function readCgroup(): { usedMb: number; limitMb: number } | null {
  const read = (f: string) => fs.readFileSync(f, "utf8").trim();
  const num = (s: string) => (/^\d+$/.test(s) ? Number(s) / 1e6 : NaN);
  const hostLimit = Number(process.env.ML_HOST_MEMORY_MB ?? (process.env.RENDER ? 512 : NaN));
  for (const [cur, max, stat, inactive] of [
    ["/sys/fs/cgroup/memory.current", "/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory.stat", "inactive_file"], // cgroup v2
    ["/sys/fs/cgroup/memory/memory.usage_in_bytes", "/sys/fs/cgroup/memory/memory.limit_in_bytes", "/sys/fs/cgroup/memory/memory.stat", "total_inactive_file"], // v1
  ]) {
    try {
      const used = num(read(cur)) - Number(new RegExp(`^${inactive} (\\d+)$`, "m").exec(read(stat))?.[1] ?? 0) / 1e6;
      let limit = num(read(max));
      if (!(limit > 0 && limit < 64_000)) limit = hostLimit; // "max" / huge = not limited here
      if (Number.isFinite(used) && limit > 0) return { usedMb: used, limitMb: Math.min(limit, hostLimit || limit) };
    } catch {
      /* not this cgroup version */
    }
  }
  return null;
}

// at start-up the instance is only the web server + this fresh process: a reading above 60 % of the
// limit means the cgroup isn't this instance's own, so fall back to the per-process cap
const cgroup = ((c) => (c && c.usedMb < c.limitMb * 0.6 ? c : null))(process.platform === "linux" ? readCgroup() : null);
console.error(cgroup
  ? `[ml-worker] memory guard: instance limit ${Math.round(cgroup.limitMb)} MB (now ${Math.round(cgroup.usedMb)} MB in use)`
  : `[ml-worker] memory guard: ${MAX_RSS_MB} MB for this process`);

setInterval(() => {
  const rss = process.memoryUsage().rss / 1e6;
  const c = cgroup && readCgroup();
  const over = c ? c.usedMb > c.limitMb - HEADROOM_MB || rss > c.limitMb * 0.85 : rss > MAX_RSS_MB;
  if (over) {
    console.error(`[ml-worker] memory guard tripped (process ${Math.round(rss)} MB${c ? `, instance ${Math.round(c.usedMb)}/${Math.round(c.limitMb)} MB` : ""}): restarting`);
    process.exit(OOM_EXIT_CODE);
  }
}, 200);

let busy = 0;
let idle: NodeJS.Timeout | undefined;
const armIdle = () => {
  clearTimeout(idle);
  if (busy === 0) idle = setTimeout(() => process.exit(0), IDLE_MS);
};

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
