import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, BookOpen, Bot, Boxes, CheckCircle2, Circle, Compass, FileUp, Lightbulb, Network, Search } from "lucide-react";
import { api, type ClusterMetric, type Overview } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Badge, Card, Spinner, seriesColor } from "../components/ui";

function Step({ done, title, text, to, cta }: { done: boolean; title: string; text: string; to: string; cta: string }) {
  return (
    <li className={`flex gap-4 rounded-2xl border p-4 ${done ? "border-good/25 bg-good/5" : "border-ink-700 bg-ink-850/80"}`}>
      {done ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-good" /> : <Circle className="mt-0.5 size-5 shrink-0 text-ink-500" />}
      <div className="min-w-0 flex-1">
        <div className="font-medium text-ink-100">{title}</div>
        <p className="mt-0.5 text-sm text-ink-300">{text}</p>
      </div>
      <Link to={to} className="inline-flex h-9 shrink-0 items-center gap-1.5 self-center rounded-xl border border-ink-600 bg-ink-800 px-3 text-sm font-medium hover:bg-ink-700">
        {cta} <ArrowRight className="size-4" />
      </Link>
    </li>
  );
}

const TOOLS = [
  { to: "/assistant", icon: Bot, title: "Ask AI", text: "Ask a question. Every answer cites the paper and page." },
  { to: "/search", icon: Search, title: "Search papers", text: "Find the exact passage, table or result you need." },
  { to: "/clusters", icon: Boxes, title: "Topics", text: "See your papers grouped into research themes." },
  { to: "/graph", icon: Network, title: "Connections", text: "Explore how papers, methods and datasets link up." },
  { to: "/insights", icon: Lightbulb, title: "Insights", text: "Research gaps, conflicting results and trends." },
  { to: "/library", icon: FileUp, title: "Upload PDFs", text: "Add your own papers. They stay private to you." },
];

export default function Dashboard() {
  const { user } = useAuth();
  const ov = useQuery({ queryKey: ["overview"], queryFn: () => api.get<Overview>("/analytics/overview"), refetchInterval: 8000 });
  const topics = useQuery({ queryKey: ["cluster-metrics"], queryFn: () => api.get<{ clusters: ClusterMetric[] }>("/clusters/metrics"), refetchInterval: 15000 });
  const o = ov.data;
  const hasPapers = (o?.papers ?? 0) > 0;
  const hasTopics = (topics.data?.clusters.length ?? 0) > 0;

  return (
    <>
      <p className="text-xs font-medium uppercase tracking-wider text-brand-300">Your papers · one knowledge graph · answers with page citations</p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">Welcome{user ? `, ${user.name.split(" ")[0]}` : ""} 👋</h1>
      <p className="mt-1 text-ink-300">
        {hasPapers ? `Your library has ${o!.papers} paper${o!.papers === 1 ? "" : "s"}. Pick a tool below or keep adding papers.` : "Start by adding a few papers about a topic you care about."}
      </p>

      {ov.isLoading ? <Spinner /> : (
        <div className="mt-6 space-y-8">
          {(!hasPapers || !hasTopics) && (
            <section>
              <h2 className="mb-3 text-sm font-semibold text-ink-200">Getting started</h2>
              <ol className="space-y-3">
                <Step done={hasPapers} title="Add papers" to="/discover" cta="Find papers"
                  text="Search open research databases and import papers, or upload PDFs. 5–20 papers on one subject works best." />
                <Step done={hasTopics} title="Let PaperMind read them" to="/library" cta="View library"
                  text="Papers are read automatically in the background (about a minute each). Topics and connections appear by themselves once 3+ papers are ready." />
                <Step done={false} title="Ask your first question" to="/assistant" cta="Ask AI"
                  text="e.g. “Which datasets are used to evaluate these methods?” Answers cite the exact paper and page." />
              </ol>
            </section>
          )}

          {hasPapers && o && (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {[["Papers", o.papers, `${o.fulltext} fully read`], ["Pages read", o.pages.toLocaleString(), `${o.chunks.toLocaleString()} passages indexed`],
                ["Findings & limitations", o.claims, "extracted with page numbers"], ["Methods, datasets & topics", o.entities, "linked across papers"]].map(([label, value, hint]) => (
                <div key={label as string} className="rounded-2xl border border-ink-700/80 bg-ink-850/80 p-4">
                  <div className="text-xs text-ink-300">{label}</div>
                  <div className="mt-1.5 text-2xl font-semibold tabular-nums">{value}</div>
                  <div className="mt-0.5 text-xs text-ink-400">{hint}</div>
                </div>
              ))}
            </div>
          )}

          <section>
            <h2 className="mb-3 text-sm font-semibold text-ink-200">What you can do</h2>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {TOOLS.map(({ to, icon: Icon, title, text }) => (
                <Link key={to} to={to} className="group rounded-2xl border border-ink-700/80 bg-ink-850/80 p-4 transition hover:border-brand-500/40 hover:bg-ink-800">
                  <Icon className="size-5 text-brand-400" />
                  <div className="mt-2 flex items-center gap-1 font-medium text-ink-100">{title}<ArrowRight className="size-4 opacity-0 transition group-hover:opacity-100" /></div>
                  <p className="mt-1 text-sm text-ink-300">{text}</p>
                </Link>
              ))}
            </div>
          </section>

          {hasTopics && (
            <Card title="Your research topics" actions={<Link to="/clusters" className="text-xs text-brand-300 hover:underline">See all →</Link>}>
              <ul className="divide-y divide-ink-700/70">
                {topics.data!.clusters.slice(0, 6).map((c, i) => (
                  <li key={c.id} className="flex items-center gap-3 py-2.5">
                    <span className="size-2.5 shrink-0 rounded-sm" style={{ background: seriesColor(i) }} aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-sm text-ink-100">{c.name}</span>
                    <Badge>{c.size} papers</Badge>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card title="How PaperMind works">
            <ol className="grid gap-4 text-sm text-ink-300 md:grid-cols-3">
              <li><span className="font-medium text-ink-100"><Compass className="mr-1.5 inline size-4" />Reading.</span> Each PDF is read page by page. Text, tables and equations are split into small passages, and methods, datasets, findings and limitations are pulled out with their page numbers.</li>
              <li><span className="font-medium text-ink-100"><Search className="mr-1.5 inline size-4" />Finding.</span> Search combines keyword matching with meaning-based matching, then a second model re-checks the best results, so you get the right passage even when it uses different words.</li>
              <li><span className="font-medium text-ink-100"><BookOpen className="mr-1.5 inline size-4" />Connecting.</span> Similar papers are grouped into topics, and papers are linked through shared methods, datasets, authors and citations. Rankings and insights are calculated, never made up.</li>
            </ol>
          </Card>
        </div>
      )}
    </>
  );
}
