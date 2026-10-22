import pg from "pg";
import { config } from "./config.ts";

// numeric/bigint stay as strings by default; parse the ones we use as numbers
pg.types.setTypeParser(1700, (v) => Number(v)); // numeric
pg.types.setTypeParser(20, (v) => Number(v)); // bigint

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

export type Db = Pick<pg.Pool, "query">;

export async function q<T = any>(text: string, params: unknown[] = [], db: Db = pool): Promise<T[]> {
  return (await db.query(text, params as any[])).rows as T[];
}
export async function q1<T = any>(text: string, params: unknown[] = [], db: Db = pool): Promise<T | undefined> {
  return (await q<T>(text, params, db))[0];
}

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
