/** Server entry point: database + migrations, job queue, HTTP server, graceful shutdown. */
import { buildApp } from "./app.js";
import { config } from "./config.js";
import { closeDb, getDb } from "./db/client.js";
import { migrate } from "./db/migrations.js";

const db = await getDb();
const applied = await migrate(db);
const app = await buildApp(db);
if (applied.length) app.log.info({ applied }, "database migrated");
await app.jobs.start();

await app.listen({ host: config.HOST, port: config.PORT });
app.log.info(`PaperMind API on http://${config.HOST}:${config.PORT} (db: ${db.kind}, ml: ${config.ML_SERVICE_URL}, llm: ${config.OPENROUTER_API_KEY ? config.OPENROUTER_MODEL : "off"})`);

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    app.log.info(`${sig}: shutting down`);
    await app.jobs.stop();
    await app.close();
    await closeDb();
    process.exit(0);
  });
}
