/** Text utilities shared by indexing and querying (the same tokenizer must be used for both). */
import { stemmer } from "stemmer";

const STOP = new Set(
  `a about above after again against all also am an and any are as at be because been before being below between both but by
  can could did do does doing down during each few for from further had has have having he her here hers herself him himself
  his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other our ours
  ourselves out over own same she should so some such than that the their theirs them themselves then there these they this
  those through to too under until up very was we were what when where which while who whom why will with would you your
  yours yourself yourselves et al via thus hence however therefore i.e e.g fig figure table section paper also using use used`
    .split(/\s+/)
    .filter(Boolean),
);

const TOKEN = /[a-z0-9][a-z0-9+#.-]*[a-z0-9+#]|[a-z0-9]/g;

/** Lower-case, split, drop stopwords and pure numbers, Porter-stem. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().normalize("NFKD").matchAll(TOKEN)) {
    let t = raw[0].replace(/\.+$/, "");
    if (t.length < 2 || STOP.has(t) || /^\d+(\.\d+)?$/.test(t)) continue;
    if (t.length > 40) t = t.slice(0, 40);
    out.push(/^[a-z]+$/.test(t) ? stemmer(t) : t);
  }
  return out;
}

export function termFrequencies(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

const ABBREV = /\b(?:et al|e\.g|i\.e|fig|figs|eq|eqs|vs|cf|approx|resp|no|vol|sec|ref|refs|dr|mr|ms|etc)\.$/i;

/** Sentence splitter that respects common scientific abbreviations and decimals. */
export function sentences(text: string): string[] {
  const parts = text.replace(/\s+/g, " ").split(/(?<=[.!?])\s+(?=[A-Z(\["“])/);
  const out: string[] = [];
  for (const p of parts) {
    if (out.length && ABBREV.test(out[out.length - 1])) out[out.length - 1] += " " + p;
    else out.push(p);
  }
  return out.map((s) => s.trim()).filter((s) => s.length > 20);
}

export const normKey = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9+#]+/g, " ").trim();

/** Rough token estimate for budgeting (≈4 chars per token for English). */
export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

/** Remove NUL and other control characters (Postgres rejects 0x00 in text). */
export const stripControl = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F￾￿]/g, "");

export const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
