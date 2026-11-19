import { type DragEvent, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, FileUp, Search, Trash2 } from "lucide-react";
import { api, qs, type PaperListItem } from "../lib/api";
import { Button, Card, Empty, ErrorBox, PageHeader, Spinner, inputCls } from "../components/ui";
import { StatusBadge } from "../components/StatusBadge";
import { useOpenPaper } from "../components/PaperDrawer";

export default function Library() {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState("recent");
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const remove = useMutation({
    mutationFn: async (ids: number[]) => { for (const id of ids) await api.del(`/papers/${id}`); },
    onSuccess: () => { setPicked(new Set()); qc.invalidateQueries(); },
  });
  const askRemove = (ids: number[]) => {
    if (ids.length && confirm(ids.length === 1 ? "Remove this paper from your library?" : `Remove ${ids.length} papers from your library?`)) remove.mutate(ids);
  };
  const qc = useQueryClient();
  const openPaper = useOpenPaper();
  const retry = useMutation({
    mutationFn: (id: number) => api.post(`/papers/${id}/reingest`),
    onSuccess: () => qc.invalidateQueries(),
  });

  const papers = useQuery({
    queryKey: ["papers", q, status, sort],
    queryFn: () => api.get<{ papers: PaperListItem[]; total: number }>(`/papers?${qs({ q: q.length > 1 ? q : undefined, status, sort, limit: 200 })}`),
    refetchInterval: (query) => (query.state.data?.papers.some((p) => p.status === "queued" || p.status === "processing") ? 3000 : false),
  });
  const upload = useMutation({
    mutationFn: (files: File[]) => api.upload<{ uploaded: { file: string; paperId?: number; error?: string }[] }>("/papers/upload", files),
    onSuccess: () => qc.invalidateQueries(),
  });
  const onFiles = (list: FileList | null) => {
    const files = Array.from(list ?? []).filter((f) => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"));
    if (files.length) upload.mutate(files);
  };
  const onDrop = (e: DragEvent) => { e.preventDefault(); setDrag(false); onFiles(e.dataTransfer.files); };

  return (
    <>
      <PageHeader title="My library" icon={<BookOpen className="size-6" />}
        description="All your papers in one place. Upload your own PDFs here: they are private to you."
        details={<><p>Each paper is read in the background: text, sections, tables and equations are split into passages, turned into searchable vectors and keyword index entries, and methods, datasets, findings and limitations are extracted with page numbers.</p></>}
        actions={<Button variant="primary" icon={<FileUp className="size-4" />} loading={upload.isPending} onClick={() => fileRef.current?.click()}>Upload PDFs</Button>} />
      <input ref={fileRef} type="file" accept="application/pdf" multiple hidden onChange={(e) => onFiles(e.target.files)} />

      <div onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}
        className={`mb-6 rounded-2xl border-2 border-dashed px-6 py-6 text-center text-sm transition ${drag ? "border-brand-400 bg-brand-600/10 text-brand-200" : "border-ink-700 text-ink-400"}`}>
        Drop PDFs here to upload. They are parsed page by page (text, sections, tables, equations) and indexed like discovered papers.
      </div>
      {upload.error && <ErrorBox error={upload.error} />}
      {upload.data && (
        <div className="mb-4 text-sm text-ink-300">
          {upload.data.uploaded.map((u) => <div key={u.file}>{u.file}: {u.error ? <span className="text-bad-ink">{u.error}</span> : <span className="text-good-ink">queued as paper {u.paperId}</span>}</div>)}
        </div>
      )}

      <Card padded={false}>
        <div className="flex flex-wrap gap-3 border-b border-ink-700/70 p-4">
          <label className="relative min-w-60 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-400" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by title / abstract (full-text index)" className={`${inputCls} w-full pl-9`} />
          </label>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={`${inputCls} w-44`} aria-label="Status">
            <option value="">All statuses</option><option value="ready">Full text</option><option value="metadata_only">Abstract only</option>
            <option value="processing">Processing</option><option value="queued">Queued</option><option value="failed">Failed</option>
          </select>
          <select value={sort} onChange={(e) => setSort(e.target.value)} className={`${inputCls} w-40`} aria-label="Sort">
            <option value="recent">Recently added</option><option value="year">Newest</option><option value="citations">Most cited</option><option value="title">Title</option>
          </select>
        </div>
        {papers.isLoading ? <div className="px-5"><Spinner /></div> : papers.error ? <div className="p-5"><ErrorBox error={papers.error} /></div> : !papers.data?.papers.length ? (
          <div className="p-5"><Empty icon={<BookOpen className="size-6" />} title="No papers">Discover papers or upload PDFs to start.</Empty></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-ink-400">
                <tr><th className="w-10 pl-5"><input type="checkbox" aria-label="Select all" className="accent-brand-500"
                  checked={papers.data.papers.length > 0 && picked.size === papers.data.papers.length}
                  onChange={(e) => setPicked(e.target.checked ? new Set(papers.data!.papers.map((x) => x.id)) : new Set())} /></th><th className="px-3 py-2.5 font-medium">Title</th><th className="px-3 font-medium">Year</th><th className="px-3 font-medium">Cites</th><th className="px-3 font-medium">Chunks</th><th className="px-3 font-medium">Status</th><th className="px-3 font-medium">Source</th><th className="w-12 pr-5"><span className="sr-only">Actions</span></th></tr>
              </thead>
              <tbody>
                {papers.data.papers.map((p) => (
                  <tr key={p.id} onClick={() => openPaper(p.id)} className={`cursor-pointer border-t border-ink-700/70 hover:bg-ink-800/60 ${picked.has(p.id) ? "bg-brand-600/10" : ""}`}>
                    <td className="pl-5" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" aria-label={`Select ${p.title}`} className="accent-brand-500" checked={picked.has(p.id)}
                        onChange={() => setPicked((cur) => { const n = new Set(cur); if (n.has(p.id)) n.delete(p.id); else n.add(p.id); return n; })} />
                    </td>
                    <td className="max-w-xl px-3 py-3">
                      <div className="truncate font-medium text-ink-100" title={p.title}>{p.title}</div>
                      <div className="truncate text-xs text-ink-400">{p.authors ?? "—"}</div>
                    </td>
                    <td className="px-3 tabular-nums text-ink-300">{p.year ?? "—"}</td>
                    <td className="px-3 tabular-nums text-ink-300">{p.citation_count.toLocaleString()}</td>
                    <td className="px-3 tabular-nums text-ink-300">{p.chunks}</td>
                    <td className="px-3 py-2" title={p.status_detail ?? ""}>
                      <StatusBadge status={p.status} />
                      {(p.status === "processing" || p.status === "failed") && p.status_detail && (
                        <div className="mt-1 max-w-[13rem] truncate text-[11px] text-ink-400">{p.status_detail}</div>
                      )}
                      {p.status === "failed" && (
                        <button onClick={(e) => { e.stopPropagation(); retry.mutate(p.id); }} disabled={retry.isPending}
                          className="mt-1 text-[11px] font-medium text-brand-400 hover:underline disabled:opacity-50">Retry</button>
                      )}
                    </td>
                    <td className="px-3 text-ink-400">{p.source}</td>
                    <td className="pr-5 text-right" onClick={(e) => e.stopPropagation()}>
                      <button onClick={() => askRemove([p.id])} title="Remove from library" aria-label={`Remove ${p.title}`}
                        className="rounded-lg p-1.5 text-ink-400 hover:bg-bad/10 hover:text-bad-ink"><Trash2 className="size-4" /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex items-center justify-between gap-3 border-t border-ink-700/70 px-5 py-2.5 text-xs text-ink-400">
              <span>{papers.data.total} papers{picked.size ? ` · ${picked.size} selected` : ""}</span>
              {picked.size > 0 && <Button size="sm" variant="danger" icon={<Trash2 className="size-4" />} loading={remove.isPending} onClick={() => askRemove([...picked])}>Remove selected</Button>}
            </div>
          </div>
        )}
      </Card>
    </>
  );
}
