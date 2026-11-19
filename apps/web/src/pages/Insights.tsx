import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Lightbulb } from "lucide-react";
import { api, type ClaimRef, type Contradiction, type Gaps, type Trends } from "../lib/api";
import { Badge, Card, Empty, ErrorBox, PageHeader, ScoreBar, Spinner, Tabs } from "../components/ui";
import { useOpenPaper } from "../components/PaperDrawer";

function Claim({ c, label }: { c: ClaimRef; label?: string }) {
  const openPaper = useOpenPaper();
  return (
    <div className="rounded-xl border border-ink-700 bg-ink-900 p-3 text-sm">
      {label && <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-400">{label}</div>}
      <p className="text-ink-200">“{c.text}”</p>
      <button onClick={() => openPaper(c.paperId)} className="mt-1.5 text-left text-xs text-brand-300 hover:underline">{c.title}{c.page ? ` · p. ${c.page}` : ""}</button>
    </div>
  );
}

function ContradictionsTab() {
  const q = useQuery({ queryKey: ["contradictions"], queryFn: () => api.get<{ contradictions: Contradiction[] }>("/intelligence/contradictions") });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data?.contradictions.length) return <Empty title="No potential contradictions found">Needs semantically similar findings with opposite direction, or a finding vs another paper's own limitation.</Empty>;
  return (
    <ul className="space-y-4">
      {q.data.contradictions.map((c, i) => (
        <li key={i}><Card title={<span className="flex items-center gap-2">{c.type === "opposite_findings" ? "Opposite findings" : "Finding vs reported limitation"}<Badge tone="warn">candidate</Badge></span>}
          actions={<span className="text-sm font-semibold tabular-nums text-ink-100">{c.score.toFixed(2)}</span>}>
          <div className="grid gap-3 md:grid-cols-2"><Claim c={c.a} label="Claims improvement" /><Claim c={c.b} label={c.type === "opposite_findings" ? "Reports the opposite" : "Reports a limitation"} /></div>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <ScoreBar label="Semantic similarity ×0.55" value={c.components.similarity} />
            <ScoreBar label="Shared entities ×0.25" value={c.components.sharedEntities} color="var(--color-s3)" />
            <ScoreBar label="Conflict strength ×0.2" value={c.components.conflict} color="var(--color-s2)" />
          </div>
          {c.shared.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{c.shared.map((s) => <Badge key={s} tone="brand">{s}</Badge>)}</div>}
        </Card></li>
      ))}
    </ul>
  );
}

function GapsTab() {
  const q = useQuery({ queryKey: ["gaps"], queryFn: () => api.get<Gaps>("/intelligence/gaps") });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  const g = q.data!;
  return (
    <div className="space-y-6">
      <Card title="Untested combinations (within a topic)">
        {!g.untestedCombinations.length ? <p className="text-sm text-ink-400">No candidates: every popular method has been tried on every popular dataset/task in its topic.</p> : (
          <ul className="divide-y divide-ink-700/70">
            {g.untestedCombinations.map((u, i) => (
              <li key={i} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                <span className="text-ink-200"><b className="text-ink-100">{u.method}</b> has not been evaluated on <b className="text-ink-100">{u.target}</b> <span className="text-ink-400">({u.targetType})</span></span>
                <span className="flex gap-1.5"><Badge>{u.methodPapers.length} papers use the method</Badge><Badge>{u.targetPapers.length} use the {u.targetType}</Badge></span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Recurring limitations (open problems)">
        {!g.recurringLimitations.length ? <p className="text-sm text-ink-400">No limitation is reported by several independent papers yet.</p> : (
          <div className="space-y-4">{g.recurringLimitations.map((grp, i) => (
            <div key={i}><div className="mb-2 text-xs text-ink-400">Reported by {grp.papers} papers</div>
              <div className="grid gap-2 md:grid-cols-2">{grp.claims.slice(0, 4).map((c) => <Claim key={c.claimId} c={c} />)}</div></div>
          ))}</div>
        )}
      </Card>
      <Card title="Growing but under-explored topics">
        {!g.underExploredTopics.length ? <p className="text-sm text-ink-400">None (run clustering first).</p> : (
          <ul className="space-y-2 text-sm">{g.underExploredTopics.map((t) => (
            <li key={t.clusterId} className="flex flex-wrap items-center justify-between gap-2"><span className="text-ink-200">{t.name}</span>
              <span className="flex gap-1.5"><Badge>{t.size} papers</Badge><Badge tone="good">▲ {t.growth.toFixed(2)}/yr</Badge><Badge>{Math.round(t.coverage * 100)}% full text</Badge></span></li>
          ))}</ul>
        )}
      </Card>
    </div>
  );
}

function TrendsTab() {
  const q = useQuery({ queryKey: ["trends"], queryFn: () => api.get<Trends>("/intelligence/trends") });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  const t = q.data!;
  const list = (title: string, items: Trends["rising"], tone: "good" | "warn" | "info") => (
    <Card title={title}>
      {!items.length ? <p className="text-sm text-ink-400">Not enough dated papers.</p> : (
        <ul className="space-y-2 text-sm">{items.map((s) => (
          <li key={`${s.type}${s.name}`} className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-ink-200">{s.name} <span className="text-xs text-ink-400">{s.type}</span></span>
            <span className="flex shrink-0 items-center gap-2">
              <svg width="60" height="18" aria-hidden>{(() => { const m = Math.max(...s.share.map((x) => x.share), 0.01); return <polyline fill="none" stroke="var(--color-s1)" strokeWidth="2" points={s.share.map((x, i) => `${(i / Math.max(1, s.share.length - 1)) * 58 + 1},${17 - (x.share / m) * 15}`).join(" ")} />; })()}</svg>
              <Badge tone={tone}>{s.papers} papers</Badge>
            </span>
          </li>
        ))}</ul>
      )}
    </Card>
  );
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      {list("Rising (share of papers per year)", t.rising, "good")}
      {list("Emerging (first seen recently)", t.emerging, "info")}
      {list("Declining", t.declining, "warn")}
    </div>
  );
}

export default function Insights() {
  const [tab, setTab] = useState<"contradictions" | "gaps" | "trends">("gaps");
  return (
    <>
      <PageHeader title="Insights" icon={<Lightbulb className="size-6" />}
        description="Things worth a closer look: research gaps, results that disagree, and rising topics. Each item links to the page it came from so you can verify it."
        details={<><p><b>Gaps:</b> methods popular in a topic that were never tested on a dataset popular in the same topic, and limitations reported by several independent papers.</p><p><b>Conflicts:</b> findings with very similar meaning but opposite direction, or a claimed improvement next to another paper's own reported limitation.</p><p><b>Trends:</b> the share of papers per year mentioning each method, dataset or concept. These are candidates to check, not conclusions.</p></>} />
      <div className="mb-6"><Tabs value={tab} onChange={setTab} tabs={[{ id: "gaps", label: "Research gaps" }, { id: "contradictions", label: "Contradictions" }, { id: "trends", label: "Trends" }]} /></div>
      {tab === "gaps" ? <GapsTab /> : tab === "contradictions" ? <ContradictionsTab /> : <TrendsTab />}
    </>
  );
}
