/**
 * Topic clustering in-process (port of the Python BERTopic-style pipeline):
 *   embeddings --UMAP(5d)--> K-Means (k by silhouette) --> topics, distance-based outliers
 *              --UMAP(2d)--> map coordinates   (PCA below 12 papers, where UMAP is unstable)
 *   docs per topic --class-based TF-IDF--> keywords & names
 *   topic centroids --agglomerative (cosine, average)--> parent themes
 * HDBSCAN needs the Python service; requests for it run K-Means here and say so in `params`.
 */
import type { ClusterOut } from "../client.js";
import { ENGLISH_STOP_WORDS } from "./stopwords.js";

type Vec = number[];
const EXTRA_STOP = new Set(["paper", "propose", "proposed", "approach", "method", "methods", "results", "using", "based", "new", "show",
  "work", "study", "use", "used", "model", "models", "data", "different", "present", "also", "however", "existing", "problem",
  "performance", "task", "tasks", "et", "al", "non"]);

function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const dot = (a: Vec, b: Vec) => a.reduce((s, x, i) => s + x * b[i], 0);
const norm = (a: Vec) => Math.sqrt(dot(a, a));
const l2 = (a: Vec) => { const n = norm(a) || 1; return a.map((x) => x / n); };
const dist = (a: Vec, b: Vec) => Math.sqrt(a.reduce((s, x, i) => s + (x - b[i]) ** 2, 0));

/** PCA by power iteration with deflation (fine for a few hundred papers). */
function pca(x: Vec[], dims: number, seed = 42): Vec[] {
  const n = x.length, d = x[0].length;
  const mean = Array.from({ length: d }, (_, j) => x.reduce((s, r) => s + r[j], 0) / n);
  const c = x.map((r) => r.map((v, j) => v - mean[j]));
  const rand = rng(seed);
  const comps: Vec[] = [];
  for (let k = 0; k < Math.min(dims, Math.max(1, n - 1)); k++) {
    let v = l2(Array.from({ length: d }, () => rand() - 0.5));
    for (let it = 0; it < 100; it++) {
      const xv = c.map((r) => dot(r, v));
      let w = Array.from({ length: d }, (_, j) => c.reduce((s, r, i) => s + r[j] * xv[i], 0));
      for (const p of comps) { const pr = dot(w, p); w = w.map((x2, j) => x2 - pr * p[j]); }
      const nw = norm(w);
      if (!nw) break;
      v = w.map((x2) => x2 / nw);
    }
    comps.push(v);
  }
  return c.map((r) => Array.from({ length: dims }, (_, k) => (comps[k] ? dot(r, comps[k]) : 0)));
}

async function reduce(x: Vec[], dims: number, seed: number): Promise<Vec[]> {
  const n = x.length;
  if (n <= 1) return x.map(() => Array(dims).fill(0));
  if (n < 12) return pca(x, dims, seed);
  const { UMAP } = await import("umap-js");
  const umap = new UMAP({
    nComponents: dims, nNeighbors: Math.min(15, n - 1), minDist: dims > 2 ? 0.05 : 0.1, random: rng(seed),
    distanceFn: (a: Vec, b: Vec) => 1 - dot(a, b),
  });
  return umap.fit(x);
}

function kmeans(x: Vec[], k: number, seed: number, inits = 10): { labels: number[]; centers: Vec[]; inertia: number } {
  const rand = rng(seed);
  let best = { labels: [] as number[], centers: [] as Vec[], inertia: Infinity };
  for (let init = 0; init < inits; init++) {
    // k-means++ seeding
    const centers: Vec[] = [x[Math.floor(rand() * x.length)]];
    while (centers.length < k) {
      const d2 = x.map((p) => Math.min(...centers.map((c) => dist(p, c) ** 2)));
      const total = d2.reduce((s, v) => s + v, 0);
      let r = rand() * total, i = 0;
      while (i < x.length - 1 && (r -= d2[i]) > 0) i++;
      centers.push(x[i]);
    }
    let labels = x.map(() => 0);
    for (let it = 0; it < 100; it++) {
      const next = x.map((p) => { let bi = 0, bd = Infinity; centers.forEach((c, ci) => { const dd = dist(p, c); if (dd < bd) { bd = dd; bi = ci; } }); return bi; });
      const changed = next.some((l, i) => l !== labels[i]);
      labels = next;
      for (let ci = 0; ci < k; ci++) {
        const m = x.filter((_, i) => labels[i] === ci);
        if (m.length) centers[ci] = m[0].map((_, j) => m.reduce((s, p) => s + p[j], 0) / m.length);
      }
      if (!changed && it > 0) break;
    }
    const inertia = x.reduce((s, p, i) => s + dist(p, centers[labels[i]]) ** 2, 0);
    if (inertia < best.inertia) best = { labels, centers: centers.map((c) => [...c]), inertia };
  }
  return best;
}

