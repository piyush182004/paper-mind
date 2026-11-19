/**
 * Rule-based information extraction for the knowledge graph. Deterministic and traceable:
 * every entity mention and every claim points at the chunk (and page) it came from.
 *
 *  entities: curated gazetteer (methods, models, datasets, metrics, tasks) + "we propose X" patterns
 *  claims:   sentence classification by cue phrases -> finding | limitation | contribution,
 *            with polarity (+1 improves / -1 worsens) for findings
 */
import { countMentions, MATCHERS, type EntityType } from "./gazetteer.js";
import type { ChunkDraft } from "./chunker.js";
import { normKey, sentences } from "../lib/text.js";

export interface ExtractedEntity {
  type: EntityType;
  name: string;
  key: string;
  mentions: number;
  evidenceOrd: number; // chunk ord of the first mention
  evidence: string;    // the sentence that mentions it
}

export interface ExtractedClaim {
  kind: "finding" | "limitation" | "contribution";
  text: string;
  ord: number;
  page: number | null;
  polarity: -1 | 0 | 1;
  entityKeys: string[]; // `${type}:${key}`
}

const PROPOSE = /\b[Ww]e (?:propose|introduce|present|develop|design)\s+(?:a |an |the )?(?:novel |new |simple |general )?(?:[\w-]+\s){0,5}?(?:called|named|dubbed|termed)?\s*,?\s*([A-Z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*)\b/g;
const NOT_NAMES = new Set(["We", "In", "This", "The", "A", "An", "Our", "It", "To", "For", "On", "First", "Finally", "Specifically"]);

// Strong cues are limitations on their own; weak cues ("cannot", "fails to") also appear in
// motivation sentences, so they only count when the sentence is about the authors' own work
// or sits in a Limitations / Discussion / Conclusion section.
const LIMITATION_STRONG = /\b(limitations?|shortcomings?|drawbacks?|future work|we leave .{0,40} (?:to|for) future|remains? (?:an )?open (?:problem|question|challenge))\b/i;
const LIMITATION_WEAK = /\b(fails? to|failed to|does not (?:generali[sz]e|scale|hold|transfer)|do not (?:generali[sz]e|scale)|cannot|is limited|are limited|not (?:yet )?(?:addressed|explored)|is restricted to|struggles? (?:to|with))\b/i;
const SELF_REF = /\b(our|we|this (?:work|paper|study|approach|method|model|framework|system)|the proposed)\b/i;
const LIMITATION_SECTION = /limitation|discussion|conclusion|future|threats/i;
// "X addresses / overcomes this limitation" describes a solution, not a limitation
const SOLVES_LIMITATION = /\b(address(?:es|ed|ing)?|overcom(?:e|es|ing)|mitigat(?:e|es|ed|ing)|solv(?:e|es|ed|ing)|tackl(?:e|es|ed|ing)|alleviat(?:e|es|ed|ing)|resolv(?:e|es|ed|ing)|remed(?:y|ies|ied))\b[^.]{0,40}\b(limitations?|shortcomings?|drawbacks?)\b/i;
const isLimitation = (s: string, section: string | null) =>
  !SOLVES_LIMITATION.test(s) &&
  (LIMITATION_STRONG.test(s) || (LIMITATION_WEAK.test(s) && (SELF_REF.test(s) || LIMITATION_SECTION.test(section ?? ""))));
const FINDING = /\b(we (?:show|find|found|demonstrate|observe|confirm)|(?:results|experiments|evaluations?|analysis) (?:show|indicate|demonstrate|suggest|reveal|confirm)|outperform(?:s|ed|ing)?|surpass(?:es|ed)?|achiev(?:es|ed|ing) (?:a |an )?(?:new |state-of-the-art|sota|competitive|comparable|significant)|state-of-the-art|improv(?:es|ed|ement|ements) (?:of|by|over|on|in)|significantly (?:better|worse|higher|lower|improves?|reduces?)|leads? to (?:a |an )?(?:significant |substantial )?(?:improvement|reduction|degradation|drop|increase|decrease)|(?:increase|decrease|reduce|reduction|drop)s? (?:in )?(?:accuracy|error|performance|loss|latency))\b/i;
const CONTRIBUTION = /\b(we (?:propose|introduce|present|develop|release)|our (?:main )?contributions?|in this (?:paper|work),? we)\b/i;

const POS = /\b(outperform|surpass|improv|better|higher (?:accuracy|performance|scores?)|gains?|boost|state-of-the-art|sota|increase[sd]? (?:the )?(?:accuracy|performance)|reduc(?:es|ed|ing) (?:the )?(?:error|loss|cost|latency|hallucination)|effective|robust)/i;
const NEG = /\b(worse|degrad|fail|hurt|underperform|lower (?:accuracy|performance)|decrease[sd]? (?:the )?(?:accuracy|performance)|no (?:significant |clear |consistent )?(?:improvement|benefit|gain|effect|difference)|does not (?:improve|help|outperform)|did not (?:improve|help|outperform)|not (?:effective|beneficial|significant)|ineffective|harmful|drops?)/i;

export function polarityOf(s: string): -1 | 0 | 1 {
  const neg = NEG.test(s);
  const pos = POS.test(s);
  if (neg && !pos) return -1;
  if (pos && !neg) return 1;
  if (pos && neg) return /\b(no|not|without|fail)\b.{0,30}\b(improv|better|gain|outperform)/i.test(s) ? -1 : 0;
  return 0;
}

export function extractEntities(chunks: ChunkDraft[]): ExtractedEntity[] {
  const found = new Map<string, ExtractedEntity>();
  const add = (type: EntityType, name: string, n: number, ord: number, evidence: string) => {
    const key = normKey(name);
    if (!key) return;
    const id = `${type}:${key}`;
    const prev = found.get(id);
    if (prev) prev.mentions += n;
    else found.set(id, { type, name, key, mentions: n, evidenceOrd: ord, evidence });
  };

  for (const c of chunks) {
    if (c.kind === "equation") continue;
    for (const m of MATCHERS) {
      const n = countMentions(m, c.content);
      if (!n) continue;
      const sent = sentences(c.content).find((s) => countMentions(m, s) > 0) ?? c.content.slice(0, 240);
      add(m.type, m.canonical, n, c.ord, sent.slice(0, 400));
    }
    for (const match of c.content.matchAll(PROPOSE)) {
      const name = match[1];
      // a proposed *name* has an internal capital or a digit (BERT, GraphSAGE, T5), not a plain word
      if (NOT_NAMES.has(name) || name.length < 2 || name.length > 24) continue;
      if (!/[A-Z]/.test(name.slice(1)) && !/\d/.test(name)) continue;
      add("method", name, 1, c.ord, match[0].slice(0, 300));
    }
  }
  // names learned from the paper's own text (no fixed list): datasets, benchmarks, defined acronyms
  for (const cand of learnedCandidates(chunks)) {
    const key = normKey(cand.name);
    if (!key || [...found.values()].some((e) => e.key === key)) continue;
    const re = new RegExp(`(?<![\\w-])${cand.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "g");
    let mentions = 0;
    for (const c of chunks) mentions += c.content.match(re)?.length ?? 0;
    found.set(`${cand.type}:${key}`, { type: cand.type, name: cand.name, key, mentions: Math.max(1, mentions), evidenceOrd: cand.ord, evidence: cand.evidence });
  }

  // keep entities that are mentioned more than in passing, or appear in the abstract
  return [...found.values()].filter((e) => e.mentions >= 2 || e.evidenceOrd === 0);
}

// ------------------------------------------------------------------ learned (pattern-based) entities
const NOT_A_NAME = new Set(("The This That These Those Our Their Its We Each Every Both All Any Some Most Many Several Such Other Another New Large Small Public Private " +
  "Table Figure Fig Section Appendix Equation Eq Algorithm Results Experiments Training Test Validation Evaluation Original Standard Real Synthetic " +
  "January February March April May June July August September October November December First Second Third Final Main Full Same Different Additional").split(" "));
const NAME = String.raw`[A-Z][A-Za-z0-9]*(?:[-.][A-Za-z0-9]+)*(?:\s(?:[A-Z0-9][A-Za-z0-9]*(?:[-.][A-Za-z0-9]+)*)){0,3}`;
const DATASET_BEFORE = new RegExp(String.raw`(?:^|[\s(,;])(?:the\s)?(${NAME})\s(?:dataset|data set|benchmark|corpus|corpora|test set|testbed|collection)s?\b`, "g");
const EVAL_ON = new RegExp(String.raw`\b(?:evaluat\w*|experiment\w*|test\w*|benchmark\w*|trained|fine-tuned|results)\s(?:\w+\s){0,3}?on\s(?:the\s)?((?:${NAME})(?:\s?,\s?(?:and\s)?(?:the\s)?${NAME}){0,5}(?:,?\sand\s(?:the\s)?${NAME})?)`, "g");
const ACRONYM_DEF = /\b([A-Z][a-z]+(?:[\s-][A-Za-z][a-z]+){1,6})\s\(([A-Z][A-Za-z0-9-]{1,11}s?)\)/g;

function cleanName(raw: string): string | null {
  const words = raw.trim().replace(/\s+/g, " ").split(" ");
  while (words.length && NOT_A_NAME.has(words[0])) words.shift();
  const name = words.join(" ");
  if (name.length < 2 || name.length > 40 || /^\d+$/.test(name)) return null;
  if (!/[A-Z].*[A-Z0-9]|\d|^[A-Z][a-z]{3,}$/.test(name) && words.length === 1) return null; // single plain word is too vague
  if (NOT_A_NAME.has(name)) return null;
  // a single capitalised adjective ("Heterophilic datasets", "Synthetic benchmarks") describes, it doesn't name
  if (words.length === 1 && /^[A-Z][a-z]+(?:ic|al|ous|ive|ed|ing|ary|ar|ent|ant|ish)$/.test(name)) return null;
  return name;
}

function learnedCandidates(chunks: ChunkDraft[]): { type: EntityType; name: string; ord: number; evidence: string }[] {
  const out = new Map<string, { type: EntityType; name: string; ord: number; evidence: string }>();
  const add = (type: EntityType, raw: string, ord: number, evidence: string) => {
    const name = cleanName(raw);
    if (!name) return;
    const k = `${type}:${normKey(name)}`;
    if (!out.has(k)) out.set(k, { type, name, ord, evidence: evidence.slice(0, 400) });
  };
  for (const c of chunks) {
    if (c.kind === "equation") continue;
    if (/^(references|bibliography)/i.test(c.section ?? "")) continue;
    for (const s of sentences(c.content).length ? sentences(c.content) : [c.content]) {
      for (const m of s.matchAll(DATASET_BEFORE)) add("dataset", m[1], c.ord, s);
      for (const m of s.matchAll(EVAL_ON)) for (const part of m[1].split(/\s?,\s?(?:and\s)?|\sand\s/)) add("dataset", part.replace(/^the\s/, ""), c.ord, s);
      for (const m of s.matchAll(ACRONYM_DEF)) {
        const full = m[1].toLowerCase();
        const type: EntityType = /dataset|benchmark|corpus/.test(full) ? "dataset"
          : /network|model|transformer|encoder|decoder|machine/.test(full) ? "model"
          : /accuracy|score|error|rate|precision|recall|distance/.test(full) ? "metric" : "method";
        add(type, m[2].replace(/s$/, ""), c.ord, s);
      }
    }
  }
  return [...out.values()];
}

const LIMITS = { finding: 12, limitation: 8, contribution: 6 } as const;

export function extractClaims(chunks: ChunkDraft[]): ExtractedClaim[] {
  const out: ExtractedClaim[] = [];
  const count = { finding: 0, limitation: 0, contribution: 0 };
  const seen = new Set<string>();
  for (const c of chunks) {
    if (c.kind !== "text" && c.kind !== "abstract") continue;
    if (/^(related work|background|references|acknowledg)/i.test(c.section ?? "")) continue; // others' claims
    for (const s of sentences(c.content)) {
      if (s.length < 40 || s.length > 420) continue;
      const kind = isLimitation(s, c.section) ? "limitation" : FINDING.test(s) ? "finding" : CONTRIBUTION.test(s) ? "contribution" : null;
      if (!kind || count[kind] >= LIMITS[kind]) continue;
      const key = normKey(s).slice(0, 120);
      if (seen.has(key)) continue;
      seen.add(key);
      count[kind]++;
      const entityKeys = MATCHERS.filter((m) => countMentions(m, s) > 0).map((m) => `${m.type}:${normKey(m.canonical)}`);
      out.push({ kind, text: s, ord: c.ord, page: c.pageStart, polarity: kind === "finding" ? polarityOf(s) : 0, entityKeys });
    }
  }
  return out;
}
