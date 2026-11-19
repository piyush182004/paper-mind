import { Link } from "react-router-dom";
import { Bot, BookOpen, Boxes, Compass, HelpCircle, KeyRound, Lightbulb, Lock, Network, Search } from "lucide-react";
import { PageHeader } from "../components/ui";

const SECTIONS = [
  { icon: Compass, title: "1. Add papers", to: "/discover", text: "Go to Find papers, search a topic, tick the papers you want and press Import. Or upload your own PDFs in My library. Tip: 5–20 papers on one subject give the best topics and insights." },
  { icon: BookOpen, title: "2. PaperMind reads them", to: "/library", text: "Each paper is read in the background (about a minute with the full PDF, a few seconds for abstract only). It splits the paper into passages, notes the page of each one, and pulls out methods, datasets, findings and limitations." },
  { icon: Bot, title: "3. Ask AI", to: "/assistant", text: "Ask questions in plain English. The answer only uses your papers, and every sentence has a citation like [S2] that you can click to see the exact passage and page." },
  { icon: Search, title: "4. Search papers", to: "/search", text: "Find exact passages, tables or results. It matches both your words and their meaning, then double-checks the best results." },
  { icon: Boxes, title: "5. Topics", to: "/clusters", text: "Your papers are grouped into research themes automatically. Each dot is a paper; dots close together are about similar things. Updates by itself when you add papers." },
  { icon: Network, title: "6. Connections", to: "/graph", text: "A map of how papers link through shared methods, datasets, tasks and citations. Bigger circles are more central. Zoom in to see titles; click anything for details." },
  { icon: Lightbulb, title: "7. Insights, Compare & Stats", to: "/insights", text: "Insights shows research gaps, results that disagree and trends. Compare puts papers side by side. Stats ranks papers with a score that shows its ingredients." },
];

export default function About() {
  return (
    <div className="max-w-4xl">
      <PageHeader title="How it works" icon={<HelpCircle className="size-6" />} description="Everything PaperMind does, in two minutes." />
      <ol className="space-y-3">
        {SECTIONS.map(({ icon: Icon, title, text, to }) => (
          <li key={title} className="flex gap-4 rounded-2xl border border-ink-700/80 bg-ink-850/80 p-4">
            <Icon className="mt-0.5 size-5 shrink-0 text-brand-400" />
            <div>
              <Link to={to} className="font-medium text-ink-100 hover:underline">{title}</Link>
              <p className="mt-1 text-sm text-ink-300">{text}</p>
            </div>
          </li>
        ))}
      </ol>
      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border border-ink-700/80 bg-ink-850/80 p-4 text-sm text-ink-300">
          <div className="mb-1 flex items-center gap-2 font-medium text-ink-100"><Lock className="size-4" /> Privacy</div>
          Your library is private to your account. Uploaded PDFs are never visible to other users. Public papers are read once and shared, so importing them is instant.
        </div>
        <div className="rounded-2xl border border-ink-700/80 bg-ink-850/80 p-4 text-sm text-ink-300">
          <div className="mb-1 flex items-center gap-2 font-medium text-ink-100"><KeyRound className="size-4" /> Honest by design</div>
          Scores, topics and insights are calculated from your papers, never invented by the AI. If your papers don't contain an answer, PaperMind says so.
        </div>
      </div>
    </div>
  );
}