function silhouette(x: Vec[], labels: number[]): number {
  const ids = [...new Set(labels)];
  if (ids.length < 2) return -1;
  let total = 0;
  x.forEach((p, i) => {
    const mean = (c: number) => { const m = x.filter((_, j) => labels[j] === c && j !== i); return m.length ? m.reduce((s, q) => s + dist(p, q), 0) / m.length : 0; };
    const own = x.filter((_, j) => labels[j] === labels[i]).length;
    if (own <= 1) return; // singleton: silhouette 0
    const a = mean(labels[i]);
    const b = Math.min(...ids.filter((c) => c !== labels[i]).map(mean));
    total += (b - a) / Math.max(a, b, 1e-12);
  });
  return total / x.length;
}

/** Class-based TF-IDF over unigrams + bigrams: each topic is treated as one document. */
function ctfidf(docs: string[], labels: number[], topN = 8): Map<number, [string, number][]> {
  const uniq = [...new Set(labels.filter((l) => l >= 0))].sort((a, b) => a - b);
  const stop = (w: string) => ENGLISH_STOP_WORDS.has(w) || EXTRA_STOP.has(w);
  const terms = (doc: string) => {
    const toks = (doc.toLowerCase().match(/\b[a-z][a-z0-9-]{2,}\b/g) ?? []).filter((t) => !stop(t));
    const out = [...toks];
    for (let i = 0; i + 1 < toks.length; i++) out.push(`${toks[i]} ${toks[i + 1]}`);
    return out;
  };
  const tf = uniq.map((c) => {
    const m = new Map<string, number>();
    docs.forEach((d, i) => { if (labels[i] === c) for (const t of terms(d)) m.set(t, (m.get(t) ?? 0) + 1); });
    return m;
  });
  const colSum = new Map<string, number>();
  let all = 0;
  for (const m of tf) for (const [t, v] of m) { colSum.set(t, (colSum.get(t) ?? 0) + v); all += v; }
  const avgWords = all / Math.max(1, uniq.length);
  const out = new Map<number, [string, number][]>();
  uniq.forEach((c, i) => {
    const rowSum = [...tf[i].values()].reduce((s, v) => s + v, 0) || 1;
    const scored = [...tf[i]].map(([t, v]) => [t, (v / rowSum) * Math.log(1 + avgWords / Math.max(colSum.get(t)!, 1))] as [string, number])
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const picked: [string, number][] = [];
    for (const [w, s] of scored) {
      if (s <= 0) break;
      if (picked.some(([p]) => p.includes(w) || w.includes(p))) continue; // skip unigram covered by a chosen bigram and vice versa
      picked.push([w, s]);
      if (picked.length >= topN) break;
    }
    out.set(c, picked);
  });
  return out;
}

/** Average-linkage agglomerative clustering on cosine distance with a distance threshold. */
function agglomerative(c: Vec[], threshold: number): number[] {
  let groups = c.map((_, i) => [i]);
  const cos = (i: number, j: number) => 1 - dot(c[i], c[j]);
  for (;;) {
    let best: [number, number, number] | null = null;
    for (let a = 0; a < groups.length; a++)
      for (let b = a + 1; b < groups.length; b++) {
        let s = 0;
        for (const i of groups[a]) for (const j of groups[b]) s += cos(i, j);
        const d = s / (groups[a].length * groups[b].length);
        if (d < threshold && (!best || d < best[2])) best = [a, b, d];
      }
    if (!best) break;
    groups[best[0]] = [...groups[best[0]], ...groups[best[1]]];
    groups = groups.filter((_, i) => i !== best![1]);
  }
  const labels = Array(c.length).fill(0);
  groups.forEach((g, gi) => g.forEach((i) => (labels[i] = gi)));
  return labels;
}

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

