import { type ButtonHTMLAttributes, type ReactNode, useEffect } from "react";
import { Loader2, X } from "lucide-react";
import { HowItWorks } from "./HowItWorks";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

export function PageHeader({ title, description, actions, icon, details }: { title: string; description?: ReactNode; actions?: ReactNode; icon?: ReactNode; details?: ReactNode }) {
  return (
    <>
    <div className={`${details ? "mb-4" : "mb-6"} flex flex-wrap items-end justify-between gap-4`}>
      <div className="min-w-0">
        <h1 className="flex items-center gap-2.5 text-2xl font-semibold tracking-tight text-ink-100">
          {icon && <span className="text-brand-400">{icon}</span>}
          {title}
        </h1>
        {description && <p className="mt-1.5 max-w-3xl text-sm text-ink-300">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
    {details && <HowItWorks>{details}</HowItWorks>}
    </>
  );
}

export function Card({ title, actions, children, className, padded = true }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; padded?: boolean }) {
  return (
    <section className={cx("min-w-0 rounded-2xl border border-ink-700/80 bg-ink-850/80 shadow-[0_1px_0_rgba(255,255,255,0.03)_inset]", className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-ink-700/70 px-5 py-3.5">
          <h2 className="text-sm font-semibold text-ink-100">{title}</h2>
          {actions}
        </header>
      )}
      <div className={padded ? "p-5" : ""}>{children}</div>
    </section>
  );
}

type Variant = "primary" | "secondary" | "ghost" | "danger";
export function Button({ variant = "secondary", size = "md", loading, icon, children, className, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md"; loading?: boolean; icon?: ReactNode }) {
  const v: Record<Variant, string> = {
    primary: "bg-brand-600 text-white hover:bg-brand-500 shadow-[0_6px_20px_-8px_rgba(122,108,239,0.8)]",
    secondary: "border border-ink-600 bg-ink-800 text-ink-100 hover:border-ink-500 hover:bg-ink-700",
    ghost: "text-ink-300 hover:bg-ink-800 hover:text-ink-100",
    danger: "border border-bad/40 bg-bad/10 text-bad-ink hover:bg-bad/20",
  };
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "h-8 px-3 text-xs" : "h-10 px-4 text-sm", v[variant], className,
      )}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

const TONES = {
  neutral: "bg-ink-700/70 text-ink-200 ring-ink-600",
  brand: "bg-brand-600/15 text-brand-300 ring-brand-500/30",
  good: "bg-good/12 text-good-ink ring-good/30",
  warn: "bg-warn/12 text-warn-ink ring-warn/30",
  bad: "bg-bad/12 text-bad-ink ring-bad/30",
  info: "bg-s1/15 text-info-ink ring-s1/30",
} as const;
export function Badge({ tone = "neutral", children, className, title }: { tone?: keyof typeof TONES; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cx("inline-flex max-w-full items-center gap-1 truncate rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset", TONES[tone], className)}>
      {children}
    </span>
  );
}

export function Stat({ label, value, hint, icon }: { label: string; value: ReactNode; hint?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-ink-700/80 bg-ink-850/80 p-4">
      <div className="flex items-center justify-between text-xs font-medium text-ink-300">
        {label}
        <span className="text-ink-400">{icon}</span>
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums tracking-tight text-ink-100">{value}</div>
      {hint && <div className="mt-1 text-xs text-ink-400">{hint}</div>}
    </div>
  );
}

export const Spinner = ({ label }: { label?: string }) => (
  <div className="flex items-center gap-2 py-6 text-sm text-ink-300">
    <Loader2 className="size-4 animate-spin text-brand-400" /> {label ?? "Loading…"}
  </div>
);

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-ink-600 px-6 py-12 text-center">
      {icon && <div className="mb-3 text-ink-400">{icon}</div>}
      <div className="text-sm font-medium text-ink-200">{title}</div>
      {children && <div className="mt-1.5 max-w-md text-sm text-ink-400">{children}</div>}
    </div>
  );
}

export const ErrorBox = ({ error }: { error: unknown }) => (
  <div role="alert" className="rounded-xl border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad-ink">
    {error instanceof Error ? error.message : String(error)}
  </div>
);

/** 0..1 value as a thin bar; text stays in ink colours, the bar carries the value. */
export function ScoreBar({ value, label, hint, color = "var(--color-brand-400)" }: { value: number | null | undefined; label?: string; hint?: string; color?: string }) {
  const v = value == null ? null : Math.max(0, Math.min(1, value));
  return (
    <div className="min-w-0" title={hint}>
      {label && (
        <div className="mb-1 flex justify-between gap-2 text-[11px] text-ink-300">
          <span className="truncate">{label}</span>
          <span className="tabular-nums text-ink-200">{v == null ? "n/a" : v.toFixed(2)}</span>
        </div>
      )}
      <div className="h-1.5 overflow-hidden rounded-full bg-ink-700">
        {v != null && <div className="h-full rounded-full" style={{ width: `${v * 100}%`, background: color }} />}
      </div>
    </div>
  );
}

