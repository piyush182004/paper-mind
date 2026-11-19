import { type FormEvent, useState } from "react";
import { Bot, BookOpen, Compass, Lightbulb, Lock, Network, Search, Sparkles } from "lucide-react";
import { useAuth } from "../lib/auth";
import { Button, inputCls } from "../components/ui";
import { PasswordField } from "../components/PasswordField";
import { ThemeToggle, Wordmark } from "../components/Logo";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

const STEPS = [
  { icon: Compass, title: "1. Add papers", text: "Search millions of open papers (arXiv, OpenAlex, Semantic Scholar) and import them in one click, or upload your own PDFs." },
  { icon: Sparkles, title: "2. PaperMind reads them", text: "Every paper is read page by page. Methods, datasets, findings and limitations are pulled out and linked to the exact page." },
  { icon: Bot, title: "3. Ask and explore", text: "Ask questions and get answers with citations. See your papers grouped into topics and connected in a map." },
];

const FEATURES = [
  { icon: Search, title: "Search that understands meaning", text: "Finds the right passage even when it uses different words, and shows the page it came from." },
  { icon: Bot, title: "AI answers you can check", text: "Every sentence cites its source. If your papers don't say it, PaperMind says so." },
  { icon: Network, title: "Topics and connections", text: "Papers are grouped by research topic automatically and linked by shared methods, datasets and citations." },
  { icon: Lightbulb, title: "Research insights", text: "Spot conflicting results, combinations nobody has tested yet, and problems many papers mention." },
];

function AuthCard() {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(() => new URLSearchParams(window.location.search).get("auth_error"));
  const providers = useQuery({ queryKey: ["providers"], queryFn: () => api.get<{ google: boolean }>("/auth/providers"), staleTime: Infinity });
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "up") await signUp(name.trim(), email.trim(), password);
      else await signIn(email.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Invalid request: /, "") : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full max-w-md rounded-2xl border border-ink-700 bg-ink-850/90 p-6 shadow-2xl">
      <div className="mb-5 grid grid-cols-2 rounded-xl border border-ink-700 bg-ink-900 p-1 text-sm font-medium">
        {(["up", "in"] as const).map((m) => (
          <button key={m} type="button" aria-pressed={mode === m}
            onClick={() => { if (m === mode) return; setMode(m); setError(null); setName(""); setEmail(""); setPassword(""); }}
            className={`rounded-lg py-2 transition ${mode === m ? "bg-ink-700 text-ink-100" : "text-ink-300 hover:text-ink-100"}`}>
            {m === "up" ? "Create account" : "Sign in"}
          </button>
        ))}
      </div>
      {providers.data?.google && (
        <>
          <a href="/api/auth/google/start" className="flex h-10 w-full items-center justify-center gap-2.5 rounded-xl border border-ink-600 bg-ink-800 text-sm font-medium text-ink-100 hover:bg-ink-700">
            <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.6 5.9c4.4-4.1 7-10.1 7-17.6z"/><path fill="#FBBC05" d="M10.5 28.7a14.5 14.5 0 0 1 0-9.4l-7.9-6.1a24 24 0 0 0 0 21.6l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2.1 1.4-4.9 2.3-8.3 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/></svg>
            Continue with Google
          </a>
          <div className="my-4 flex items-center gap-3 text-xs text-ink-400"><span className="h-px flex-1 bg-ink-700" />or use email<span className="h-px flex-1 bg-ink-700" /></div>
        </>
      )}
      <form key={mode} onSubmit={submit} className="space-y-3">
        {mode === "up" && (
          <label className="block text-sm"><span className="mb-1 block text-ink-300">Name</span>
            <input required value={name} onChange={(e) => setName(e.target.value)} className={`${inputCls} w-full`} autoComplete="name" />
          </label>
        )}
        <label className="block text-sm"><span className="mb-1 block text-ink-300">Email</span>
          <input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={`${inputCls} w-full`} autoComplete="email" />
        </label>
        <label className="block text-sm"><span className="mb-1 block text-ink-300">Password</span>
          <PasswordField value={password} onChange={setPassword} autoComplete={mode === "up" ? "new-password" : "current-password"} placeholder={mode === "up" ? "At least 8 characters" : ""} />
        </label>
        {error && <p role="alert" className="rounded-lg bg-bad/10 px-3 py-2 text-sm text-bad-ink">{error}</p>}
        <Button variant="primary" type="submit" loading={busy} className="w-full">{mode === "up" ? "Create free account" : "Sign in"}</Button>
      </form>
      <p className="mt-4 flex items-start gap-2 text-xs text-ink-400"><Lock className="mt-0.5 size-3.5 shrink-0" /> Your library is private. Uploaded PDFs are only visible to you.</p>
    </div>
  );
}

export default function Welcome() {
  return (
    <div className="min-h-full bg-[radial-gradient(1000px_500px_at_10%_-10%,rgba(98,80,214,0.18),transparent_60%),radial-gradient(800px_500px_at_100%_0%,rgba(57,135,229,0.12),transparent_60%)]">
      <header className="mx-auto flex max-w-6xl items-center gap-2.5 px-6 py-5">
        <Wordmark size={36} />
        <span className="ml-auto"><ThemeToggle /></span>
      </header>

      <section className="mx-auto grid max-w-6xl items-center gap-12 px-6 pb-16 pt-6 lg:grid-cols-[1fr_420px]">
        <div>
          <span className="inline-flex items-center gap-2 rounded-full bg-brand-600/15 px-3 py-1 text-xs font-medium text-brand-300 ring-1 ring-inset ring-brand-500/30">
            <BookOpen className="size-3.5" /> Hybrid RAG · ML topic clustering · Knowledge graph
          </span>
          <h1 className="mt-5 text-4xl font-bold leading-tight tracking-tight sm:text-5xl">
            Your paper library, <span className="bg-gradient-to-r from-brand-400 to-s1 bg-clip-text text-transparent">wired into a knowledge graph.</span>
          </h1>
          <p className="mt-5 max-w-xl text-lg text-ink-300">
            Drop in papers and watch embeddings, ML clustering and graph analytics turn them into a living map of your field. Ask anything and every answer cites the exact page.
          </p>
          <div className="mt-8 grid gap-4 sm:grid-cols-3">
            {STEPS.map(({ icon: Icon, title, text }) => (
              <div key={title} className="rounded-2xl border border-ink-700/80 bg-ink-850/70 p-4">
                <Icon className="size-5 text-brand-400" />
                <div className="mt-2 text-sm font-semibold">{title}</div>
                <p className="mt-1 text-xs leading-relaxed text-ink-300">{text}</p>
              </div>
            ))}
          </div>
        </div>
        <AuthCard />
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-20">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map(({ icon: Icon, title, text }) => (
            <div key={title} className="rounded-2xl border border-ink-700/60 p-5">
              <Icon className="size-5 text-s1" />
              <div className="mt-3 font-semibold">{title}</div>
              <p className="mt-1.5 text-sm text-ink-300">{text}</p>
            </div>
          ))}
        </div>
        <p className="mt-10 text-center text-xs text-ink-400">Free and open data sources · Works without an AI key (answers then quote your papers directly)</p>
      </section>
    </div>
  );
}
