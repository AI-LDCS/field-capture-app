import { audit } from "../services/audit.ts";
import { hashPassword } from "./password.ts";
import { config } from "../config.ts";
import { q1, q } from "../db.ts";

/**
 * Creates the first admin from environment secrets, only when no admin exists yet.
 * It never touches an existing account, so restarts and re-seeds do not reset anyone's password.
 */
export async function bootstrapAdmin() {
  const existing = await q1("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  if (existing) return;
  const { adminUsername: u, adminPassword: p } = config;
  if (!u || !p) {
    console.warn("no admin exists yet. Set ADMIN_USERNAME and ADMIN_PASSWORD and restart to create one.");
    return;
  }
  if (!/^[a-z0-9._-]{3,32}$/.test(u.toLowerCase())) throw new Error("ADMIN_USERNAME must be 3-32 chars: a-z 0-9 . _ -");
  if (p.length < config.password.adminMinLength)
    throw new Error(`ADMIN_PASSWORD must be at least ${config.password.adminMinLength} characters`);
  const hash = await hashPassword(p);
  const [row] = await q(
    "INSERT INTO users (username, display_name, password_hash, role) VALUES ($1,'Administrator',$2,'admin') ON CONFLICT DO NOTHING RETURNING id",
    [u.toLowerCase(), hash],
  );
  if (row) {
    await audit(null, "admin_bootstrapped", { type: "user", id: row.id }, { username: u.toLowerCase() });
    console.log(`initial admin "${u.toLowerCase()}" created`);
  }
}