export async function cluster(embeddings: Vec[], docs: string[], algorithm: "hdbscan" | "kmeans", opts: { k?: number } = {}, seed = 42): Promise<ClusterOut> {
  const n = embeddings.length;
  if (!n) return { algorithm, params: {}, labels: [], probabilities: [], outlier_scores: [], xy: [], clusters: [], parents: [], silhouette: null, n_noise: 0 };
  const x = embeddings.map(l2);
  const reduced = n > 6 ? await reduce(x, 5, seed) : x;
  const xy = await reduce(x, 2, seed);
  const params: Record<string, unknown> = { n };
  if (algorithm === "hdbscan") params.note = "HDBSCAN runs in the Python ML service; this server used K-Means with k chosen by silhouette";

  let labels: number[], probs: number[], algo: string;
  if (n < 4) {
    labels = x.map(() => 0); probs = x.map(() => 1); algo = "single";
  } else {
    let k = opts.k;
    if (!k) {
      let best: [number, number] = [-1, 2];
      for (let kk = 2; kk <= Math.min(12, n - 1); kk++) {
        const s = silhouette(reduced, kmeans(reduced, kk, seed, 4).labels);
        if (s > best[0]) best = [s, kk];
      }
      k = best[1];
    }
    const km = kmeans(reduced, k, seed);
    labels = km.labels;
    const d = reduced.map((p, i) => dist(p, km.centers[labels[i]]));
    const rank = d.map((v, i) => d.filter((w, j) => w < v || (w === v && j < i)).length);
    probs = rank.map((r) => 1 - r / Math.max(1, n - 1)); // farthest from its centroid = least typical
    params.k = k;
    algo = "kmeans";
  }
  const outlier = probs.map((p) => Math.min(1, Math.max(0, 1 - p)));
  const sil = new Set(labels).size > 1 && n > 2 ? silhouette(reduced, labels) : null;

  const keywords = ctfidf(docs, labels);
  const ids = [...new Set(labels.filter((l) => l >= 0))].sort((a, b) => a - b);
  const centroids = new Map<number, Vec>();
  const clusters: ClusterOut["clusters"] = ids.map((c) => {
    const members = x.filter((_, i) => labels[i] === c);
    const cen = l2(members[0].map((_, j) => members.reduce((s, p) => s + p[j], 0) / members.length));
    centroids.set(c, cen);
    const kw = keywords.get(c) ?? [];
    return {
      label: c, name: kw.slice(0, 3).map(([w]) => w).join(" · ") || `Topic ${c}`,
      keywords: kw.map(([term, score]) => ({ term, score: r4(score) })), size: members.length,
      coherence: r4(members.reduce((s, p) => s + dot(p, cen), 0) / members.length), parent: null,
    };
  });

  const parents: ClusterOut["parents"] = [];
  if (centroids.size >= 4) {
    const plabels = agglomerative(ids.map((i) => centroids.get(i)!), 0.35);
    const pset = new Set(plabels);
    if (pset.size > 1 && pset.size < ids.length) {
      const docParent = labels.map((l) => (l >= 0 ? plabels[ids.indexOf(l)] : -1));
      const pkw = ctfidf(docs, docParent, 6);
      for (const p of [...pset].sort((a, b) => a - b)) {
        const children = ids.filter((_, i) => plabels[i] === p);
        if (children.length < 2) continue;
        for (const cl of clusters) if (children.includes(cl.label)) cl.parent = p;
        const kw = pkw.get(p) ?? [];
        parents.push({ label: p, name: kw.slice(0, 3).map(([w]) => w).join(" · ") || `Theme ${p}`,
          keywords: kw.map(([term, score]) => ({ term, score: r4(score) })), children,
          size: labels.filter((l) => children.includes(l)).length });
      }
    }
  }

  return {
    algorithm: algo, params, labels,
    probabilities: probs.map(r4), outlier_scores: outlier.map(r4),
    xy: xy.map((p) => [r4(p[0] ?? 0), r4(p[1] ?? 0)] as [number, number]),
    clusters, parents, silhouette: sil == null ? null : r4(sil), n_noise: labels.filter((l) => l < 0).length,
  };
}
