/** AI assistant endpoints (stricter rate limit: every call may spend LLM tokens). */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { assist } from "../llm/assistant.js";
import { usageSummary } from "../llm/openrouter.js";
import { userId } from "../auth.js";

export const assistantRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;

  app.post("/assistant", { config: { rateLimit: { max: config.CHAT_RATE_LIMIT_PER_MIN, timeWindow: "1 minute" } } }, async (req) => {
    const b = z.object({
      mode: z.enum(["qa", "explain", "summarize", "compare", "review"]).default("qa"),
      question: z.string().trim().max(2000).optional(),
      paperIds: z.array(z.number().int()).max(12).optional(),
      clusterId: z.number().int().optional(),
      history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(6000) })).max(12).optional(),
    }).parse(req.body);
    return assist(db, userId(req), b);
  });

  app.get("/llm/usage", async (req) => usageSummary(db, userId(req)));
};
