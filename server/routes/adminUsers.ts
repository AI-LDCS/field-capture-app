import { Router } from "express";
import { z } from "zod";
import { audit } from "../audit.ts";
import { generatePassword, hashPassword } from "../auth/password.ts";
import { deleteUserSessions } from "../auth/sessions.ts";
import { q, q1, tx } from "../db.ts";
import { notFound, uuidParam } from "../http.ts";
import { newPassword } from "./auth.ts";

/** Admins manage field workers only. There is no admin-creates-admin feature. */
export const adminUsersRouter = Router();

const row = (u: any) => ({
  id: u.id, username: u.username, displayName: u.display_name, active: u.active,
  mustChangePassword: u.must_change_password, createdAt: u.created_at, lastActiveAt: u.last_active_at ?? null,
});
const SELECT = `SELECT u.*, (SELECT max(last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_active_at FROM users u`;

adminUsersRouter.get("/", async (_req, res) => {
  res.json((await q(`${SELECT} WHERE u.role = 'worker' ORDER BY u.active DESC, u.username`)).map(row));
});

const createSchema = z.object({
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,32}$/, "3-32 chars: letters, digits . _ -"),
  displayName: z.string().trim().max(80).default(""),
  password: newPassword.optional(),
});

adminUsersRouter.post("/", async (req, res) => {
  const body = createSchema.parse(req.body);
  const pw = body.password ?? generatePassword();
  const hash = await hashPassword(pw);
  const user = await tx(async (c) => {
    const [u] = await q(
      "INSERT INTO users (username, display_name, password_hash, role, must_change_password) VALUES ($1,$2,$3,'worker',true) RETURNING *",
      [body.username, body.displayName, hash], c,
    );
    await audit(req.user!.id, "user_created", { type: "user", id: u.id }, { username: u.username }, req.ip, c);
    return u;
  });
  // the password is shown once here and never stored in readable form
  res.status(201).json({ user: row(user), temporaryPassword: pw });
});

const patchSchema = z.object({ displayName: z.string().trim().max(80) });

async function worker(id: string) {
  const u = await q1("SELECT * FROM users WHERE id=$1 AND role='worker'", [id]);
  if (!u) throw notFound("worker not found");
  return u;
}

adminUsersRouter.patch("/:id", async (req, res) => {
  const id = uuidParam(req, "id");
  await worker(id);
  const { displayName } = patchSchema.parse(req.body);
  await q("UPDATE users SET display_name=$1, updated_at=now() WHERE id=$2", [displayName, id]);
  await audit(req.user!.id, "user_updated", { type: "user", id }, { displayName }, req.ip);
  res.json(row((await q1(`${SELECT} WHERE u.id=$1`, [id]))));
});

adminUsersRouter.post("/:id/deactivate", async (req, res) => {
  const id = uuidParam(req, "id");
  await worker(id);
  await tx(async (c) => {
    await q("UPDATE users SET active=false, updated_at=now() WHERE id=$1", [id], c);
    await deleteUserSessions(id, undefined, c); // signed out everywhere, right now
    await audit(req.user!.id, "user_deactivated", { type: "user", id }, undefined, req.ip, c);
  });
  res.json(row((await q1(`${SELECT} WHERE u.id=$1`, [id]))));
});

adminUsersRouter.post("/:id/activate", async (req, res) => {
  const id = uuidParam(req, "id");
  await worker(id);
  await q("UPDATE users SET active=true, updated_at=now() WHERE id=$1", [id]);
  await audit(req.user!.id, "user_activated", { type: "user", id }, undefined, req.ip);
  res.json(row((await q1(`${SELECT} WHERE u.id=$1`, [id]))));
});

adminUsersRouter.post("/:id/reset-password", async (req, res) => {
  const id = uuidParam(req, "id");
  await worker(id);
  const body = z.object({ password: newPassword.optional() }).parse(req.body ?? {});
  const pw = body.password ?? generatePassword();
  const hash = await hashPassword(pw);
  await tx(async (c) => {
    await q("UPDATE users SET password_hash=$1, must_change_password=true, password_changed_at=now(), updated_at=now() WHERE id=$2", [hash, id], c);
    await deleteUserSessions(id, undefined, c); // old password, old sessions: gone
    await audit(req.user!.id, "password_reset", { type: "user", id }, undefined, req.ip, c);
  });
  res.json({ temporaryPassword: pw });
});
