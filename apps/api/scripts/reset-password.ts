/**
 * Set a new password for an account (passwords are hashed, so they can't be read back).
 * Usage (from apps/api, with the API stopped when using the embedded database):
 *   npx tsx scripts/reset-password.ts you@example.com "new password"
 */
import { closeDb, getDb } from "../src/db/client.js";
import { migrate } from "../src/db/migrations.js";
import { hashPassword } from "../src/auth.js";

const [email, password] = process.argv.slice(2);
if (!email || !password || password.length < 8) {
  console.error('Usage: npx tsx scripts/reset-password.ts <email> "<new password, 8+ characters>"');
  process.exit(1);
}
const db = await getDb();
await migrate(db);
const { rows } = await db.query<{ id: number }>("UPDATE users SET password_hash = $2 WHERE email = lower($1) RETURNING id", [email, await hashPassword(password)]);
if (!rows.length) console.error(`No account with email ${email}`);
else {
  await db.query("DELETE FROM sessions WHERE user_id = $1", [rows[0].id]); // sign out everywhere
  console.log(`Password updated for ${email}. Sign in with the new password.`);
}
await closeDb();
