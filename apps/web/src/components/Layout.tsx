import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { HelpCircle, BarChart3, BookOpen, Bot, Boxes, Compass, GitCompareArrows, Home, Lightbulb, Loader2, LogOut, Menu, Network, Search, X } from "lucide-react";
import { api, type Health, type Job } from "../lib/api";
import { useAuth } from "../lib/auth";
import { cx } from "./ui";
import { ThemeToggle, Wordmark } from "./Logo";

const NAV = [
  { group: "Start", items: [
    { to: "/", label: "Home", hint: "Overview & next steps", icon: Home },
    { to: "/discover", label: "Find papers", hint: "Search & import", icon: Compass },
    { to: "/library", label: "My library", hint: "Your papers & uploads", icon: BookOpen },
    { to: "/how-it-works", label: "How it works", hint: "A 2-minute guide", icon: HelpCircle },
  ] },
  { group: "Understand", items: [
    { to: "/assistant", label: "Ask AI", hint: "Answers with citations", icon: Bot },
    { to: "/search", label: "Search papers", hint: "Find exact passages", icon: Search },
    { to: "/clusters", label: "Topics", hint: "Papers grouped by theme", icon: Boxes },
    { to: "/graph", label: "Connections", hint: "Map of how papers link", icon: Network },
  ] },
  { group: "Analyse", items: [
    { to: "/insights", label: "Insights", hint: "Gaps, conflicts, trends", icon: Lightbulb },
    { to: "/compare", label: "Compare", hint: "Papers side by side", icon: GitCompareArrows },
    { to: "/analytics", label: "Stats", hint: "Rankings & numbers", icon: BarChart3 },
  ] },
];

export function Layout() {
  const [open, setOpen] = useState(false);
  const { user, signOut } = useAuth();
  const health = useQuery({ queryKey: ["health"], queryFn: () => api.get<Health>("/health"), refetchInterval: 30_000, retry: false });
  const jobs = useQuery({ queryKey: ["jobs"], queryFn: () => api.get<{ jobs: Job[] }>("/jobs"), refetchInterval: 4000 });
  const active = jobs.data?.jobs.filter((j) => j.status === "running" || j.status === "queued") ?? [];
  const reading = active.filter((j) => j.kind === "ingest").length;
  const mlDown = health.data?.ml === "unavailable";

  const nav = (
    <nav className="flex flex-1 flex-col gap-5 overflow-y-auto px-3 py-3">
      {NAV.map((g) => (
        <div key={g.group}>
          <div className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-400">{g.group}</div>
          {g.items.map(({ to, label, hint, icon: Icon }) => (
            <NavLink key={to} to={to} end={to === "/"} onClick={() => setOpen(false)}
              className={({ isActive }) => cx("flex items-center gap-3 rounded-xl px-3 py-2 transition",
                isActive ? "bg-brand-600/15 text-brand-200 ring-1 ring-inset ring-brand-500/25" : "text-ink-300 hover:bg-ink-800 hover:text-ink-100")}>
              <Icon className="size-4.5 shrink-0" />
              <span className="min-w-0"><span className="block text-sm font-medium">{label}</span><span className="block truncate text-[11px] text-ink-400">{hint}</span></span>
            </NavLink>
          ))}
        </div>
      ))}
    </nav>
  );

  const brand = (
    <div className="px-5 py-4"><Wordmark /></div>
  );

  const account = (
    <div className="flex items-center gap-3 border-t border-ink-800 px-4 py-3">
      {user?.avatarUrl ? <img src={user.avatarUrl} alt="" referrerPolicy="no-referrer" className="size-8 shrink-0 rounded-full" /> : <div className="grid size-8 shrink-0 place-items-center rounded-full bg-ink-700 text-sm font-semibold text-ink-100">{user?.name.slice(0, 1).toUpperCase()}</div>}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-ink-100">{user?.name}</div>
        <div className="truncate text-[11px] text-ink-400">{user?.email}</div>
      </div>
      <button onClick={() => void signOut()} title="Sign out" aria-label="Sign out" className="rounded-lg p-2 text-ink-300 hover:bg-ink-800 hover:text-ink-100"><LogOut className="size-4" /></button>
    </div>
  );

  return (
    <div className="flex h-full">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-ink-800 bg-ink-900/70 lg:flex">{brand}{nav}{account}</aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button aria-label="Close menu" className="absolute inset-0 bg-black/60" onClick={() => setOpen(false)} />
          <aside className="relative flex h-full w-72 flex-col border-r border-ink-800 bg-ink-900">
            <div className="flex items-center justify-between pr-3">{brand}
              <button onClick={() => setOpen(false)} className="rounded-lg p-2 text-ink-300 hover:bg-ink-800" aria-label="Close menu"><X className="size-5" /></button>
            </div>
            {nav}{account}
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-ink-800 bg-ink-950/85 px-4 backdrop-blur sm:px-6">
          <button className="rounded-lg p-2 text-ink-300 hover:bg-ink-800 lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu"><Menu className="size-5" /></button>
          <div className="flex flex-1 flex-wrap items-center justify-end gap-3 text-xs">
            {reading > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-warn/10 px-2.5 py-1 text-warn-ink ring-1 ring-inset ring-warn/30">
                <Loader2 className="size-3.5 animate-spin" /> Reading {reading} paper{reading > 1 ? "s" : ""}…
              </span>
            )}
            {!reading && active.length > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-ink-800 px-2.5 py-1 text-ink-300"><Loader2 className="size-3.5 animate-spin" /> Updating topics & connections…</span>
            )}
            {mlDown && <span className="rounded-full bg-bad/10 px-2.5 py-1 text-bad-ink ring-1 ring-inset ring-bad/30">Smart search is offline: keyword search still works</span>}
            {health.data && !health.data.llm && <span className="hidden rounded-full bg-ink-800 px-2.5 py-1 text-ink-400 sm:inline" title="Set OPENROUTER_API_KEY on the server for AI-written answers">AI answers: quotes only</span>}
          </div>
        <ThemeToggle />
        </header>
        <main className="min-w-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8">
          <div className="mx-auto max-w-[1400px]"><Outlet /></div>
        </main>
      </div>
    </div>
  );
}
