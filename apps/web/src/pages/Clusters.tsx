import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Boxes, Play } from "lucide-react";
import { api, type ClusterMetric, type ClusterPoint, type ClusterState, type Job } from "../lib/api";
import { Badge, Button, Card, Empty, ErrorBox, PageHeader, ScoreBar, Spinner, inputCls, seriesColor } from "../components/ui";
import { useOpenPaper } from "../components/PaperDrawer";

function useJob(id: number | null, onDone: () => void) {
  return useQuery({
    queryKey: ["job", id], enabled: id != null,
    queryFn: async () => {
      const j = await api.get<Job>(`/jobs/${id}`);
      if (j.status === "done" || j.status === "failed") onDone();
      return j;
    },
    refetchInterval: (q) => (q.state.data && (q.state.data.status === "done" || q.state.data.status === "failed") ? false : 1500),
  });
}

function TopicMap({ state, colorOf }: { state: ClusterState; colorOf: (id: number | null) => string }) {
  const [hover, setHover] = useState<ClusterPoint | null>(null);
  const openPaper = useOpenPaper();
  const pts = state.points;
  const W = 760, H = 460, P = 24;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const sx = (x: number) => P + ((x - minX) / (maxX - minX || 1)) * (W - 2 * P);
  const sy = (y: number) => H - P - ((y - minY) / (maxY - minY || 1)) * (H - 2 * P);
  const nameOf = new Map(state.clusters.map((c) => [c.id, c.name]));
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="2D UMAP map of papers coloured by topic">
        <rect x={0} y={0} width={W} height={H} rx={12} fill="var(--color-ink-900)" />
        {pts.map((p) => {
          const noise = p.cluster_id == null;
          return (
            <circle key={p.paper_id} cx={sx(p.x)} cy={sy(p.y)} r={hover?.paper_id === p.paper_id ? 8 : 6}
              fill={noise ? "transparent" : colorOf(p.cluster_id)} stroke={noise ? "var(--color-ink-400)" : "var(--color-ink-900)"} strokeWidth={noise ? 1.5 : 2}
              opacity={hover && hover.cluster_id !== p.cluster_id ? 0.35 : 1} className="cursor-pointer transition-opacity"
              onMouseEnter={() => setHover(p)} onMouseLeave={() => setHover(null)} onClick={() => openPaper(p.paper_id)} />
          );
        })}
      </svg>
      {hover && (
        <div className="pointer-events-none absolute left-3 top-3 max-w-sm rounded-xl border border-ink-600 bg-ink-850/95 px-3 py-2 text-xs shadow-xl">
          <div className="font-medium text-ink-100">{hover.title}</div>
          <div className="mt-1 text-ink-300">{hover.cluster_id ? nameOf.get(hover.cluster_id) : "Outlier (no topic)"} · {hover.year ?? "n/a"}</div>
          <div className="text-ink-400">outlier score {hover.outlier_score?.toFixed(2) ?? "—"} · {hover.citation_count} citations</div>
        </div>
      )}
    </div>
  );
}

