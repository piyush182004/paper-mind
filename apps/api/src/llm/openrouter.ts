/**
 * OpenRouter gateway. The key lives only in the backend environment and is never sent to clients,
 * logged, or included in prompts. Daily token budget, response cache, retries and usage tracking.
 */
import crypto from "node:crypto";
import { config } from "../config.js";
import type { Db } from "../db/client.js";
import { estimateTokens } from "../lib/text.js";
import { sleep } from "../lib/http.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmResult {
  text: string;
  model: string;
  usage: { prompt: number; completion: number };
  cached: boolean;
}

export class LlmUnavailableError extends Error {
  readonly status = 503;
}
export class LlmBudgetError extends Error {
  readonly status = 429;
}

export async function tokensUsedToday(db: Db, userId?: number): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT coalesce(sum(prompt_tokens + completion_tokens), 0)::int AS n FROM llm_usage
     WHERE NOT cached AND created_at > now() - interval '1 day' ${userId ? "AND user_id = $1" : ""}`,
    userId ? [userId] : [],
  );
  return Number(rows[0].n);
}

async function record(db: Db, route: string, userId: number | undefined, model: string, usage: LlmResult["usage"], cached: boolean, ok: boolean) {
  await db.query(
    "INSERT INTO llm_usage (model, route, user_id, prompt_tokens, completion_tokens, cached, ok) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [model, route, userId ?? null, usage.prompt, usage.completion, cached, ok],
  ).catch(() => undefined);
}

export async function chat(db: Db, messages: ChatMessage[], opts: { route: string; userId?: number; maxTokens?: number; temperature?: number }): Promise<LlmResult> {
  if (!config.OPENROUTER_API_KEY) throw new LlmUnavailableError("No LLM configured (set OPENROUTER_API_KEY on the server).");
  const model = config.OPENROUTER_MODEL;
  const maxTokens = Math.min(opts.maxTokens ?? config.LLM_MAX_OUTPUT_TOKENS, config.LLM_MAX_OUTPUT_TOKENS);
  const temperature = opts.temperature ?? 0.2;

  const key = crypto.createHash("sha256").update(JSON.stringify({ model, maxTokens, temperature, messages })).digest("hex");
  const hit = await db.query<{ response: LlmResult }>("SELECT response FROM llm_cache WHERE key = $1 AND created_at > now() - interval '7 days'", [key]);
  if (hit.rows[0]) {
    await record(db, opts.route, opts.userId, model, { prompt: 0, completion: 0 }, true, true);
    return { ...hit.rows[0].response, cached: true };
  }

  const estimate = messages.reduce((s, m) => s + estimateTokens(m.content), 0) + maxTokens;
  const used = await tokensUsedToday(db);
  if (used + estimate > config.LLM_DAILY_TOKEN_BUDGET)
    throw new LlmBudgetError("The service's daily AI budget is used up. Try again tomorrow.");
  if (opts.userId) {
    const mine = await tokensUsedToday(db, opts.userId);
    if (mine + estimate > config.LLM_USER_DAILY_TOKEN_BUDGET)
      throw new LlmBudgetError(`You've used your daily AI allowance (${mine.toLocaleString()} / ${config.LLM_USER_DAILY_TOKEN_BUDGET.toLocaleString()} tokens).`);
  }

  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), config.LLM_TIMEOUT_MS);
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": config.PUBLIC_URL,
          "X-Title": "PaperMind",
        },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        choices?: { message?: { content?: string | null } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        error?: { message?: string };
      };
      if (res.status === 429 || res.status >= 500) {
        lastErr = body.error?.message ?? `provider returned ${res.status}`;
        const ra = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 8) * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw new LlmUnavailableError(body.error?.message ?? `LLM provider returned ${res.status}`);
      const text = (body.choices?.[0]?.message?.content ?? "").trim();
      if (!text) throw new LlmUnavailableError("The model returned an empty answer.");
      const result: LlmResult = {
        text, model, cached: false,
        usage: { prompt: body.usage?.prompt_tokens ?? estimateTokens(JSON.stringify(messages)), completion: body.usage?.completion_tokens ?? estimateTokens(text) },
      };
      await record(db, opts.route, opts.userId, model, result.usage, false, true);
      await db.query("INSERT INTO llm_cache (key, response) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET response = EXCLUDED.response, created_at = now()",
        [key, JSON.stringify(result)]).catch(() => undefined);
      return result;
    } catch (e) {
      if (e instanceof LlmUnavailableError) {
        await record(db, opts.route, opts.userId, model, { prompt: 0, completion: 0 }, false, false);
        throw e;
      }
      lastErr = (e as Error).name === "AbortError" ? "LLM request timed out" : (e as Error).message;
      if (attempt < 2) await sleep(800 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  await record(db, opts.route, opts.userId, model, { prompt: 0, completion: 0 }, false, false);
  throw new LlmUnavailableError(`LLM unavailable: ${lastErr}`);
}

export async function usageSummary(db: Db, userId: number) {
  const { rows } = await db.query<{ route: string; calls: number; cached: number; failed: number; tokens: number }>(
    `SELECT route, count(*)::int AS calls, sum(CASE WHEN cached THEN 1 ELSE 0 END)::int AS cached,
       sum(CASE WHEN ok THEN 0 ELSE 1 END)::int AS failed, sum(prompt_tokens + completion_tokens)::int AS tokens
     FROM llm_usage WHERE created_at > now() - interval '1 day' AND user_id = $1 GROUP BY route ORDER BY calls DESC`,
    [userId],
  );
  return {
    configured: Boolean(config.OPENROUTER_API_KEY),
    model: config.OPENROUTER_MODEL,
    budget: config.LLM_USER_DAILY_TOKEN_BUDGET,
    usedToday: await tokensUsedToday(db, userId),
    byRoute: rows,
  };
}
