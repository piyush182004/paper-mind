import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ForceGraph2D, { type ForceGraphMethods, type NodeObject } from "react-force-graph-2d";
import { Crosshair, Network, RefreshCw, X } from "lucide-react";
import { api, qs, type ClusterState, type GraphNode, type GraphView, type NodeType } from "../lib/api";
import { Badge, Button, Card, Empty, PageHeader, Spinner, inputCls } from "../components/ui";
import { useOpenPaper } from "../components/PaperDrawer";
import { useTheme } from "../lib/theme";

// fixed categorical order (never cycled): node type -> slot
const TYPES: { type: NodeType; label: string; color: string }[] = [
  { type: "paper", label: "Paper", color: "#3987e5" }, { type: "author", label: "Author", color: "#d95926" },
  { type: "concept", label: "Concept", color: "#199e70" }, { type: "method", label: "Method", color: "#c98500" },
  { type: "model", label: "Model", color: "#d55181" }, { type: "dataset", label: "Dataset", color: "#0ca30c" },
  { type: "metric", label: "Metric", color: "#9085e9" }, { type: "task", label: "Task", color: "#e66767" },
];
const COLOR = Object.fromEntries(TYPES.map((t) => [t.type, t.color])) as Record<NodeType, string>;
type N = GraphNode & NodeObject;

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.floor(e.contentRect.width), h: Math.max(480, Math.floor(window.innerHeight - 260)) }));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

interface NodeDetail { key: string; name?: string; title?: string; type?: string; year?: number; papers?: { id: number; title: string; year: number | null; mentions?: number; evidence?: string }[]; metrics: { pagerank: number; betweenness: number | null; degree: number; community: number } | null }

