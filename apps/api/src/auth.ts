/**
 * Accounts and sessions.
 *  - passwords: scrypt (memory-hard, Node built-in) with a per-user random salt, constant-time compare
 *  - sessions: random 256-bit token in an httpOnly SameSite=Lax cookie; only its SHA-256 is stored
 *  - CSRF: state-changing requests must carry the custom header X-PaperMind (browsers can't add it cross-site)
 */
import crypto from "node:crypto";
import { promisify } from "node:util";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "./config.js";
import type { Db } from "./db/client.js";

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number, opts: crypto.ScryptOptions) => Promise<Buffer>;
const COOKIE = "pm_session";
const SESSION_DAYS = 30;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export interface User { id: number; name: string; email: string; avatarUrl: string | null }

declare module "fastify" {
  interface FastifyRequest {
    user: User | null;
  }
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pw, salt, 64, SCRYPT);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [, saltB64, hashB64] = stored.split("$");
  if (!saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(pw, Buffer.from(saltB64, "base64"), expected.length, SCRYPT);
  return crypto.timingSafeEqual(actual, expected);
}

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

function readCookie(req: FastifyRequest, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

function setSessionCookie(reply: FastifyReply, token: string | null) {
  const secure = config.NODE_ENV === "production" ? "; Secure" : "";
  addCookie(reply, token
    ? `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`
    : `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

async function createSession(db: Db, userId: number, reply: FastifyReply) {
  const token = crypto.randomBytes(32).toString("base64url");
  await db.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))",
    [sha256(token), userId, SESSION_DAYS]);
  setSessionCookie(reply, token);
}

/** Resolve the session for every request; protect /api/* except public routes. */
export function authHook(db: Db) {
  const PUBLIC = [/^\/api\/auth\//, /^\/api\/health$/];
  return async (req: FastifyRequest, reply: FastifyReply) => {
    req.user = null;
    const token = readCookie(req, COOKIE);
    if (token) {
      const { rows } = await db.query<{ id: number; name: string; email: string; avatar_url: string | null }>(
        `SELECT u.id, u.name, u.email, u.avatar_url FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > now()`, [sha256(token)]);
      if (rows[0]) req.user = { id: Number(rows[0].id), name: rows[0].name, email: rows[0].email, avatarUrl: rows[0].avatar_url };
    }
    if (!req.url.startsWith("/api/") || PUBLIC.some((re) => re.test(req.url.split("?")[0]))) return;
    if (!req.user) return reply.status(401).send({ error: "Please sign in." });
    if (req.method !== "GET" && req.method !== "HEAD" && req.headers["x-papermind"] !== "1")
      return reply.status(403).send({ error: "Missing CSRF header." });
  };
}

export const userId = (req: FastifyRequest): number => {
  if (!req.user) throw Object.assign(new Error("Please sign in."), { status: 401 });
  return req.user.id;
};

const Credentials = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
});

export const authRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  const limited = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }; // slows down password guessing

  /** The very first account adopts papers indexed before accounts existed. */
  const adoptIfFirst = async (id: number) => {
    const { rows: count } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM users");
    if (Number(count[0].n) === 1) {
      await db.query("INSERT INTO library (user_id, paper_id) SELECT $1, id FROM papers ON CONFLICT DO NOTHING", [id]);
      await app.jobs.scheduleRefresh(id);
    }
  };

  app.post("/auth/register", limited, async (req, reply) => {
    const b = Credentials.extend({ name: z.string().trim().min(1).max(80) }).parse(req.body);
    const exists = await db.query("SELECT 1 FROM users WHERE email = $1", [b.email]);
    if (exists.rows.length) return reply.status(409).send({ error: "An account with this email already exists." });
    const { rows } = await db.query<{ id: number }>(
      "INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id", [b.email, b.name, await hashPassword(b.password)]);
    const id = Number(rows[0].id);
    await adoptIfFirst(id);
    await createSession(db, id, reply);
    return { user: { id, name: b.name, email: b.email, avatarUrl: null } };
  });

  app.post("/auth/login", limited, async (req, reply) => {
    const b = Credentials.parse(req.body);
    const { rows } = await db.query<{ id: number; name: string; email: string; password_hash: string | null; avatar_url: string | null }>(
      "SELECT id, name, email, password_hash, avatar_url FROM users WHERE email = $1", [b.email]);
    const u = rows[0];
    if (u && !u.password_hash) return reply.status(401).send({ error: "This account uses Google sign-in. Use “Continue with Google”." });
    // same work and same message whether or not the email exists (no account enumeration)
    const ok = u?.password_hash ? await verifyPassword(b.password, u.password_hash) : (await hashPassword(b.password), false);
    if (!u || !ok) return reply.status(401).send({ error: "Wrong email or password." });
    await createSession(db, Number(u.id), reply);
    return { user: { id: Number(u.id), name: u.name, email: u.email, avatarUrl: u.avatar_url } };
  });

  app.post("/auth/logout", async (req, reply) => {
    const token = readCookie(req, COOKIE);
    if (token) await db.query("DELETE FROM sessions WHERE token_hash = $1", [sha256(token)]);
    setSessionCookie(reply, null);
    return { ok: true };
  });

  app.get("/auth/me", async (req) => ({ user: req.user }));

  /** Delete my account: library, uploads (owned papers), topics, jobs and sessions go with it. */
  app.delete("/auth/account", async (req, reply) => {
    if (!req.user) return reply.status(401).send({ error: "Please sign in." });
    if (req.headers["x-papermind"] !== "1") return reply.status(403).send({ error: "Missing CSRF header." });
    const id = req.user.id;
    await db.query("DELETE FROM jobs WHERE user_id = $1", [id]);
    await db.query("DELETE FROM llm_usage WHERE user_id = $1", [id]);
    await db.query("DELETE FROM graph_metrics WHERE user_id = $1", [id]);
    await db.query("DELETE FROM users WHERE id = $1", [id]); // cascades: sessions, library, private uploads, topic runs
    await db.query("DELETE FROM papers p WHERE p.owner_id IS NULL AND NOT EXISTS (SELECT 1 FROM library l WHERE l.paper_id = p.id)");
    setSessionCookie(reply, null);
    return { deleted: true };
  });

  app.get("/auth/providers", async () => ({ google: googleEnabled(), password: true }));

  // ---------------------------------------------------------------- Sign in with Google (OAuth 2.0 + PKCE)
  const redirectUri = () => `${config.PUBLIC_URL.replace(/\/$/, "")}/api/auth/google/callback`;
  const fail = (reply: FastifyReply, msg: string) => reply.redirect(`/?auth_error=${encodeURIComponent(msg)}`);

  app.get("/auth/google/start", limited, async (_req, reply) => {
    if (!googleEnabled()) return fail(reply, "Google sign-in is not configured on this server.");
    const state = crypto.randomBytes(24).toString("base64url");
    const verifier = crypto.randomBytes(48).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    addCookie(reply, `${OAUTH_COOKIE}=${state}.${verifier}; Path=/api/auth/google; HttpOnly; SameSite=Lax; Max-Age=600${secureFlag()}`);
    const p = new URLSearchParams({
      client_id: config.GOOGLE_CLIENT_ID!, redirect_uri: redirectUri(), response_type: "code", scope: "openid email profile",
      state, code_challenge: challenge, code_challenge_method: "S256", prompt: "select_account",
    });
    return reply.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${p}`);
  });

  app.get("/auth/google/callback", async (req, reply) => {
    const q = z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }).parse(req.query);
    const [state, verifier] = (readCookie(req, OAUTH_COOKIE) ?? "").split(".");
    addCookie(reply, `${OAUTH_COOKIE}=; Path=/api/auth/google; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag()}`);
    if (q.error) return fail(reply, "Google sign-in was cancelled.");
    // state ties the callback to the browser that started the flow (CSRF / login-fixation protection)
    if (!q.code || !q.state || !state || !verifier || !safeEqual(q.state, state)) return fail(reply, "Sign-in expired. Please try again.");
    try {
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code: q.code, client_id: config.GOOGLE_CLIENT_ID!, client_secret: config.GOOGLE_CLIENT_SECRET!,
          redirect_uri: redirectUri(), grant_type: "authorization_code", code_verifier: verifier,
        }),
      });
      const tok = (await tokenRes.json()) as { access_token?: string };
      if (!tokenRes.ok || !tok.access_token) return fail(reply, "Google sign-in failed. Please try again.");
      // server-to-server over TLS with the token we just received: the profile is authentic
      const infoRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${tok.access_token}` } });
      const info = (await infoRes.json()) as { sub?: string; email?: string; email_verified?: boolean; name?: string; picture?: string };
      if (!info.sub || !info.email || !info.email_verified) return fail(reply, "Your Google email must be verified.");
      const email = info.email.toLowerCase();

      // existing Google link, else link to an existing account with the same (Google-verified) email, else create
      let { rows } = await db.query<{ id: number }>("SELECT id FROM users WHERE google_sub = $1", [info.sub]);
      if (!rows[0]) {
        ({ rows } = await db.query<{ id: number }>(
          "UPDATE users SET google_sub = $1, avatar_url = COALESCE(avatar_url, $3) WHERE email = $2 RETURNING id", [info.sub, email, info.picture ?? null]));
      }
      let id = rows[0] ? Number(rows[0].id) : null;
      if (!id) {
        const created = await db.query<{ id: number }>(
          "INSERT INTO users (email, name, google_sub, avatar_url) VALUES ($1, $2, $3, $4) RETURNING id",
          [email, (info.name ?? email.split("@")[0]).slice(0, 80), info.sub, info.picture ?? null]);
        id = Number(created.rows[0].id);
        await adoptIfFirst(id);
      }
      await createSession(db, id, reply);
      return reply.redirect("/");
    } catch (e) {
      req.log.warn({ err: (e as Error).message }, "google sign-in failed");
      return fail(reply, "Could not reach Google. Please try again.");
    }
  });
};

const OAUTH_COOKIE = "pm_oauth";
const googleEnabled = () => Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET);
const secureFlag = () => (config.NODE_ENV === "production" ? "; Secure" : "");
const safeEqual = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Append a Set-Cookie header (several cookies can be set in one response). */
function addCookie(reply: FastifyReply, cookie: string) {
  const prev = reply.getHeader("set-cookie");
  const list = prev == null ? [] : Array.isArray(prev) ? prev.map(String) : [String(prev)];
  reply.header("set-cookie", [...list, cookie]);
}
