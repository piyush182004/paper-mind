import { createContext, type ReactNode, useCallback, useContext, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ExternalLink, MessageSquareText, RefreshCw, Trash2 } from "lucide-react";
import { api, type PaperDetail } from "../lib/api";
import { Badge, Button, Drawer, ErrorBox, Spinner } from "./ui";
import { StatusBadge } from "./StatusBadge";

const Ctx = createContext<(id: number) => void>(() => {});
export const useOpenPaper = () => useContext(Ctx);

const ENTITY_TONE: Record<string, "brand" | "info" | "good" | "warn" | "neutral"> = {
  method: "brand", model: "info", dataset: "good", task: "warn", metric: "neutral", concept: "neutral",
};

export function PaperDrawerProvider({ children }: { children: ReactNode }) {
  const [id, setId] = useState<number | null>(null);
  const open = useCallback((pid: number) => setId(pid), []);
  return (
    <Ctx.Provider value={open}>
      {children}
      <Drawer open={id != null} onClose={() => setId(null)} title={id != null ? <PaperTitle id={id} /> : null}>
        {id != null && <PaperBody id={id} onClose={() => setId(null)} />}
      </Drawer>
    </Ctx.Provider>
  );
}

function usePaper(id: number) {
  return useQuery({ queryKey: ["paper", id], queryFn: () => api.get<PaperDetail>(`/papers/${id}`) });
}

function PaperTitle({ id }: { id: number }) {
  const { data } = usePaper(id);
  return <>{data?.paper.title ?? "Paper"}</>;
}

function PaperBody({ id, onClose }: { id: number; onClose: () => void }) {
  const { data, isLoading, error } = usePaper(id);
  const qc = useQueryClient();
  const nav = useNavigate();
  const reingest = useMutation({ mutationFn: () => api.post(`/papers/${id}/reingest`), onSuccess: () => qc.invalidateQueries() });
  const remove = useMutation({ mutationFn: () => api.del(`/papers/${id}`), onSuccess: () => { qc.invalidateQueries(); onClose(); } });
  if (isLoading) return <Spinner />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  const p = data.paper;
  const byType = data.entities.reduce<Record<string, PaperDetail["entities"]>>((acc, e) => ((acc[e.type] ??= []).push(e), acc), {});
  const claims = (k: string) => data.claims.filter((c) => c.kind === k);

  return (
    <div className="space-y-6 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={p.status} />
        {p.year && <Badge>{p.year}</Badge>}
        {p.venue && <Badge title={p.venue}>{p.venue.slice(0, 50)}</Badge>}
        <Badge>{p.citation_count.toLocaleString()} citations</Badge>
        {p.page_count && <Badge>{p.page_count} pages</Badge>}
        {data.cluster && <Badge tone="brand">Topic: {data.cluster.name}</Badge>}
      </div>
      {p.status_detail && <p className="text-xs text-ink-400">{p.status_detail}</p>}
      {data.authors.length > 0 && <p className="text-ink-300">{data.authors.map((a) => a.name).join(", ")}</p>}
      {p.abstract && <p className="leading-relaxed text-ink-200">{p.abstract}</p>}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" icon={<MessageSquareText className="size-4" />} onClick={() => { onClose(); nav(`/assistant?mode=explain&papers=${id}`); }}>
          Explain with AI
        </Button>
        {(p.url || p.pdf_url) && (
          <a href={p.pdf_url ?? p.url ?? "#"} target="_blank" rel="noopener noreferrer"
            className="inline-flex h-8 items-center gap-2 rounded-xl border border-ink-600 bg-ink-800 px-3 text-xs font-medium text-ink-100 hover:bg-ink-700">
            <ExternalLink className="size-4" /> Open {p.pdf_url ? "PDF" : "source"}
          </a>
        )}
        <Button size="sm" icon={<RefreshCw className="size-4" />} loading={reingest.isPending} onClick={() => reingest.mutate()}>Re-ingest</Button>
        <Button size="sm" variant="danger" icon={<Trash2 className="size-4" />} loading={remove.isPending}
          onClick={() => confirm("Remove this paper from your library?") && remove.mutate()}>Remove</Button>
      </div>

      {Object.keys(byType).length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-400">Knowledge-graph entities</h3>
          <div className="space-y-2">
            {Object.entries(byType).map(([type, list]) => (
              <div key={type} className="flex flex-wrap items-center gap-1.5">
                <span className="w-16 shrink-0 text-xs capitalize text-ink-400">{type}</span>
                {list.slice(0, 14).map((e) => (
                  <Badge key={e.id} tone={ENTITY_TONE[type] ?? "neutral"} title={e.evidence ?? undefined}>
                    {e.name}{e.source === "text" && e.mentions > 1 ? ` ×${e.mentions}` : ""}
                  </Badge>
                ))}
              </div>
            ))}
          </div>
        </section>
      )}

      {(["contribution", "finding", "limitation"] as const).map((k) => claims(k).length > 0 && (
        <section key={k}>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-400">{k}s ({claims(k).length})</h3>
          <ul className="space-y-2">
            {claims(k).map((c) => (
              <li key={c.id} className="rounded-xl border border-ink-700 bg-ink-850 px-3 py-2 text-ink-200">
                {c.text}
                <div className="mt-1 flex gap-2 text-[11px] text-ink-400">
                  {c.page && <span>p. {c.page}</span>}
                  {k === "finding" && c.polarity !== 0 && <span>{c.polarity > 0 ? "▲ improvement" : "▼ negative result"}</span>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {data.sections.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-400">Indexed structure</h3>
          <div className="flex flex-wrap gap-1.5">
            {data.sections.map((s, i) => (
              <Badge key={i} tone={s.kind === "text" ? "neutral" : "info"}>{s.section ?? "—"}{s.kind !== "text" ? ` · ${s.kind}` : ""} · p.{s.page ?? "?"} · {s.chunks}</Badge>
            ))}
          </div>
        </section>
      )}

      {(data.references.length > 0 || data.citedBy.length > 0) && (
        <section className="grid gap-4 sm:grid-cols-2">
          {([["Cites (in library)", data.references], ["Cited by (in library)", data.citedBy]] as const).map(([label, list]) => (
            <div key={label}>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-400">{label}</h3>
              {list.length ? list.map((r) => <div key={r.id} className="truncate py-0.5 text-ink-200" title={r.title}>{r.title} {r.year && <span className="text-ink-400">({r.year})</span>}</div>)
                : <div className="text-ink-400">None</div>}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
