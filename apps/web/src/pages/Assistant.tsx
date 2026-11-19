import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Bot, Network, Send, ShieldCheck, User } from "lucide-react";
import { api, type AssistMode, type AssistResponse, type ClusterState, type LlmUsage, type PaperListItem } from "../lib/api";
import { Badge, Button, Card, ErrorBox, Markdown, PageHeader, Spinner, Tabs, inputCls } from "../components/ui";
import { useOpenPaper } from "../components/PaperDrawer";

const MODES: { id: AssistMode; label: string; needs: "question" | "paper" | "papers" | "set"; hint: string }[] = [
  { id: "qa", label: "Q&A", needs: "question", hint: "Ask a question; answers cite passages from your library." },
  { id: "explain", label: "Explain", needs: "paper", hint: "Explain one paper: problem, idea, method, evidence, limitations." },
  { id: "summarize", label: "Summarize", needs: "paper", hint: "Structured summary of one paper." },
  { id: "compare", label: "Compare", needs: "papers", hint: "Compare 2–5 papers using retrieved evidence and extracted claims." },
  { id: "review", label: "Literature review", needs: "set", hint: "Review a topic cluster or a set of papers; every claim is cited." },
];

interface Turn { role: "user" | "assistant"; content: string; response?: AssistResponse }

