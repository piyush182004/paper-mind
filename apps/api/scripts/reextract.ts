/** Re-run entity & claim extraction on every stored paper (no downloads). Usage: npx tsx scripts/reextract.ts */
import { closeDb, getDb } from "../src/db/client.js";
import { migrate } from "../src/db/migrations.js";
import { reextractPaper } from "../src/ingest/pipeline.js";

const db = await getDb();
await migrate(db);
await db.query("DELETE FROM users WHERE email LIKE '%@example.org'");
const { rows } = await db.query<{ id: number; title: string }>("SELECT id, title FROM papers WHERE status IN ('ready','metadata_only') ORDER BY id");
for (const p of rows) {
  const r = await reextractPaper(db, Number(p.id));
  console.log(`#${p.id} ${p.title.slice(0, 50).padEnd(50)} entities=${r.entities} claims=${r.claims}`);
}
// refresh topics + connections for every account
await db.query(`INSERT INTO jobs (kind, payload, user_id) SELECT 'cluster', jsonb_build_object('userId', id, 'algorithm', 'hdbscan'), id FROM users`);
const { rows: ds } = await db.query<{ name: string; papers: number }>(
  "SELECT e.name, count(*)::int AS papers FROM paper_entities pe JOIN entities e ON e.id = pe.entity_id WHERE e.type = 'dataset' GROUP BY e.name ORDER BY papers DESC LIMIT 15");
console.log("datasets now found:", ds.map((d) => `${d.name}(${d.papers})`).join(", "));
await closeDb();
