/**
 * AI research assistant. The LLM is only the *interface*: evidence comes from the platform
 * (hybrid retrieval, claims, comparisons, clusters); the model phrases an answer that must cite it.
 * Without an LLM (no key, budget exhausted, provider down) every mode returns an extractive answer.
 */
import { config } from "../config.js";
import type { Db } from "../db/client.js";
import { comparePapers } from "../analysis/intelligence.js";
import { paperScores } from "../analysis/metrics.js";
import { hybridSearch } from "../search/hybrid.js";
import { clip } from "../lib/text.js";
import { chat, type ChatMessage, LlmBudgetError, LlmUnavailableError } from "./openrouter.js";
import { sanitizeSource, SYSTEM_PROMPT, validateCitations } from "./guard.js";

export type Mode = "qa" | "explain" | "summarize" | "compare" | "review";

export interface AssistRequest {
  mode: Mode;
  question?: string;
  paperIds?: number[];
  clusterId?: number;
  history?: ChatMessage[];
}

export interface Source {
  sid: number;
  paperId: number;
  title: string;
  year: number | null;
  page: number | null;
  section: string | null;
  kind: string;          // chunk kind or claim kind
  chunkId?: number;
  claimId?: number;
  text: string;
  via?: "retrieval" | "graph";
}

export interface AssistResponse {
  mode: Mode;
  answer: string;
  generatedBy: "llm" | "extractive";
  model: string | null;
  sources: Source[];
  grounding: { coverage: number; cited: number[]; invalidCitationsRemoved: number[]; injectionFlags: number; notice?: string };
  usage?: { prompt: number; completion: number; cached: boolean };
}

const TASKS: Record<Mode, string> = {
  qa: "Answer the question using the sources. If they disagree, say so and cite both sides.",
  explain: "Explain this paper to a graduate student: problem, key idea, method, evidence, limitations. Cite sources.",
  summarize: "Write a structured summary (Problem, Approach, Results, Limitations) of the paper. Cite sources.",
  compare: "Compare the papers: goals, methods, datasets, results and limitations. Use a short table if helpful, then the key differences. Cite sources.",
  review: "Write a concise literature review of these papers: organise by theme, contrast approaches, note agreements/disagreements and open problems. Cite sources for every claim.",
};

// ------------------------------------------------------------------------------------- evidence
async function claimSources(db: Db, userId: number, paperIds: number[], perPaper: number): Promise<Omit<Source, "sid">[]> {
  const { rows } = await db.query<{ id: number; paper_id: number; title: string; year: number | null; page: number | null; kind: string; text: string; chunk_id: number | null }>(
    `SELECT * FROM (
       SELECT c.id, c.paper_id, p.title, p.year, c.page, c.kind, c.text, c.chunk_id,
              row_number() OVER (PARTITION BY c.paper_id, c.kind ORDER BY c.id) AS rn
       FROM claims c JOIN papers p ON p.id = c.paper_id WHERE c.paper_id = ANY($1::bigint[]) AND c.paper_id IN (SELECT paper_id FROM library WHERE user_id = $3)) x
     WHERE rn <= $2 ORDER BY paper_id, kind`,
    [paperIds, perPaper, userId],
  );
  return rows.map((r) => ({
    paperId: Number(r.paper_id), title: r.title, year: r.year, page: r.page, section: null, kind: r.kind,
    claimId: Number(r.id), chunkId: r.chunk_id ? Number(r.chunk_id) : undefined, text: r.text,
  }));
}

async function gather(db: Db, userId: number, req: AssistRequest): Promise<Omit<Source, "sid">[]> {
  const q = req.question?.trim() || "";
  const fromSearch = async (query: string, filters: Parameters<typeof hybridSearch>[2], k: number, graph = false) =>
    (await hybridSearch(db, query, { ...filters, userId }, { k, graph, context: false, maxPerPaper: 3 })).hits.map((h) => ({
      paperId: h.paperId, title: h.title, year: h.year, page: h.pageStart, section: h.section, kind: h.kind,
      chunkId: h.chunkId, text: h.content, via: h.via,
    }));

  switch (req.mode) {
    case "qa":
      if (!q) throw Object.assign(new Error("A question is required."), { status: 400 });
      return fromSearch(q, { paperIds: req.paperIds, clusterId: req.clusterId }, 8, true);
    case "explain":
    case "summarize": {
      const id = req.paperIds?.[0];
      if (!id) throw Object.assign(new Error("Select a paper."), { status: 400 });
      const chunks = await fromSearch(q || "problem motivation proposed method approach experiments results conclusion limitations", { paperIds: [id] }, 8);
      return [...chunks, ...(await claimSources(db, userId, [id], 3))];
    }
    case "compare": {
      const ids = (req.paperIds ?? []).slice(0, 5);
      if (ids.length < 2) throw Object.assign(new Error("Select at least two papers to compare."), { status: 400 });
      const per = await Promise.all(ids.map((id) => fromSearch(q || "method approach results datasets", { paperIds: [id] }, 2)));
      return [...per.flat(), ...(await claimSources(db, userId, ids, 2))];
    }
    case "review": {
      const ids = req.paperIds?.length
        ? req.paperIds.slice(0, 12)
        : (await paperScores(db, userId, { clusterId: req.clusterId, limit: 10 })).map((p) => p.id);
      if (!ids.length) throw Object.assign(new Error("No papers to review: select papers or a cluster."), { status: 400 });
      const { rows } = await db.query<{ id: number; paper_id: number; title: string; year: number | null; content: string }>(
        `SELECT c.id, c.paper_id, p.title, p.year, c.content FROM chunks c JOIN papers p ON p.id = c.paper_id
         WHERE c.paper_id = ANY($1::bigint[]) AND c.kind = 'abstract' AND c.paper_id IN (SELECT paper_id FROM library WHERE user_id = $2)`, [ids, userId]);
      const abstracts = rows.map((r) => ({ paperId: Number(r.paper_id), title: r.title, year: r.year, page: 1, section: "Abstract", kind: "abstract", chunkId: Number(r.id), text: r.content }));
      return [...abstracts, ...(await claimSources(db, userId, ids, 2))];
    }
  }
}