export default function Clusters() {
  const [algorithm, setAlgorithm] = useState<"hdbscan" | "kmeans">("hdbscan");
  const [param, setParam] = useState("");
  const [jobId, setJobId] = useState<number | null>(null);
  const qc = useQueryClient();
  const state = useQuery({ queryKey: ["clusters"], queryFn: () => api.get<ClusterState>("/clusters") });
  const metrics = useQuery({ queryKey: ["cluster-metrics"], queryFn: () => api.get<{ clusters: ClusterMetric[] }>("/clusters/metrics") });
  const run = useMutation({
    mutationFn: () => api.post<{ jobId: number }>("/clusters/run", { algorithm, ...(param ? (algorithm === "kmeans" ? { k: Number(param) } : { minClusterSize: Number(param) }) : {}) }),
    onSuccess: (r) => setJobId(r.jobId),
  });
  const job = useJob(jobId, () => qc.invalidateQueries());
  const running = job.data && (job.data.status === "queued" || job.data.status === "running");

  const order = useMemo(() => new Map((state.data?.clusters ?? []).map((c, i) => [c.id, i])), [state.data]);
  const colorOf = (id: number | null) => (id == null ? "var(--color-ink-400)" : seriesColor(order.get(id) ?? 99));
  const metricOf = new Map((metrics.data?.clusters ?? []).map((m) => [m.id, m]));
  const s = state.data;

  return (
    <>
      <PageHeader title="Topics" icon={<Boxes className="size-6" />}
        description="Your papers grouped into research themes automatically. Each dot is a paper: dots close together are about similar things."
        details={<><p>Paper meanings are turned into vectors, reduced with UMAP and grouped into topics (the number of topics is picked automatically by how cleanly papers separate, or you can fix it). Each topic is named from the words most distinctive for it (class-based TF-IDF), and related topics are grouped into broader themes.</p><p>Coherence shows how tightly a topic's papers agree. Papers that fit no topic are shown as outliers instead of being forced in. Topics update automatically when you add papers.</p></>}
        actions={<>
          <select value={algorithm} onChange={(e) => setAlgorithm(e.target.value as "hdbscan" | "kmeans")} className={`${inputCls} w-36`} aria-label="Algorithm">
            <option value="hdbscan">Automatic</option><option value="kmeans">Fixed number</option>
          </select>
          <input value={param} onChange={(e) => setParam(e.target.value.replace(/\D/g, "").slice(0, 3))} className={`${inputCls} w-36`}
            placeholder={algorithm === "kmeans" ? "How many topics?" : "Min. papers per topic"} aria-label="Algorithm parameter" />
          <Button variant="primary" icon={<Play className="size-4" />} loading={run.isPending || Boolean(running)} onClick={() => run.mutate()}>Re-group</Button>
        </>} />

      {running && <div className="mb-4 text-sm text-warn-ink">{job.data?.message ?? "Running…"} ({Math.round((job.data?.progress ?? 0) * 100)}%)</div>}
      {job.data?.status === "failed" && <ErrorBox error={job.data.error} />}
      {run.error && <ErrorBox error={run.error} />}

      {state.isLoading ? <Spinner /> : !s?.run ? (
        <Empty icon={<Boxes className="size-8" />} title="No topics yet">Topics appear automatically once 3 or more papers have been read.</Empty>
      ) : (
        <div className="grid gap-6 xl:grid-cols-[1fr_420px]">
          <Card title="Topic map (UMAP 2D)" actions={
            <div className="flex flex-wrap gap-1.5">
              <Badge>{s.run.algorithm}</Badge><Badge>{s.run.n_papers} papers</Badge><Badge>{s.run.n_clusters} topics</Badge>
              <Badge tone={s.run.n_noise ? "warn" : "neutral"}>{s.run.n_noise} outliers</Badge>
              {s.run.silhouette != null && <Badge tone="info" title="Cluster separation in the reduced space (-1..1)">silhouette {s.run.silhouette.toFixed(2)}</Badge>}
            </div>}>
            <TopicMap state={s} colorOf={colorOf} />
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-ink-300">
              {s.clusters.map((c) => <span key={c.id} className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: colorOf(c.id) }} />{c.name}</span>)}
              {s.run.n_noise > 0 && <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-full border border-ink-400" />outliers</span>}
              {s.clusters.length > 8 && <span className="text-ink-400">topics beyond 8 shown in grey</span>}
            </div>
          </Card>

          <div className="space-y-4">
            {s.parents.length > 0 && (
              <Card title="Parent themes">
                <ul className="space-y-2 text-sm">
                  {s.parents.map((p) => (
                    <li key={p.id}>
                      <div className="font-medium text-ink-100">{p.name} <span className="text-xs text-ink-400">({p.size} papers)</span></div>
                      <div className="text-xs text-ink-400">{s.clusters.filter((c) => c.parent_id === p.id).map((c) => c.name).join(" · ")}</div>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
            {s.clusters.map((c) => {
              const m = metricOf.get(c.id);
              return (
                <Card key={c.id} title={<span className="flex items-center gap-2"><span className="size-2.5 rounded-sm" style={{ background: colorOf(c.id) }} />{c.name}</span>}
                  actions={<Badge>{c.size} papers</Badge>}>
                  <div className="mb-3 flex flex-wrap gap-1.5">{c.keywords.slice(0, 8).map((k) => <Badge key={k.term} tone="brand">{k.term}</Badge>)}</div>
                  <div className="grid grid-cols-2 gap-3">
                    <ScoreBar label="Coherence" value={c.coherence} hint="Mean cosine to the topic centroid (original embedding space)" />
                    <ScoreBar label="Full-text coverage" value={m?.coverage} color="var(--color-s3)" />
                  </div>
                  {m && <div className="mt-2 text-xs text-ink-400">Growth {m.growth > 0 ? "▲" : m.growth < 0 ? "▼" : "→"} {m.growth.toFixed(2)} papers/yr · mean year {c.mean_year ?? "n/a"} · {m.citations.toLocaleString()} citations</div>}
                </Card>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
