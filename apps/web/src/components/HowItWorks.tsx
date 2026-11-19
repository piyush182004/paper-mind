import type { ReactNode } from "react";
import { Info } from "lucide-react";

/** Technical details, tucked away for people who want them. */
export function HowItWorks({ children }: { children: ReactNode }) {
  return (
    <details className="group mb-6 rounded-xl border border-ink-700/70 bg-ink-900/60 px-4 py-2.5 text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-ink-300 hover:text-ink-100">
        <Info className="size-4" /> How this works
        <span className="ml-auto text-xs text-ink-400 group-open:hidden">Show</span>
        <span className="ml-auto hidden text-xs text-ink-400 group-open:inline">Hide</span>
      </summary>
      <div className="mt-2 space-y-1.5 pb-1 leading-relaxed text-ink-300">{children}</div>
    </details>
  );
}