// ------------------------------------------------------------------------------------- answer
function extractive(mode: Mode, sources: Source[], notice: string): string {
  const cite = (s: Source) => `[S${s.sid}]`;
  const page = (s: Source) => (s.page ? ` (p. ${s.page})` : "");
  if (mode === "qa") {
    const top = sources.filter((s) => s.via !== "graph").slice(0, 4);
    if (!top.length) return "No relevant passages were found in your library for this question.";
    return [`${notice} The most relevant passages from your library:`, ...top.map((s) => `- **${clip(s.title, 80)}**${page(s)}: ${clip(s.text, 320)} ${cite(s)}`)].join("\n");
  }
  const byKind = (k: string) => sources.filter((s) => s.kind === k);
  const section = (label: string, list: Source[]) => (list.length ? [`**${label}**`, ...list.slice(0, 6).map((s) => `- ${clip(s.text, 260)} — *${clip(s.title, 60)}*${page(s)} ${cite(s)}`)] : []);
  return [
    notice + " Structured evidence extracted from the papers:",
    ...section("Contributions", byKind("contribution")),
    ...section("Findings", byKind("finding")),
    ...section("Limitations", byKind("limitation")),
    ...(byKind("abstract").length ? section("Abstracts", byKind("abstract")) : []),
  ].join("\n");
}

export async function assist(db: Db, userId: number, req: AssistRequest): Promise<AssistResponse> {
  const raw = await gather(db, userId, req);
  // de-duplicate and number the sources, sanitising untrusted text
  const seen = new Set<string>();
  let flags = 0;
  const sources: Source[] = [];
  let budget = config.LLM_MAX_CONTEXT_CHARS;
  for (const s of raw) {
    const key = s.claimId ? `claim:${s.claimId}` : `chunk:${s.chunkId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { text, flagged } = sanitizeSource(s.text, s.kind === "abstract" ? 1600 : 1200);
    if (flagged) flags++;
    if (budget - text.length < 0) break;
    budget -= text.length;
    sources.push({ ...s, text, sid: sources.length + 1 });
  }

  const sourceBlock = sources
    .map((s) => `<source id="S${s.sid}" paper="${s.title.replace(/"/g, "'")}" year="${s.year ?? "n/a"}" page="${s.page ?? "n/a"}" type="${s.kind}">\n${s.text}\n</source>`)
    .join("\n");
  const history = (req.history ?? []).slice(-6).map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: clip(m.content, 1500) }) as ChatMessage);
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    { role: "user", content: `SOURCES:\n${sourceBlock || "(no sources found)"}\n\nTASK: ${TASKS[req.mode]}${req.question ? `\nQUESTION: ${req.question}` : ""}` },
  ];

  if (!sources.length) {
    return { mode: req.mode, answer: "No relevant evidence was found in your library.", generatedBy: "extractive", model: null, sources,
      grounding: { coverage: 0, cited: [], invalidCitationsRemoved: [], injectionFlags: flags } };
  }

  try {
    const r = await chat(db, messages, { route: `assistant:${req.mode}`, userId, maxTokens: req.mode === "review" ? config.LLM_MAX_OUTPUT_TOKENS : 900 });
    const check = validateCitations(r.text, sources.length);
    const notice = check.coverage < 0.5
      ? "Low citation coverage: parts of this answer are not tied to a source. Verify against the cited passages."
      : undefined;
    return {
      mode: req.mode, answer: check.text, generatedBy: "llm", model: r.model, sources,
      grounding: { coverage: check.coverage, cited: check.cited, invalidCitationsRemoved: check.invalidRemoved, injectionFlags: flags, notice },
      usage: { ...r.usage, cached: r.cached },
    };
  } catch (e) {
    if (!(e instanceof LlmUnavailableError || e instanceof LlmBudgetError)) throw e;
    const notice = e instanceof LlmBudgetError ? "The daily AI budget is used up." : "The AI model is unavailable right now.";
    return {
      mode: req.mode, answer: extractive(req.mode, sources, notice), generatedBy: "extractive", model: null, sources,
      grounding: { coverage: 1, cited: sources.map((s) => s.sid), invalidCitationsRemoved: [], injectionFlags: flags, notice: (e as Error).message },
    };
  }
}
