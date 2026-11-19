import { Badge } from "./ui";

const MAP: Record<string, { tone: "good" | "info" | "warn" | "bad" | "neutral"; label: string }> = {
  ready: { tone: "good", label: "✓ Full text" },
  metadata_only: { tone: "info", label: "◐ Abstract only" },
  processing: { tone: "warn", label: "⟳ Processing" },
  queued: { tone: "neutral", label: "… Queued" },
  failed: { tone: "bad", label: "! Failed" },
};

/** Status always carries an icon + label, never colour alone. */
export function StatusBadge({ status }: { status: string }) {
  const m = MAP[status] ?? { tone: "neutral" as const, label: status };
  return <Badge tone={m.tone}>{m.label}</Badge>;
}
