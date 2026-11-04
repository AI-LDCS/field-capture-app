import type { Db } from "../db.ts";
import { pool } from "../db.ts";

export async function audit(
  actorId: string | null,
  action: string,
  target?: { type: string; id: string },
  details?: unknown,
  ip?: string,
  db: Db = pool,
) {
  await db.query("INSERT INTO audit_log (actor_id, action, target_type, target_id, details, ip) VALUES ($1,$2,$3,$4,$5,$6)", [
    actorId,
    action,
    target?.type ?? null,
    target?.id ?? null,
    details === undefined ? null : JSON.stringify(details),
    ip ?? null,
  ]);
}
