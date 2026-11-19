import { type FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Compass, Download, ExternalLink, Search } from "lucide-react";
import { api, qs, type DiscoveredPaper, type SourceName } from "../lib/api";
import { Badge, Button, Card, Empty, ErrorBox, PageHeader, Spinner, inputCls } from "../components/ui";
import { useOpenPaper } from "../components/PaperDrawer";

const LABEL: Record<SourceName, string> = { openalex: "OpenAlex", arxiv: "arXiv" };

export default function Discover() {
  const [q, setQ] = useState("");
  const [sources, setSources] = useState<SourceName[]>(["openalex", "arxiv"]);
  const [yearFrom, setYearFrom] = useState("");
  const [oa, setOa] = useState(true);
  const [params, setParams] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [fulltext, setFulltext] = useState(true);
  const qc = useQueryClient();
  const openPaper = useOpenPaper();

  const available = useQuery({ queryKey: ["sources"], queryFn: () => api.get<{ sources: { name: SourceName; enabled: boolean; note?: string }[] }>("/sources") });
  const results = useQuery({
    queryKey: ["discover", params], enabled: params != null,
    queryFn: () => api.get<{ results: DiscoveredPaper[]; errors: Record<string, string> }>(`/discover?${params}`),
  });
  const importer = useMutation({
    mutationFn: (papers: DiscoveredPaper[]) => api.post<{ imported: { paperId: number; jobId: number }[] }>("/papers/import", { papers, fulltext }),
    onSuccess: () => { setSelected(new Set()); qc.invalidateQueries(); },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (q.trim().length < 2) return;
    setSelected(new Set());
    setParams(qs({ q: q.trim(), sources: sources.join(","), limit: 20, yearFrom: yearFrom || undefined, oa: oa || undefined }));
  };
  const key = (p: DiscoveredPaper) => `${p.source}:${p.sourceId}`;
  const list = results.data?.results ?? [];
  const chosen = list.filter((p) => selected.has(key(p)));

  return (
    <>
      <PageHeader title="Find papers" icon={<Compass className="size-6" />}
        description="Search open research databases and add papers to your library. Papers someone already imported are added instantly."
        details={<><p>Searches OpenAlex (250M+ works) and arXiv at the same time and merges duplicates (by DOI, arXiv id, then title).</p><p><b>Read full text</b> downloads the open-access PDF so answers can cite exact pages, tables and results. Turning it off imports only the title and abstract, which is much faster.</p></>} />

      <Card className="mb-6">
        <form onSubmit={submit} className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row">
            <label className="relative flex-1">
              <span className="sr-only">Search query</span>
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-400" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. graph retrieval-augmented generation" className={`${inputCls} w-full pl-9`} autoFocus />
            </label>
            <input value={yearFrom} onChange={(e) => setYearFrom(e.target.value.replace(/\D/g, "").slice(0, 4))} placeholder="From year" className={`${inputCls} sm:w-32`} aria-label="From year" />
            <Button variant="primary" type="submit" icon={<Search className="size-4" />} loading={results.isFetching}>Search</Button>
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            {(available.data?.sources ?? []).map((s) => (
              <label key={s.name} className={`flex items-center gap-2 ${s.enabled ? "text-ink-200" : "text-ink-500"}`} title={s.note}>
                <input type="checkbox" disabled={!s.enabled} checked={sources.includes(s.name)} className="accent-brand-500"
                  onChange={(e) => setSources((cur) => (e.target.checked ? [...cur, s.name] : cur.filter((x) => x !== s.name)))} />
                {LABEL[s.name]}{s.note && <span className="text-xs text-ink-400">({s.note})</span>}
              </label>
            ))}
            <label className="flex items-center gap-2 text-ink-200"><input type="checkbox" checked={oa} onChange={(e) => setOa(e.target.checked)} className="accent-brand-500" /> Open access only</label>
          </div>
        </form>
      </Card>

      {results.data && Object.keys(results.data.errors).length > 0 && (
        <div className="mb-4 space-y-1 rounded-xl border border-ink-700 bg-ink-850 px-4 py-2.5 text-sm text-ink-300">
          {Object.entries(results.data.errors).map(([s, err]) => <div key={s}><b className="font-medium text-ink-100">{LABEL[s as SourceName] ?? s}</b> is {err}</div>)}
        </div>
      )}
      {results.error && <ErrorBox error={results.error} />}
      {importer.error && <ErrorBox error={importer.error} />}
      {importer.data && (
        <div className="mb-4 rounded-xl border border-good/30 bg-good/10 px-4 py-3 text-sm text-good-ink">
          Imported {importer.data.imported.length} paper(s). Ingestion runs in the background; track it on the dashboard or library.
        </div>
      )}

      {results.isFetching ? <Spinner label="Searching sources…" /> : params == null ? (
        <Empty icon={<Compass className="size-8" />} title="Search OpenAlex and arXiv">Pick papers to import; open-access PDFs are parsed for page-level citations.</Empty>
      ) : list.length === 0 ? <Empty title="No results">Try broader terms or more sources.</Empty> : (
        <>
          <div className="sticky top-14 z-10 -mx-1 mb-3 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-ink-950/90 px-1 py-2 backdrop-blur">
            <span className="text-sm text-ink-300">{list.length} results · {chosen.length} selected</span>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-ink-200" title="Abstract-only import is much faster; full text enables page-level citations, tables and claims.">
                <input type="checkbox" checked={fulltext} onChange={(e) => setFulltext(e.target.checked)} className="accent-brand-500" /> Read full text (PDF)
              </label>
              <Button size="sm" onClick={() => setSelected(new Set(list.filter((p) => !p.libraryId).map(key)))}>Select all new</Button>
              <Button size="sm" variant="primary" icon={<Download className="size-4" />} disabled={!chosen.length} loading={importer.isPending} onClick={() => importer.mutate(chosen)}>
                Import {chosen.length || ""}
              </Button>
            </div>
          </div>
          <ul className="space-y-3">
            {list.map((p) => {
              const k = key(p);
              const on = selected.has(k);
              const owned = p.libraryId != null;
              const toggle = () => { if (!owned) setSelected((cur) => { const n = new Set(cur); if (n.has(k)) n.delete(k); else n.add(k); return n; }); };
              return (
                <li key={k} onClick={(e) => { if (!(e.target as HTMLElement).closest("a,button,input")) toggle(); }}
                  className={`rounded-2xl border p-4 transition ${owned ? "border-ink-700/60 bg-ink-850/40" : on ? "cursor-pointer border-brand-500/70 bg-brand-600/10" : "cursor-pointer border-ink-700/80 bg-ink-850/80 hover:border-ink-600"}`}>
                  <div className="flex gap-3">
                    {owned ? <Check className="mt-1 size-4 shrink-0 text-good" aria-label="Already in your library" />
                      : <input type="checkbox" aria-label={`Select ${p.title}`} checked={on} onChange={toggle} className="mt-1 size-4 shrink-0 cursor-pointer accent-brand-500" />}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <h3 className="font-medium leading-snug text-ink-100">{p.title}</h3>
                        {p.url && <a href={p.url} target="_blank" rel="noopener noreferrer" className="text-ink-400 hover:text-ink-200" aria-label="Open source page"><ExternalLink className="size-4" /></a>}
                      </div>
                      <div className="mt-1 text-xs text-ink-400">{p.authors.slice(0, 4).map((a) => a.name).join(", ")}{p.authors.length > 4 ? " et al." : ""}</div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {p.year && <Badge>{p.year}</Badge>}
                        {p.venue && <Badge title={p.venue}>{p.venue.slice(0, 40)}</Badge>}
                        <Badge>{p.citationCount.toLocaleString()} cites</Badge>
                        {p.foundIn.map((s) => <Badge key={s} tone="info">{LABEL[s]}</Badge>)}
                        {p.pdfUrl ? <Badge tone="good">PDF</Badge> : <Badge tone="warn">no PDF</Badge>}
                        {p.libraryId != null && <button onClick={() => openPaper(p.libraryId!)}><Badge tone="good"><Check className="size-3" /> Already in your library</Badge></button>}
                      </div>
                      {p.abstract && <p className="mt-2 line-clamp-3 text-sm text-ink-300">{p.abstract}</p>}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </>
  );
}
