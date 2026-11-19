import { useQuery } from "@tanstack/react-query";
import { BarChart3 } from "lucide-react";
import { api, type ClusterMetric, type Overview, type PaperScore } from "../lib/api";
import { Badge, Card, Empty, PageHeader, ScoreBar, Spinner, Stat } from "../components/ui";
import { useOpenPaper } from "../components/PaperDrawer";

const COMPONENTS: [keyof PaperScore["components"], string, string][] = [
  ["citation_impact", "Citation impact", "ln(1 + citations/age), normalised to the library"],
  ["graph_influence", "Graph influence", "PageRank in the knowledge graph"],
  ["novelty", "Novelty", "Distance to the most similar earlier paper"],
  ["centrality", "Topic centrality", "Cosine to its topic centroid"],
];

function YearBars({ data }: { data: { year: number; n: number }[] }) {
  if (!data.length) return <p className="text-sm text-ink-400">No dated papers.</p>;
  const max = Math.max(...data.map((d) => d.n));
  return (
    <div className="flex h-40 items-end gap-1" role="img" aria-label="Papers per year">
      {data.map((d) => (
        <div key={d.year} className="group flex flex-1 flex-col items-center justify-end gap-1" title={`${d.year}: ${d.n} papers`}>
          <span className="text-[10px] tabular-nums text-ink-300 opacity-0 group-hover:opacity-100">{d.n}</span>
          <div className="w-full rounded-t bg-s1" style={{ height: `${(d.n / max) * 100}%`, minHeight: 2 }} />
          <span className="text-[10px] tabular-nums text-ink-400">{String(d.year).slice(2)}</span>
        </div>
      ))}
    </div>
  );
}

export default function Analytics() {
  const ov = useQuery({ queryKey: ["overview"], queryFn: () => api.get<Overview>("/analytics/overview") });
  const scores = useQuery({ queryKey: ["paper-scores"], queryFn: () => api.get<{ papers: PaperScore[] }>("/analytics/papers?limit=50") });
  const topics = useQuery({ queryKey: ["cluster-metrics"], queryFn: () => api.get<{ clusters: ClusterMetric[] }>("/clusters/metrics") });
  const openPaper = useOpenPaper();
  const o = ov.data;

  return (
    <>
      <PageHeader title="Stats" icon={<BarChart3 className="size-6" />}
        description="Which papers matter most in your library, and why. Every score shows its ingredients."
        details={<><p>Score = 0.3 citation impact (citations per year, compared within your library) + 0.3 influence (PageRank in your connections map) + 0.2 novelty (how different it is from earlier papers) + 0.2 topic fit (how representative it is of its topic). Missing ingredients are skipped, never guessed.</p></>} />
      {ov.isLoading ? <Spinner /> : !o?.papers ? <Empty title="No data yet">Import papers first.</Empty> : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Research coverage" value={`${Math.round(o.coverage * 100)}%`} hint="papers with full text indexed" />
            <Stat label="Claims" value={o.claims} hint={o.claimsByKind.map((c) => `${c.n} ${c.kind}s`).join(" · ")} />
            <Stat label="Chunks" value={o.chunks.toLocaleString()} hint={o.chunksByKind.map((c) => `${c.n} ${c.kind}`).join(" · ")} />
            <Stat label="Entities" value={o.entities} hint={o.entitiesByType.slice(0, 3).map((e) => `${e.n} ${e.type}`).join(" · ")} />
          </div>

          <div className="grid gap-6 xl:grid-cols-2">
            <Card title="Papers per year"><YearBars data={o.papersByYear} /></Card>
            <Card title="Topic metrics">
              {!topics.data?.clusters.length ? <p className="text-sm text-ink-400">Run clustering to see topic coherence and growth.</p> : (
                <table className="w-full text-left text-sm">
                  <thead className="text-xs text-ink-400"><tr><th className="pb-2 font-medium">Topic</th><th className="pb-2 font-medium">Papers</th><th className="pb-2 font-medium">Coherence</th><th className="pb-2 font-medium">Growth</th></tr></thead>
                  <tbody>
                    {topics.data.clusters.map((c) => (
                      <tr key={c.id} className="border-t border-ink-700/70">
                        <td className="max-w-56 truncate py-2 pr-3 text-ink-200" title={c.name}>{c.name}</td>
                        <td className="tabular-nums text-ink-300">{c.size}</td>
                        <td className="w-32 pr-3"><ScoreBar value={c.coherence} /></td>
                        <td className="tabular-nums text-ink-300">{c.growth > 0 ? "▲" : c.growth < 0 ? "▼" : "→"} {c.growth.toFixed(2)}/yr</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </div>

          <Card title="Paper ranking (explainable composite)" padded={false}>
            {scores.isLoading ? <div className="px-5"><Spinner /></div> : (
              <ul className="divide-y divide-ink-700/70">
                {scores.data?.papers.map((p, i) => (
                  <li key={p.id} className="grid gap-3 px-5 py-3 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,2fr)_90px] lg:items-center">
                    <button onClick={() => openPaper(p.id)} className="min-w-0 text-left">
                      <div className="truncate text-sm font-medium text-ink-100 hover:underline"><span className="mr-2 tabular-nums text-ink-400">{i + 1}.</span>{p.title}</div>
                      <div className="mt-0.5 flex flex-wrap gap-1.5">{p.year && <Badge>{p.year}</Badge>}{p.cluster && <Badge tone="brand">{p.cluster}</Badge>}<Badge>{p.citations} cites</Badge></div>
                    </button>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-4">
                      {COMPONENTS.map(([k, label, hint]) => (
                        <ScoreBar key={k} label={`${label} ×${p.weights[k]}`} value={p.components[k]} hint={hint} />
                      ))}
                    </div>
                    <div className="text-right">
                      <div className="text-lg font-semibold tabular-nums text-ink-100">{p.composite.toFixed(2)}</div>
                      {p.missing.length > 0 && <div className="text-[10px] text-ink-400" title="Weights re-normalised over available components">no {p.missing.join(", ")}</div>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
