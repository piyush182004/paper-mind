import { useId } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { type ThemePref, useTheme } from "../lib/theme";
import { cx } from "./ui";

/** PaperMind mark: a page with a folded corner whose lines become a small knowledge graph. */
export function LogoMark({ size = 32, className }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={className} role="img" aria-label="PaperMind">
      <defs>
        <linearGradient id={`pm-bg-${id}`} x1="2" y1="2" x2="30" y2="30" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#7a6cef" />
          <stop offset="1" stopColor="#2a8fd6" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill={`url(#pm-bg-${id})`} />
      {/* the page */}
      <path d="M9.2 6h9.3l5.3 5.3v13.9a1.8 1.8 0 0 1-1.8 1.8H9.2a1.8 1.8 0 0 1-1.8-1.8V7.8A1.8 1.8 0 0 1 9.2 6Z" fill="#fff" />
      <path d="M18.5 6v3.9c0 .8.6 1.4 1.4 1.4h3.9" fill="#d9d4fb" />
      {/* text lines turning into a graph */}
      <path d="M10.6 10.2h5.2M10.6 13h3.4" stroke="#b7aef5" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M11.8 21.6 15.6 16.9l4.6 3.3" fill="none" stroke="#6250d6" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="11.8" cy="21.6" r="2.1" fill="#6250d6" />
      <circle cx="15.6" cy="16.9" r="2.1" fill="#2a8fd6" />
      <circle cx="20.2" cy="20.2" r="2.1" fill="#1baf7a" />
    </svg>
  );
}

export function Wordmark({ size = 32 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <LogoMark size={size} />
      <span className="text-[15px] font-semibold tracking-tight text-ink-100">
        Paper<span className="bg-gradient-to-r from-brand-400 to-s1 bg-clip-text text-transparent">Mind</span>
      </span>
    </span>
  );
}

const OPTIONS: { id: ThemePref; label: string; icon: typeof Sun }[] = [
  { id: "light", label: "Light", icon: Sun },
  { id: "system", label: "System", icon: Monitor },
  { id: "dark", label: "Dark", icon: Moon },
];

export function ThemeToggle() {
  const { preference, setPreference } = useTheme();
  return (
    <div role="radiogroup" aria-label="Theme" className="inline-flex rounded-xl border border-ink-700 bg-ink-900 p-0.5">
      {OPTIONS.map(({ id, label, icon: Icon }) => (
        <button key={id} role="radio" aria-checked={preference === id} title={`${label} theme`} onClick={() => setPreference(id)}
          className={cx("grid size-7 place-items-center rounded-lg transition", preference === id ? "bg-ink-700 text-ink-100" : "text-ink-400 hover:text-ink-100")}>
          <Icon className="size-3.5" />
          <span className="sr-only">{label}</span>
        </button>
      ))}
    </div>
  );
}
