import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Bot, GitCompareArrows } from "lucide-react";
import { api, type Comparison, type PaperListItem } from "../lib/api";
import { Badge, Button, Card, ErrorBox, PageHeader, Spinner } from "../components/ui";

const ROWS: [keyof Comparison["papers"][number], string][] = [
  ["topics", "Topics"], ["methods", "Methods"], ["models", "Models"], ["datasets", "Datasets"], ["tasks", "Tasks"], ["metrics", "Metrics"],
];

export default function Compare() {
  const [ids, setIds] = useState<number[]>([]);
  const papers = useQuery({ queryKey: ["papers-all"], queryFn: () => api.get<{ papers: PaperListItem[] }>("/papers?limit=200&sort=title") });
  const cmp = useMutation({ mutationFn: () => api.post<Comparison>("/intelligence/compare", { paperIds: ids }) });
  const c = cmp.data;

  return (
    <>
      <PageHeader title="Compare papers" icon={<GitCompareArrows className="size-6" />}
        description="Pick 2 to 6 papers to see their methods, datasets, results and limitations side by side."
        details={<><p>Everything in the table was extracted from the papers' text with page numbers. Similarity compares the overall meaning of the papers (cosine similarity of their embeddings).</p></>} />
      <div className="grid gap-6 xl:grid-cols-[340px_1fr]">
        <Card title={`Select 2–6 papers (${ids.length})`} actions={<Button size="sm" variant="primary" disabled={ids.length < 2} loading={cmp.isPending} onClick={() => cmp.mutate()}>Compare</Button>}>
          <div className="max-h-[65vh] space-y-1 overflow-y-auto">
            {papers.data?.papers.filter((p) => p.status === "ready" || p.status === "metadata_only").map((p) => (
              <label key={p.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-ink-800">
                <input type="checkbox" className="accent-brand-500" checked={ids.includes(p.id)} disabled={!ids.includes(p.id) && ids.length >= 6}
                  onChange={() => setIds((cur) => (cur.includes(p.id) ? cur.filter((x) => x !== p.id) : [...cur, p.id]))} />
                <span className="min-w-0 flex-1 truncate text-ink-200" title={p.title}>{p.title}</span>
              </label>
            ))}
          </div>
        </Card>

        <div className="min-w-0 space-y-4">
          {cmp.error && <ErrorBox error={cmp.error} />}
          {cmp.isPending && <Spinner />}
          {!c ? <Card><p className="text-sm text-ink-400">Pick papers on the left and press Compare.</p></Card> : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-ink-300">Shared by all:</span>
                {c.shared.length ? c.shared.map((s) => <Badge key={s} tone="brand">{s}</Badge>) : <span className="text-sm text-ink-400">nothing in common</span>}
                <Link to={`/assistant?mode=compare&papers=${ids.join(",")}`} className="ml-auto inline-flex h-8 items-center gap-2 rounded-xl border border-ink-600 bg-ink-800 px-3 text-xs font-medium hover:bg-ink-700"><Bot className="size-4" /> Ask AI to compare</Link>
              </div>
              <Card padded={false}>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[720px] text-left text-sm">
                    <thead><tr className="bg-ink-800/60">
                      <th className="w-32 px-4 py-3 text-xs font-medium text-ink-400">Attribute</th>
                      {c.papers.map((p) => <th key={p.id} className="px-4 py-3 align-top text-xs font-semibold text-ink-100">{p.title}<div className="mt-1 font-normal text-ink-400">{p.year ?? "n/a"} · {p.citations} cites{p.cluster ? ` · ${p.cluster}` : ""}</div>{!p.fulltext && <div className="mt-1 font-normal text-warn-ink">Abstract only: fewer details available</div>}</th>)}
                    </tr></thead>
                    <tbody>
                      {ROWS.map(([k, label]) => (
                        <tr key={k} className="border-t border-ink-700/70">
                          <td className="px-4 py-3 text-xs text-ink-400">{label}</td>
                          {c.papers.map((p) => <td key={p.id} className="px-4 py-3 align-top"><div className="flex flex-wrap gap-1">{(p[k] as string[]).slice(0, 8).map((x) => <Badge key={x}>{x}</Badge>)}{!(p[k] as string[]).length && <span className="text-ink-400">Not mentioned</span>}</div></td>)}
                        </tr>
                      ))}
                      {(["findings", "limitations"] as const).map((k) => (
                        <tr key={k} className="border-t border-ink-700/70">
                          <td className="px-4 py-3 text-xs capitalize text-ink-400">{k}</td>
                          {c.papers.map((p) => (
                            <td key={p.id} className="px-4 py-3 align-top text-xs text-ink-200">
                              {p[k].length ? <ul className="space-y-1.5">{p[k].map((x) => <li key={x.claimId}>{x.text}{x.page && <span className="text-ink-400"> (p. {x.page})</span>}</li>)}</ul> : <span className="text-ink-400">Not mentioned</span>}
                            </td>
                          ))}
                        </tr>
                      ))}
                      <tr className="border-t border-ink-700/70">
                        <td className="px-4 py-3 text-xs text-ink-400">Reported numbers</td>
                        {c.papers.map((p) => <td key={p.id} className="px-4 py-3"><div className="flex flex-wrap gap-1">{p.reportedNumbers.map((n, i) => <Badge key={i} tone="info" title={`p. ${n.page ?? "?"}`}>{n.value}</Badge>)}</div></td>)}
                      </tr>
                    </tbody>
                  </table>
                </div>
              </Card>
              <Card title="Semantic similarity (cosine of paper embeddings)">
                <table className="text-xs">
                  <tbody>
                    {c.similarity.map((row, i) => (
                      <tr key={i}>
                        <td className="max-w-48 truncate pr-3 text-ink-300" title={c.papers[i].title}>{c.papers[i].title}</td>
                        {row.map((v, j) => (
                          <td key={j} className="p-0.5">
                            <div className="grid size-12 place-items-center rounded-md tabular-nums text-ink-100"
                              style={{ background: v == null ? "var(--color-ink-800)" : `color-mix(in srgb, #3987e5 ${Math.round(Math.max(0, (v - 0.5) / 0.5) * 85)}%, var(--color-ink-800))` }}>
                              {v == null ? "—" : v.toFixed(2)}
                            </div>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            </>
          )}
        </div>
      </div>
    </>
  );
}