export default function Assistant() {
  const [params] = useSearchParams();
  const [mode, setMode] = useState<AssistMode>((params.get("mode") as AssistMode) || "qa");
  const [paperIds, setPaperIds] = useState<number[]>(params.get("papers")?.split(",").map(Number).filter(Boolean) ?? []);
  const [clusterId, setClusterId] = useState("");
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [focus, setFocus] = useState<number | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const openPaper = useOpenPaper();

  const papers = useQuery({ queryKey: ["papers-all"], queryFn: () => api.get<{ papers: PaperListItem[] }>("/papers?limit=200&sort=title") });
  const clusters = useQuery({ queryKey: ["clusters"], queryFn: () => api.get<ClusterState>("/clusters") });
  const usage = useQuery({ queryKey: ["llm-usage"], queryFn: () => api.get<LlmUsage>("/llm/usage"), refetchInterval: 30_000 });
  const ask = useMutation({
    mutationFn: (q: string) => api.post<AssistResponse>("/assistant", {
      mode, question: q || undefined, paperIds: paperIds.length ? paperIds : undefined, clusterId: clusterId ? Number(clusterId) : undefined,
      history: turns.slice(-6).map((t) => ({ role: t.role, content: t.content })),
    }),
    onSuccess: (res, q) => { setTurns((t) => [...t, { role: "user", content: q || MODES.find((m) => m.id === mode)!.label }, { role: "assistant", content: res.answer, response: res }]); setInput(""); usage.refetch(); },
  });
  // scroll only the chat box (not the whole page); braces matter: scrollIntoView returns a Promise in new browsers,
  // and an effect must never return anything but a cleanup function
  useEffect(() => {
    const box = endRef.current?.parentElement;
    if (box) box.scrollTo({ top: box.scrollHeight, behavior: "smooth" });
  }, [turns, ask.isPending]);

  const m = MODES.find((x) => x.id === mode)!;
  const canSend = (m.needs === "question" ? input.trim().length > 2 : m.needs === "paper" ? paperIds.length === 1 : m.needs === "papers" ? paperIds.length >= 2 : paperIds.length > 0 || clusterId !== "") && !ask.isPending;
  const submit = (e: FormEvent) => { e.preventDefault(); if (canSend) ask.mutate(input.trim()); };
  const last = useMemo(() => [...turns].reverse().find((t) => t.response)?.response, [turns]);
  const togglePaper = (id: number) => setPaperIds((cur) => (m.needs === "paper" ? [id] : cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id].slice(0, 12)));

  return (
    <>
      <PageHeader title="Ask AI" icon={<Bot className="size-6" />}
        description="Ask anything about your papers. Every sentence in the answer points to its source, so you can check it."
        details={<><p>PaperMind first finds the relevant passages and extracted findings in your library, then the AI writes an answer using only those numbered sources. Citations to sources that do not exist are removed, and text inside papers that tries to give the AI instructions is neutralised.</p><p>Without an AI key on the server you still get the most relevant passages, quoted directly.</p></>} />
      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <div className="space-y-4">
          <Tabs value={mode} onChange={(v) => { setMode(v); if (v === "explain" || v === "summarize") setPaperIds((p) => p.slice(0, 1)); }} tabs={MODES.map((x) => ({ id: x.id, label: x.label }))} />
          <p className="text-sm text-ink-400">{m.hint}</p>

          {m.needs !== "question" && (
            <Card title={m.needs === "set" ? "Papers or topic to review" : m.needs === "paper" ? "Paper" : "Papers to compare (2–5)"}>
              {m.needs === "set" && (
                <select value={clusterId} onChange={(e) => setClusterId(e.target.value)} className={`${inputCls} mb-3 w-full`} aria-label="Topic">
                  <option value="">Choose a topic cluster (or pick papers below)</option>
                  {clusters.data?.clusters.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.size})</option>)}
                </select>
              )}
              <div className="max-h-56 space-y-1 overflow-y-auto">
                {papers.data?.papers.filter((p) => p.status === "ready" || p.status === "metadata_only").map((p) => (
                  <label key={p.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-ink-800">
                    <input type={m.needs === "paper" ? "radio" : "checkbox"} name="paper" className="accent-brand-500" checked={paperIds.includes(p.id)} onChange={() => togglePaper(p.id)} />
                    <span className="min-w-0 flex-1 truncate text-ink-200">{p.title}</span>
                    <span className="text-xs text-ink-400">{p.year}</span>
                  </label>
                ))}
              </div>
            </Card>
          )}

          <Card padded={false}>
            <div className="max-h-[56vh] min-h-64 space-y-5 overflow-y-auto p-5">
              {!turns.length && !ask.isPending && <div className="py-10 text-center text-sm text-ink-400">Start with a question or choose papers above.</div>}
              {turns.map((t, i) => (
                <div key={i} className="flex gap-3">
                  <div className={`grid size-8 shrink-0 place-items-center rounded-lg ${t.role === "user" ? "bg-ink-700 text-ink-200" : "bg-brand-600/20 text-brand-300"}`}>
                    {t.role === "user" ? <User className="size-4" /> : <Bot className="size-4" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    {t.role === "user" ? <p className="pt-1 text-sm text-ink-100">{t.content}</p> : <Markdown text={t.content} onCite={setFocus} />}
                    {t.response && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <Badge tone={t.response.generatedBy === "llm" ? "brand" : "info"}>{t.response.generatedBy === "llm" ? `LLM · ${t.response.model}` : "Extractive (no LLM)"}</Badge>
                        <Badge tone={t.response.grounding.coverage >= 0.7 ? "good" : t.response.grounding.coverage >= 0.5 ? "warn" : "bad"} title="Share of sentences with a valid citation">
                          <ShieldCheck className="size-3" /> {Math.round(t.response.grounding.coverage * 100)}% cited
                        </Badge>
                        {t.response.grounding.invalidCitationsRemoved.length > 0 && <Badge tone="warn">{t.response.grounding.invalidCitationsRemoved.length} invalid citation(s) removed</Badge>}
                        {t.response.grounding.injectionFlags > 0 && <Badge tone="warn">{t.response.grounding.injectionFlags} source(s) sanitised</Badge>}
                        {t.response.usage?.cached && <Badge>cached</Badge>}
                      </div>
                    )}
                    {t.response?.grounding.notice && <p className="mt-1.5 text-xs text-warn-ink">{t.response.grounding.notice}</p>}
                  </div>
                </div>
              ))}
              {ask.isPending && <Spinner label="Retrieving evidence and composing a grounded answer…" />}
              {ask.error && <ErrorBox error={ask.error} />}
              <div ref={endRef} />
            </div>
            <form onSubmit={submit} className="flex gap-2 border-t border-ink-700/70 p-3">
              <input value={input} onChange={(e) => setInput(e.target.value)} className={`${inputCls} w-full`}
                placeholder={m.needs === "question" ? "Ask about your papers…" : "Optional focus, e.g. 'evaluation datasets'"} />
              <Button variant="primary" type="submit" disabled={!canSend} loading={ask.isPending} icon={<Send className="size-4" />}>Send</Button>
            </form>
          </Card>
          {usage.data && (
            <p className="text-xs text-ink-400">
              {usage.data.configured ? `Model ${usage.data.model} · ${usage.data.usedToday.toLocaleString()} / ${usage.data.budget.toLocaleString()} tokens used today` : "No LLM key configured on the server: answers are extractive (evidence only). Set OPENROUTER_API_KEY to enable generated answers."}
            </p>
          )}
        </div>

        <Card title={`Sources${last ? ` (${last.sources.length})` : ""}`} className="xl:sticky xl:top-20 xl:max-h-[80vh] xl:overflow-y-auto">
          {!last ? <p className="text-sm text-ink-400">Cited passages appear here. Click a citation chip to jump to its source.</p> : (
            <ol className="space-y-2">
              {last.sources.map((s) => (
                <li key={s.sid} className={`rounded-xl border px-3 py-2 text-sm transition ${focus === s.sid ? "border-brand-400 bg-brand-600/10" : last.grounding.cited.includes(s.sid) ? "border-ink-600 bg-ink-850" : "border-ink-700/60 opacity-70"}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-brand-300">S{s.sid}</span>
                    <span className="flex gap-1">{s.via === "graph" && <Badge tone="brand"><Network className="size-3" /></Badge>}<Badge>{s.kind}</Badge>{s.page && <Badge>p. {s.page}</Badge>}</span>
                  </div>
                  <button onClick={() => openPaper(s.paperId)} className="mt-1 block text-left text-xs font-medium text-ink-100 hover:underline">{s.title}</button>
                  <p className="mt-1 line-clamp-4 text-xs text-ink-300">{s.text}</p>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>
    </>
  );
}
