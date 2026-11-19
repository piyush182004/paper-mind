/** fetch with timeout, bounded retries (5xx / 429 / network) and a polite User-Agent. */
export class HttpError extends Error {
  constructor(message: string, readonly status: number, readonly url: string) {
    super(message);
  }
}

const UA = "PaperMind/0.1 (research-intelligence; +https://github.com)";

export interface FetchOpts extends RequestInit {
  timeoutMs?: number;
  retries?: number;
  /** give up instead of retrying when the server asks us to wait longer than this (interactive calls) */
  maxRetryWaitMs?: number;
}

export async function fetchWithRetry(url: string, opts: FetchOpts = {}): Promise<Response> {
  const { timeoutMs = 20_000, retries = 2, maxRetryWaitMs = 10_000, ...init } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal, headers: { "User-Agent": UA, ...(init.headers ?? {}) } });
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const ra = Number(res.headers.get("retry-after"));
        const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 600 * 2 ** attempt;
        if (wait > maxRetryWaitMs) return res; // caller reports "busy" instead of freezing the page
        await sleep(wait);
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(500 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function getJson<T>(url: string, opts: FetchOpts = {}): Promise<T> {
  const res = await fetchWithRetry(url, { ...opts, headers: { Accept: "application/json", ...(opts.headers ?? {}) } });
  if (!res.ok) throw new HttpError(`${res.status} from ${new URL(url).host}`, res.status, url);
  return (await res.json()) as T;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Serialises calls with a minimum gap (e.g. arXiv asks for ≥3 s between requests). */
export function throttle(minGapMs: number) {
  let next = 0;
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(async () => {
      const wait = next - Date.now();
      if (wait > 0) await sleep(wait);
      next = Date.now() + minGapMs;
      return fn();
    });
    chain = run.catch(() => undefined);
    return run;
  };
}
