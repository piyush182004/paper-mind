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

// Only memory the kernel can't drop counts. Cached files (node_modules, the model file, shared
// libraries) also show up in RSS and in the cgroup's usage, but the kernel frees those itself
// under pressure, so counting them made the guard trip hundreds of MB too early.
const linux = process.platform === "linux";
/** the number after `key` on its own line ("RssAnon:  1234 kB" in /proc, "file 5678" bytes in cgroup files) */
const field = (text: string, key: string) => Number(new RegExp(`^${key}:?\\s+(\\d+)`, "m").exec(text)?.[1] ?? NaN);

/** this process: anonymous + shared memory (MB); RSS elsewhere */
function processMb(): number {
  if (linux) {
    try {
      const st = fs.readFileSync("/proc/self/status", "utf8");
      const v = (field(st, "RssAnon") + (field(st, "RssShmem") || 0)) / 1024;
      if (Number.isFinite(v)) return v;
    } catch {
      /* fall through */
    }
  }
  return process.memoryUsage().rss / 1e6;
}

/** the whole instance (container cgroup) minus its file cache, and the limit, in MB */
function readCgroup(): { usedMb: number; limitMb: number } | null {
  const read = (f: string) => fs.readFileSync(f, "utf8").trim();
  const bytes = (s: string) => (/^\d+$/.test(s) ? Number(s) / 1e6 : NaN);
  const hostLimit = Number(process.env.ML_HOST_MEMORY_MB ?? (process.env.RENDER ? 512 : NaN));
  const v2 = () => {
    const stat = read("/sys/fs/cgroup/memory.stat");
    return { used: bytes(read("/sys/fs/cgroup/memory.current")) - (field(stat, "file") - (field(stat, "shmem") || 0)) / 1e6, max: read("/sys/fs/cgroup/memory.max") };
  };
  const v1 = () => {
    const stat = read("/sys/fs/cgroup/memory/memory.stat");
    return { used: (field(stat, "total_rss") + (field(stat, "total_shmem") || 0)) / 1e6, max: read("/sys/fs/cgroup/memory/memory.limit_in_bytes") };
  };
  for (const get of [v2, v1]) {
    try {
      const { used, max } = get();
      let limit = bytes(max);
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
const cgroup = ((c) => (c && c.usedMb < c.limitMb * 0.6 ? c : null))(linux ? readCgroup() : null);
const processCap = cgroup ? cgroup.limitMb * 0.8 : MAX_RSS_MB;
console.error(cgroup
  ? `[ml-worker] memory guard: instance limit ${Math.round(cgroup.limitMb)} MB (${Math.round(cgroup.usedMb)} MB in use at start)`
  : `[ml-worker] memory guard: ${MAX_RSS_MB} MB for this process`);

setInterval(() => {
  const mine = processMb();
  const c = cgroup && readCgroup();
  if ((c && c.usedMb > c.limitMb - HEADROOM_MB) || mine > processCap) {
    console.error(`[ml-worker] memory guard tripped (process ${Math.round(mine)} MB${c ? `, instance ${Math.round(c.usedMb)}/${Math.round(c.limitMb)} MB` : ""}): restarting`);
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
