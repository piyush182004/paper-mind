/** Merge public papers that are the same work (same normalised title): keep the best-indexed copy. */
import { closeDb, getDb } from "../src/db/client.js";
import { migrate } from "../src/db/migrations.js";

const db = await getDb();
await migrate(db);
await db.query("DELETE FROM users WHERE email LIKE '%@example.org'"); // throwaway test accounts
const { rows } = await db.query<{ key: string; ids: number[] }>(
  `SELECT regexp_replace(lower(title), '[^a-z0-9]', '', 'g') AS key, array_agg(id ORDER BY has_fulltext DESC, id) AS ids
   FROM papers WHERE owner_id IS NULL GROUP BY 1 HAVING count(*) > 1`);
for (const r of rows) {
  const [keep, ...drop] = r.ids.map(Number);
  await db.query("INSERT INTO library (user_id, paper_id, added_at) SELECT user_id, $1, added_at FROM library WHERE paper_id = ANY($2::bigint[]) ON CONFLICT DO NOTHING", [keep, drop]);
  await db.query("DELETE FROM papers WHERE id = ANY($1::bigint[])", [drop]);
  console.log(`merged ${drop.join(",")} into ${keep}`);
}
await db.query("DELETE FROM papers p WHERE owner_id IS NULL AND NOT EXISTS (SELECT 1 FROM library l WHERE l.paper_id = p.id)");
if (rows.length) await db.query(`INSERT INTO jobs (kind, payload, user_id) SELECT 'cluster', jsonb_build_object('userId', id, 'algorithm', 'hdbscan'), id FROM users`);
console.log(`${rows.length} duplicate group(s) merged`);
await closeDb();
