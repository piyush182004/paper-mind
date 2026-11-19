/**
 * End-to-end test of the running app (API + ML service + sources), like a real user.
 * Usage: start the app, then from apps/api:  npx tsx scripts/e2e.ts [baseUrl] [pdfPath]
 * Creates throwaway accounts and deletes them at the end.
 */
import fs from "node:fs";

const BASE = (process.argv[2] ?? "http://127.0.0.1:8080").replace(/\/$/, "");
const PDF = process.argv[3] ?? "test/fixtures/sample.pdf";
let passed = 0;
const failures: string[] = [];

function check(name: string, ok: unknown, detail = "") {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(`${name} ${detail}`); console.log(`  ✗ ${name} ${detail}`); }
}

class Client {
  cookie = "";
  async call(path: string, opts: { method?: string; body?: unknown; csrf?: boolean; form?: FormData } = {}) {
    const method = opts.method ?? "GET";
    const headers: Record<string, string> = {};
    if (this.cookie) headers.Cookie = this.cookie;
    if (method !== "GET" && opts.csrf !== false) headers["X-PaperMind"] = "1";
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    const r = await fetch(`${BASE}/api${path}`, { method, headers, body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined) });
    const set = r.headers.get("set-cookie");
    if (set?.includes("pm_session=")) this.cookie = set.split(";")[0].includes("pm_session=;") ? "" : set.match(/pm_session=[^;]*/)![0];
    const body = await r.json().catch(() => null);
    return { status: r.status, body: body as any };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitJobs(c: Client, label: string, timeoutMs = 300_000) {
  const t0 = Date.now();
  for (;;) {
    const { body } = await c.call("/jobs");
    const open = (body?.jobs ?? []).filter((j: any) => j.status === "queued" || j.status === "running");
    if (!open.length) return body.jobs as any[];
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(2000);
  }
}

const stamp = Date.now();
const A = new Client();
const B = new Client();

async function main() {
  console.log(`E2E against ${BASE}\n`);

  console.log("System");
  const h = await A.call("/health");
  check("health ok", h.status === 200 && h.body.status === "ok");
  check("ML service reachable", h.body?.ml === "ok", `(ml=${h.body?.ml})`);
  check("UI served", (await fetch(BASE + "/")).status === 200);
  check("deep link served (/graph)", (await fetch(BASE + "/graph")).status === 200);

  console.log("\nAccounts & security");
  check("signed-out API blocked (401)", (await A.call("/papers")).status === 401);
  check("providers endpoint public", (await A.call("/auth/providers")).status === 200);
  check("short password rejected", (await A.call("/auth/register", { method: "POST", body: { name: "x", email: `a${stamp}@example.org`, password: "123" } })).status === 400);
  check("invalid email rejected", (await A.call("/auth/register", { method: "POST", body: { name: "x", email: "not-an-email", password: "longpassword" } })).status === 400);
  const ra = await A.call("/auth/register", { method: "POST", body: { name: "Alice Test", email: `a${stamp}@example.org`, password: "alice-password-1" } });
  check("register A", ra.status === 200 && A.cookie, JSON.stringify(ra.body));
  check("register B", (await B.call("/auth/register", { method: "POST", body: { name: "Bob Test", email: `b${stamp}@example.org`, password: "bob-password-1" } })).status === 200);
  check("duplicate email rejected (409)", (await new Client().call("/auth/register", { method: "POST", body: { name: "x", email: `a${stamp}@example.org`, password: "whatever-123" } })).status === 409);
  check("wrong password rejected (401)", (await new Client().call("/auth/login", { method: "POST", body: { email: `a${stamp}@example.org`, password: "wrong-password" } })).status === 401);
  check("me returns user", (await A.call("/auth/me")).body?.user?.name === "Alice Test");
  check("write without CSRF header blocked (403)", (await A.call("/search", { method: "POST", body: { query: "test query" }, csrf: false })).status === 403);
  check("new account starts empty", (await B.call("/papers")).body?.total === 0);

  console.log("\nValidation");
  check("too-short discover query → 400", (await A.call("/discover?q=a")).status === 400);
  check("too-short search query → 400", (await A.call("/search", { method: "POST", body: { query: "a" } })).status === 400);
  check("unknown paper → 404", (await A.call("/papers/99999999")).status === 404);
  check("unknown API path → 404", (await A.call("/does-not-exist")).status === 404);

  console.log("\nDiscover & import");
  const d = await A.call(`/discover?q=${encodeURIComponent("graph neural network node classification")}&sources=arxiv,openalex&limit=8`);
  const results: any[] = d.body?.results ?? [];
  check("discovery returns papers", d.status === 200 && results.length >= 4, `(${results.length} results, errors=${JSON.stringify(d.body?.errors)})`);
  const picks = results.slice(0, 4);
  const imp = await A.call("/papers/import", { method: "POST", body: { papers: picks, fulltext: false } });
  check("import 4 papers", imp.status === 200 && imp.body.imported.length === 4, JSON.stringify(imp.body).slice(0, 200));
  await waitJobs(A, "ingestion + topics");
  const lib = await A.call("/papers?limit=100");
  check("library has 4 papers", lib.body.total === 4, `(total=${lib.body.total})`);
  check("all papers indexed", lib.body.papers.every((p: any) => p.status === "ready" || p.status === "metadata_only"),
    JSON.stringify(lib.body.papers.map((p: any) => `${p.status}:${p.status_detail}`)));
  check("papers have chunks", lib.body.papers.every((p: any) => p.chunks > 0));
  const disc2 = await A.call(`/discover?q=${encodeURIComponent("graph neural network node classification")}&sources=arxiv,openalex&limit=8`);
  check("discover marks imported papers as in library", (disc2.body?.results ?? []).filter((p: any) => p.libraryId).length >= 1);

  console.log("\nUpload (private PDF)");
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(PDF)], { type: "application/pdf" }), "hypernet-paper.pdf");
  const up = await A.call("/papers/upload", { method: "POST", form });
  const upId = up.body?.uploaded?.[0]?.paperId;
  check("PDF upload accepted", up.status === 200 && upId, JSON.stringify(up.body));
  const notPdf = new FormData();
  notPdf.append("file", new Blob(["hello"], { type: "application/pdf" }), "fake.pdf");
  check("non-PDF rejected", (await A.call("/papers/upload", { method: "POST", form: notPdf })).body?.uploaded?.[0]?.error === "not a PDF");
  await waitJobs(A, "upload ingestion");
  const upd = await A.call(`/papers/${upId}`);
  check("upload parsed with full text", upd.body?.paper?.status === "ready" && upd.body.paper.has_fulltext, `(status=${upd.body?.paper?.status} ${upd.body?.paper?.status_detail ?? ""})`);
  const ents = (upd.body?.entities ?? []).map((e: any) => `${e.type}:${e.name}`);
  check("datasets learned from text (Cora/CiteSeer/PubMed)", ["dataset:Cora", "dataset:CiteSeer", "dataset:PubMed"].every((x) => ents.includes(x)), JSON.stringify(ents));
  check("new method learned from text (HyperNet)", ents.some((e: string) => /HyperNet|HN/.test(e)), JSON.stringify(ents));
  check("claims extracted with pages", (upd.body?.claims ?? []).some((c: any) => c.kind === "finding" && c.page) && (upd.body?.claims ?? []).some((c: any) => c.kind === "limitation"));
  check("other user cannot open private upload (404)", (await B.call(`/papers/${upId}`)).status === 404);

  console.log("\nSearch & AI assistant");
  const s = await A.call("/search", { method: "POST", body: { query: "how do graph neural networks classify nodes", options: { k: 5 } } });
  check("search returns cited passages", s.status === 200 && s.body.hits.length > 0 && s.body.hits.every((h: any) => h.paperId && h.kind && h.scores?.final != null), `(${s.body?.hits?.length} hits, degraded=${s.body?.degraded})`);
  check("search not degraded", (s.body?.degraded ?? []).length === 0, JSON.stringify(s.body?.degraded));
  check("other user's search sees nothing of A", (await B.call("/search", { method: "POST", body: { query: "how do graph neural networks classify nodes" } })).body?.hits?.length === 0);
  const fs1 = await A.call("/search", { method: "POST", body: { query: "HyperNet memory cost on large graphs", filters: { kinds: ["text"] }, options: { k: 3 } } });
  check("filtered search finds uploaded paper", fs1.body?.hits?.some((h: any) => h.paperId === upId));
  const qa = await A.call("/assistant", { method: "POST", body: { mode: "qa", question: "What datasets is HyperNet evaluated on?" } });
  check("assistant answers with sources", qa.status === 200 && qa.body.sources.length > 0 && qa.body.answer.length > 20, JSON.stringify(qa.body).slice(0, 200));
  check("assistant cites only real sources", qa.body?.grounding?.invalidCitationsRemoved?.length === 0);
  const sm = await A.call("/assistant", { method: "POST", body: { mode: "summarize", paperIds: [upId] } });
  check("summarize a paper", sm.status === 200 && sm.body.sources.length > 0);
  const cmpA = await A.call("/assistant", { method: "POST", body: { mode: "compare", paperIds: [lib.body.papers[0].id, upId] } });
  check("AI compare mode", cmpA.status === 200 && cmpA.body.sources.length > 0);
  check("assistant on empty library is honest", /No relevant evidence/.test((await B.call("/assistant", { method: "POST", body: { mode: "qa", question: "what is a graph neural network?" } })).body?.answer ?? ""));
  check("assistant refuses other user's paper", (await B.call("/assistant", { method: "POST", body: { mode: "summarize", paperIds: [upId] } })).body?.sources?.length === 0);

  console.log("\nTopics, connections, analytics, insights");
  await A.call("/clusters/run", { method: "POST", body: {} });
  await waitJobs(A, "topics");
  const cl = await A.call("/clusters");
  check("topics built (5 papers)", cl.body?.run && cl.body.points.length === 5 && cl.body.clusters.length >= 1, `(points=${cl.body?.points?.length}, topics=${cl.body?.clusters?.length})`);
  check("topic sizes match members", (cl.body?.clusters ?? []).reduce((s: number, c: any) => s + c.size, 0) + (cl.body?.run?.n_noise ?? 0) === cl.body?.points?.length);
  const g = await A.call("/graph?limit=100");
  check("connections map has papers & entities", g.body?.nodes?.some((n: any) => n.type === "paper") && g.body.nodes.some((n: any) => n.type !== "paper") && g.body.metricsComputed);
  check("map node details", (await A.call(`/graph/node/paper:${upId}`)).status === 200);
  check("other user's map empty", (await B.call("/graph")).body?.nodes?.length === 0);
  const ov = await A.call("/analytics/overview");
  check("stats overview counts 5 papers", ov.body?.papers === 5, `(papers=${ov.body?.papers})`);
  const ps = await A.call("/analytics/papers");
  check("paper scores 0..1 with components", ps.body?.papers?.length === 5 && ps.body.papers.every((p: any) => p.composite >= 0 && p.composite <= 1));
  check("insights: gaps", (await A.call("/intelligence/gaps")).status === 200);
  check("insights: trends", (await A.call("/intelligence/trends")).status === 200);
  check("insights: contradictions", (await A.call("/intelligence/contradictions")).status === 200);
  const cmp = await A.call("/intelligence/compare", { method: "POST", body: { paperIds: [lib.body.papers[0].id, upId] } });
  check("compare table", cmp.status === 200 && cmp.body.papers.length === 2 && Array.isArray(cmp.body.papers[0].topics) && cmp.body.similarity.length === 2);
  check("compare ignores papers you don't own", (await B.call("/intelligence/compare", { method: "POST", body: { paperIds: [lib.body.papers[0].id, upId] } })).body?.papers?.length === 0);

  console.log("\nSharing & removal");
  const reuse = await B.call("/papers/import", { method: "POST", body: { papers: [picks[0]], fulltext: false } });
  check("already-read public paper is reused instantly", reuse.body?.imported?.[0]?.reused === true, JSON.stringify(reuse.body));
  const rm = await A.call(`/papers/${lib.body.papers[0].id}`, { method: "DELETE" });
  check("remove paper", rm.status === 200);
  check("removed paper gone from library", (await A.call("/papers")).body.total === 4);
  check("other user keeps shared paper", (await B.call("/papers")).body.total === 1);
  for (const p of lib.body.papers.slice(1, 3)) await A.call(`/papers/${p.id}`, { method: "DELETE" });
  await waitJobs(A, "refresh after removal");
  const cl2 = await A.call("/clusters");
  check("topics refreshed after removal (2 papers → none)", !cl2.body?.run, JSON.stringify(cl2.body?.run));
  check("reingest own paper", (await A.call(`/papers/${upId}/reingest`, { method: "POST" })).status === 200);
  check("cannot reingest others' paper", (await B.call(`/papers/${upId}/reingest`, { method: "POST" })).status === 404);
  check("jobs list only own jobs", (await B.call("/jobs")).body.jobs.every((j: any) => j.user_id == null || Number(j.user_id) !== Number((A as any).id)));
  await waitJobs(A, "reingest");

  console.log("\nSign out & cleanup");
  check("logout", (await A.call("/auth/logout", { method: "POST", body: {} })).status === 200);
  check("signed out → 401", (await A.call("/papers")).status === 401);
  check("login again", (await A.call("/auth/login", { method: "POST", body: { email: `a${stamp}@example.org`, password: "alice-password-1" } })).status === 200);
  check("delete account A", (await A.call("/auth/account", { method: "DELETE" })).status === 200);
  check("deleted account can't log in", (await new Client().call("/auth/login", { method: "POST", body: { email: `a${stamp}@example.org`, password: "alice-password-1" } })).status === 401);
  check("delete account B", (await B.call("/auth/account", { method: "DELETE" })).status === 200);

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) { console.log("FAILURES:\n- " + failures.join("\n- ")); process.exit(1); }
}

main().catch(async (e) => {
  console.error("E2E crashed:", e);
  await A.call("/auth/account", { method: "DELETE" }).catch(() => {});
  await B.call("/auth/account", { method: "DELETE" }).catch(() => {});
  process.exit(1);
});
