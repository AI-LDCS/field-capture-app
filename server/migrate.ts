import fs from "node:fs";
import path from "node:path";
import { pool } from "./db.ts";

const DIR = path.resolve(import.meta.dirname, "../db/migrations");

/** Plain SQL files, applied once each in name order. An advisory lock keeps two app instances from racing. */
export async function migrate() {
  const c = await pool.connect();
  try {
    await c.query("SELECT pg_advisory_lock(727274)");
    await c.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const done = new Set((await c.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    for (const f of fs
      .readdirSync(DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      if (done.has(f)) continue;
      await c.query("BEGIN");
      try {
        await c.query(fs.readFileSync(path.join(DIR, f), "utf8"));
        await c.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
        await c.query("COMMIT");
        console.log(`migration applied: ${f}`);
      } catch (e) {
        await c.query("ROLLBACK");
        throw new Error(`migration ${f} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  } finally {
    await c.query("SELECT pg_advisory_unlock(727274)").catch(() => {});
    c.release();
  }
}
