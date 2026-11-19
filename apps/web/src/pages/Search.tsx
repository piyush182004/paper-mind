import { type FormEvent, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ChevronDown, Network, Search as SearchIcon } from "lucide-react";
import { api, type ClusterState, type Hit, type SearchResult } from "../lib/api";
import { Badge, Button, Card, Empty, ErrorBox, PageHeader, ScoreBar, Spinner, inputCls } from "../components/ui";
import { useOpenPaper } from "../components/PaperDrawer";

const KINDS = ["text", "abstract", "table", "figure", "equation"] as const;

function Highlight({ text, query }: { text: string; query: string }) {
  const words = [...new Set(query.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [])].map((w) => w.slice(0, 6));
  if (!words.length) return <>{text}</>;
  const re = new RegExp(`(\\b(?:${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})[a-z0-9]*)`, "gi");
  return <>{text.split(re).map((part, i) => (i % 2 ? <mark key={i} className="rounded bg-brand-500/25 px-0.5 text-ink-100">{part}</mark> : part))}</>;
}

function HitCard({ h, query, rank }: { h: Hit; query: string; rank: number }) {
  const [ctx, setCtx] = useState(false);
  const openPaper = useOpenPaper();
  const s = h.scores;
  return (
    <li className={`rounded-2xl border bg-ink-850/80 p-4 ${h.via === "graph" ? "border-s7/30" : "border-ink-700/80"}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <button onClick={() => openPaper(h.paperId)} className="min-w-0 text-left">
          <span className="mr-2 tabular-nums text-ink-400">{rank}.</span>
          <span className="font-medium text-ink-100 hover:underline">{h.title}</span>
        </button>
        <div className="flex flex-wrap gap-1.5">
          {h.via === "graph" && <Badge tone="brand" title={h.graphReason}><Network className="size-3" /> Connected paper</Badge>}
          <Badge tone="info">{h.kind}</Badge>
          {h.pageStart != null && <Badge>p. {h.pageStart}{h.pageEnd && h.pageEnd !== h.pageStart ? `–${h.pageEnd}` : ""}</Badge>}
          {h.year && <Badge>{h.year}</Badge>}
        </div>
      </div>
      {h.section && <div className="mt-1 text-xs text-ink-400">§ {h.section}</div>}
      {h.via === "graph" && h.graphReason && <div className="mt-1 text-xs text-brand-300">Linked via the knowledge graph: {h.graphReason}</div>}
      <p className={`mt-2 text-sm leading-relaxed text-ink-200 ${h.kind === "table" ? "whitespace-pre-wrap font-mono text-xs" : ""}`}>
        <Highlight text={h.content.length > 900 ? h.content.slice(0, 900) + "…" : h.content} query={query} />
      </p>
      {ctx && h.context && (
        <div className="mt-2 space-y-2 border-l-2 border-ink-600 pl-3 text-xs text-ink-400">
          {h.context.before && <p><span className="text-ink-300">Before: </span>{h.context.before.slice(0, 500)}</p>}
          {h.context.after && <p><span className="text-ink-300">After: </span>{h.context.after.slice(0, 500)}</p>}
        </div>
      )}
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <ScoreBar label="Final" value={s.final} hint="0.7 × cross-encoder + 0.3 × fused rank" />
        <ScoreBar label="Cross-encoder" value={s.rerank} color="var(--color-s3)" />
        <ScoreBar label="RRF (fused)" value={s.rrf} color="var(--color-s1)" />
        <div className="text-[11px] text-ink-300">
          <div>BM25 rank: <span className="tabular-nums text-ink-200">{s.bm25Rank ?? "—"}</span></div>
          <div>Dense rank: <span className="tabular-nums text-ink-200">{s.denseRank ?? "—"}</span></div>
          {s.paperRank && <div>Paper rank: <span className="tabular-nums text-ink-200">{s.paperRank}</span></div>}
        </div>
      </div>
      {h.context && (h.context.before || h.context.after) && (
        <button onClick={() => setCtx((v) => !v)} className="mt-2 inline-flex items-center gap-1 text-xs text-brand-300 hover:underline">
          <ChevronDown className={`size-3.5 transition ${ctx ? "rotate-180" : ""}`} /> {ctx ? "Hide" : "Show"} surrounding context
        </button>
      )}
    </li>
  );
}

export default function SearchPage() {
  const [query, setQuery] = useState("");
  const [kinds, setKinds] = useState<string[]>([]);
  const [yearFrom, setYearFrom] = useState("");
  const [clusterId, setClusterId] = useState("");
  const [opts, setOpts] = useState({ rerank: true, hierarchical: true, graph: true });
  const clusters = useQuery({ queryKey: ["clusters"], queryFn: () => api.get<ClusterState>("/clusters") });
  const search = useMutation({
    mutationFn: (q: string) => api.post<SearchResult>("/search", {
      query: q,
      filters: { kinds: kinds.length ? kinds : undefined, yearFrom: yearFrom ? Number(yearFrom) : undefined, clusterId: clusterId ? Number(clusterId) : undefined },
      options: { k: 10, context: true, ...opts },
    }),
  });
  const submit = (e: FormEvent) => { e.preventDefault(); if (query.trim().length > 1) search.mutate(query.trim()); };
  const r = search.data;

  return (
    <>
      <PageHeader title="Search papers" icon={<SearchIcon className="size-6" />}
        description="Find the exact passages that answer your question, with the paper and page they come from."
        details={<><p>Two searches run together: keyword matching (BM25) and meaning-based matching (vector embeddings). Results are merged (reciprocal rank fusion), the best papers are searched more closely, and an AI reranker double-checks the order.</p><p><b>Include connected papers</b> adds passages from papers that share methods, datasets or citations with the top results (GraphRAG). Each result shows the scores behind its rank.</p></>} />
      <Card className="mb-6">
        <form onSubmit={submit} className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row">
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Ask anything about your papers, e.g. which datasets are used to evaluate GNNs?" className={`${inputCls} w-full`} autoFocus />
            <Button variant="primary" type="submit" loading={search.isPending} icon={<SearchIcon className="size-4" />}>Search</Button>
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3 text-sm text-ink-200">
            <span className="text-xs text-ink-400">Content:</span>
            {KINDS.map((k) => (
              <label key={k} className="flex items-center gap-1.5 capitalize">
                <input type="checkbox" className="accent-brand-500" checked={kinds.includes(k)} onChange={(e) => setKinds((c) => (e.target.checked ? [...c, k] : c.filter((x) => x !== k)))} /> {k}
              </label>
            ))}
            <input value={yearFrom} onChange={(e) => setYearFrom(e.target.value.replace(/\D/g, "").slice(0, 4))} placeholder="From year" className={`${inputCls} h-8 w-28`} aria-label="From year" />
            <select value={clusterId} onChange={(e) => setClusterId(e.target.value)} className={`${inputCls} h-8 w-56`} aria-label="Topic filter">
              <option value="">All topics</option>
              {clusters.data?.clusters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-ink-200">
            {([["rerank", "Double-check ranking with AI"], ["hierarchical", "Look inside the best papers first"], ["graph", "Include connected papers"]] as const).map(([k, label]) => (
              <label key={k} className="flex items-center gap-1.5"><input type="checkbox" className="accent-brand-500" checked={opts[k]} onChange={(e) => setOpts((o) => ({ ...o, [k]: e.target.checked }))} /> {label}</label>
            ))}
          </div>
        </form>
      </Card>

      {search.error && <ErrorBox error={search.error} />}
      {search.isPending ? <Spinner label="Retrieving, fusing and reranking…" /> : !r ? (
        <Empty icon={<SearchIcon className="size-8" />} title="Search across every indexed chunk">Results cite the paper, section and page they come from.</Empty>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-ink-400">
            <span>{r.hits.length} results</span>
            {Object.entries(r.timings).map(([k, v]) => <Badge key={k}>{k} {v} ms</Badge>)}
            {r.degraded.length > 0 && <Badge tone="warn">degraded: {r.degraded.join(", ")} (ML service offline)</Badge>}
          </div>
          {r.hits.length ? <ul className="space-y-3">{r.hits.map((h, i) => <HitCard key={`${h.chunkId}-${h.via}`} h={h} query={r.query} rank={i + 1} />)}</ul>
            : <Empty title="No matching passages">Try different wording or remove filters.</Empty>}
        </>
      )}
    </>
  );
}