export const inputCls =
  "h-10 rounded-xl border border-ink-600 bg-ink-900 px-3 text-sm text-ink-100 placeholder:text-ink-400 outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-500/25";

export function Drawer({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <button aria-label="Close" className="absolute inset-0 bg-black/55 backdrop-blur-[2px]" onClick={onClose} />
      <div className="relative flex h-full w-full max-w-2xl flex-col border-l border-ink-700 bg-ink-900 shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-ink-700 px-6 py-4">
          <div className="min-w-0 text-base font-semibold leading-snug text-ink-100">{title}</div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-ink-300 hover:bg-ink-800 hover:text-ink-100" aria-label="Close panel">
            <X className="size-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { id: T; label: ReactNode }[] }) {
  return (
    <div role="tablist" className="inline-flex rounded-xl border border-ink-700 bg-ink-900 p-1">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)}
          className={cx("rounded-lg px-3 py-1.5 text-sm font-medium transition", value === t.id ? "bg-ink-700 text-ink-100" : "text-ink-300 hover:text-ink-100")}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** Fixed categorical order for clusters (never cycled: beyond 8, extra topics fold into neutral). */
export const SERIES = ["var(--color-s1)", "var(--color-s2)", "var(--color-s3)", "var(--color-s4)", "var(--color-s5)", "var(--color-s6)", "var(--color-s7)", "var(--color-s8)"];
export const seriesColor = (i: number) => (i >= 0 && i < SERIES.length ? SERIES[i] : "var(--color-ink-400)");

/** Minimal, safe Markdown → React (no HTML injection): headings, bullets, tables, bold, citations. */
export function Markdown({ text, onCite }: { text: string; onCite?: (n: number) => void }) {
  const inline = (s: string, key: string) =>
    s.split(/(\*\*[^*]+\*\*|\[S\d+(?:,\s*S\d+)*\])/g).map((part, i) => {
      if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={`${key}-${i}`} className="font-semibold text-ink-100">{part.slice(2, -2)}</strong>;
      if (/^\[S\d+/.test(part))
        return [...part.matchAll(/S(\d+)/g)].map((m) => (
          <button key={`${key}-${i}-${m[1]}`} onClick={() => onCite?.(Number(m[1]))}
            className="mx-0.5 inline-flex h-5 items-center rounded-md bg-brand-600/20 px-1.5 align-middle text-[11px] font-semibold text-brand-300 hover:bg-brand-600/35">
            S{m[1]}
          </button>
        ));
      return <span key={`${key}-${i}`}>{part}</span>;
    });
  const lines = text.split("\n");
  const out: ReactNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*\|.*\|\s*$/.test(l)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) rows.push(lines[i].trim().slice(1, -1).split("|").map((c) => c.trim()));
        i++;
      }
      i--;
      out.push(
        <div key={`t${i}`} className="my-3 overflow-x-auto rounded-xl border border-ink-700">
          <table className="w-full text-left text-sm">
            <tbody>{rows.map((r, ri) => (
              <tr key={ri} className={ri === 0 ? "bg-ink-800 font-semibold" : "border-t border-ink-700"}>
                {r.map((c, ci) => <td key={ci} className="px-3 py-2 align-top text-ink-200">{inline(c, `t${i}${ri}${ci}`)}</td>)}
              </tr>))}
            </tbody>
          </table>
        </div>,
      );
    } else if (/^#{1,4}\s/.test(l)) out.push(<h3 key={i} className="mb-1.5 mt-4 font-semibold text-ink-100">{inline(l.replace(/^#+\s/, ""), `h${i}`)}</h3>);
    else if (/^\s*[-*]\s+/.test(l)) out.push(<li key={i} className="ml-5 list-disc py-0.5 text-ink-200">{inline(l.replace(/^\s*[-*]\s+/, ""), `l${i}`)}</li>);
    else if (/^\s*\d+\.\s+/.test(l)) out.push(<li key={i} className="ml-5 list-decimal py-0.5 text-ink-200">{inline(l.replace(/^\s*\d+\.\s+/, ""), `o${i}`)}</li>);
    else if (l.trim()) out.push(<p key={i} className="my-2 leading-relaxed text-ink-200">{inline(l, `p${i}`)}</p>);
  }
  return <div className="text-sm">{out}</div>;
}