export default function GraphPage() {
  const [types, setTypes] = useState<NodeType[]>(["paper", "method", "model", "dataset", "task"]);
  const [limit, setLimit] = useState(150);
  const [clusterId, setClusterId] = useState("");
  const [focus, setFocus] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [find, setFind] = useState("");
  const fgRef = useRef<ForceGraphMethods<N> | undefined>(undefined);
  const [boxRef, size] = useSize<HTMLDivElement>();
  const qc = useQueryClient();
  const openPaper = useOpenPaper();
  const dark = useTheme().resolved === "dark";

  const clusters = useQuery({ queryKey: ["clusters"], queryFn: () => api.get<ClusterState>("/clusters") });
  const graph = useQuery({
    queryKey: ["graph", types, limit, clusterId, focus],
    queryFn: () => api.get<GraphView>(`/graph?${qs({ types: types.join(","), limit, clusterId: clusterId || undefined, focus: focus ?? undefined })}`),
  });
  const detail = useQuery({ queryKey: ["graph-node", selected], enabled: Boolean(selected), queryFn: () => api.get<NodeDetail>(`/graph/node/${selected}`) });
  const recompute = useMutation({ mutationFn: () => api.post<{ jobId: number }>("/graph/recompute"), onSuccess: () => setTimeout(() => qc.invalidateQueries({ queryKey: ["graph"] }), 4000) });

  const data = useMemo(() => {
    if (!graph.data) return { nodes: [] as N[], links: [] as { source: string; target: string; type: string; weight: number }[] };
    const maxPr = Math.max(...graph.data.nodes.map((n) => n.pagerank), 1e-9);
    return {
      nodes: graph.data.nodes.map((n) => ({ ...n, id: n.key, val: 1 + 14 * Math.sqrt(n.pagerank / maxPr) })) as N[],
      links: graph.data.edges.map((e) => ({ ...e })),
    };
  }, [graph.data]);
  const labelled = useMemo(() => new Set(data.nodes.filter((n) => n.type === "paper").sort((a, b) => b.pagerank - a.pagerank).slice(0, 10).map((n) => n.key)), [data]);
  // spread the layout: stronger repulsion and longer links than the defaults, so nodes don't pile up
  useEffect(() => {
    const fg = fgRef.current as unknown as { d3Force: (n: string) => { strength?: (v: number) => void; distance?: (v: number) => void } | undefined; d3ReheatSimulation: () => void } | undefined;
    if (!fg) return;
    fg.d3Force("charge")?.strength?.(-260);
    fg.d3Force("link")?.distance?.(70);
    fg.d3ReheatSimulation();
  }, [data]);

  const locate = () => {
    const n = data.nodes.find((x) => x.label.toLowerCase().includes(find.toLowerCase()));
    if (n && n.x != null && n.y != null) { fgRef.current?.centerAt(n.x, n.y, 600); fgRef.current?.zoom(3, 600); setSelected(n.key); }
  };

  return (
    <>
      <PageHeader title="Connections" icon={<Network className="size-6" />}
        description="A map of your library: papers link to the methods, datasets and tasks they use, and to each other through citations and similarity. Bigger circles are more central. Click anything for details."
        details={<><p>Connections come from citations between your papers, methods, datasets and tasks mentioned in the text, shared authors, and embedding similarity.</p><p>Circle size is PageRank (how central a node is). Communities come from the Louvain algorithm, and betweenness highlights nodes that bridge different areas. The map refreshes automatically when your library changes.</p></>}
        actions={<Button icon={<RefreshCw className="size-4" />} loading={recompute.isPending} onClick={() => recompute.mutate()}>Refresh map</Button>} />

      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        {TYPES.map((t) => (
          <label key={t.type} className="flex items-center gap-1.5 text-sm text-ink-200">
            <input type="checkbox" className="accent-brand-500" checked={types.includes(t.type)}
              onChange={(e) => setTypes((c) => (e.target.checked ? [...c, t.type] : c.filter((x) => x !== t.type)))} />
            <span className="size-2.5 rounded-full" style={{ background: t.color }} aria-hidden /> {t.label}
          </label>
        ))}
      </div>
      <div className="mb-4 flex flex-wrap gap-3">
        <select value={clusterId} onChange={(e) => setClusterId(e.target.value)} className={`${inputCls} w-64`} aria-label="Topic filter">
          <option value="">All topics</option>
          {clusters.data?.clusters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} className={`${inputCls} w-40`} aria-label="Node limit">
          {[80, 150, 300, 600].map((v) => <option key={v} value={v}>Show {v} items</option>)}
        </select>
        <form onSubmit={(e) => { e.preventDefault(); locate(); }} className="flex gap-2">
          <input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find node…" className={`${inputCls} w-52`} />
          <Button type="submit" icon={<Crosshair className="size-4" />}>Locate</Button>
        </form>
        {focus && <Button variant="ghost" icon={<X className="size-4" />} onClick={() => setFocus(null)}>Clear focus</Button>}
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
        <Card padded={false} className="overflow-hidden">
          <div ref={boxRef} className="relative">
            {graph.isLoading ? <div className="p-6"><Spinner /></div> : !data.nodes.length ? (
              <div className="p-6"><Empty icon={<Network className="size-8" />} title="Nothing to map yet">Add a few papers: the map appears once they have been read.</Empty></div>
            ) : (
              <>
                {!graph.data?.metricsComputed && <div className="absolute left-3 top-3 z-10"><Badge tone="warn">Map is being prepared: it refreshes automatically</Badge></div>}
                <ForceGraph2D<N>
                  ref={fgRef}
                  width={size.w}
                  height={size.h}
                  graphData={data}
                  backgroundColor={dark ? "#0b0e17" : "#ffffff"}
                  nodeRelSize={4}
                  nodeLabel={(n) => `${n.label} (${n.type}) · PageRank ${n.pagerank.toFixed(4)} · degree ${n.degree}`}
                  nodeColor={(n) => COLOR[n.type]}
                  linkColor={(l) => ((l as { type: string }).type === "CITES" ? "rgba(144,133,233,0.55)" : (l as { type: string }).type === "SIMILAR_TO" ? "rgba(57,135,229,0.35)" : (dark ? "rgba(154,163,182,0.16)" : "rgba(80,90,110,0.22)"))}
                  linkWidth={(l) => ((l as { type: string }).type === "CITES" ? 1.6 : 0.6)}
                  linkDirectionalArrowLength={(l) => ((l as { type: string }).type === "CITES" ? 3 : 0)}
                  cooldownTicks={120}
                  onEngineStop={() => fgRef.current?.zoomToFit(400, 40)}
                  onNodeClick={(n) => setSelected(n.key)}
                  nodeCanvasObjectMode={() => "after"}
                  nodeCanvasObject={(n, ctx, scale) => {
                    if (!(n.key === selected || (labelled.has(n.key) && scale >= 1.3)) || n.x == null || n.y == null) return;
                    const label = n.label.length > 34 ? `${n.label.slice(0, 32)}…` : n.label;
                    ctx.font = `${Math.max(10 / scale, 2.5)}px Inter, sans-serif`;
                    ctx.fillStyle = dark ? "#e8ebf2" : "#10141f";
                    ctx.textAlign = "center";
                    ctx.fillText(label, n.x, n.y + Math.sqrt(n.val ?? 1) * 4 + 9 / scale);
                  }}
                />
              </>
            )}
          </div>
        </Card>

        <Card title="Node details" className="xl:max-h-[80vh] xl:overflow-y-auto">
          {!selected ? <p className="text-sm text-ink-400">Click a node to see its metrics and connected papers.</p> : detail.isLoading ? <Spinner /> : detail.data && (
            <div className="space-y-4 text-sm">
              <div>
                <div className="font-medium text-ink-100">{detail.data.title ?? detail.data.name}</div>
                <div className="mt-1 flex flex-wrap gap-1.5"><Badge>{selected.split(":")[0]}</Badge>{detail.data.year && <Badge>{detail.data.year}</Badge>}</div>
              </div>
              {detail.data.metrics && (
                <dl className="grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-lg bg-ink-800 p-2"><dt className="text-ink-400">PageRank</dt><dd className="tabular-nums text-ink-100">{detail.data.metrics.pagerank.toFixed(5)}</dd></div>
                  <div className="rounded-lg bg-ink-800 p-2"><dt className="text-ink-400">Betweenness</dt><dd className="tabular-nums text-ink-100">{detail.data.metrics.betweenness?.toFixed(4) ?? "n/a"}</dd></div>
                  <div className="rounded-lg bg-ink-800 p-2"><dt className="text-ink-400">Degree</dt><dd className="tabular-nums text-ink-100">{detail.data.metrics.degree}</dd></div>
                  <div className="rounded-lg bg-ink-800 p-2"><dt className="text-ink-400">Community</dt><dd className="tabular-nums text-ink-100">#{detail.data.metrics.community}</dd></div>
                </dl>
              )}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" icon={<Crosshair className="size-4" />} onClick={() => setFocus(selected)}>Focus neighbourhood</Button>
                {selected.startsWith("paper:") && <Button size="sm" onClick={() => openPaper(Number(selected.split(":")[1]))}>Open paper</Button>}
              </div>
              {detail.data.papers && (
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-400">Papers ({detail.data.papers.length})</h3>
                  <ul className="space-y-2">
                    {detail.data.papers.slice(0, 12).map((p) => (
                      <li key={p.id}>
                        <button onClick={() => openPaper(p.id)} className="text-left text-ink-200 hover:underline">{p.title}</button>
                        {p.evidence && <p className="mt-0.5 line-clamp-2 text-xs text-ink-400">“{p.evidence}”</p>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
