import { Router } from "express";
import { z } from "zod";
import { audit } from "../audit.ts";
import { generatePassword, hashPassword } from "../auth/password.ts";
import { deleteUserSessions } from "../auth/sessions.ts";
import { q, q1, tx } from "../db.ts";
import { notFound, uuidParam } from "../http.ts";
import { workerPassword } from "./auth.ts";

/**
 * A worker is a username, a display name and a password. Only an admin sets the password, and the
 * worker cannot change it. Admins manage workers only; there is no admin-creates-admin.
 */
export const adminUsersRouter = Router();

const row = (u: any) => ({ id: u.id, username: u.username, displayName: u.display_name, active: u.active, createdAt: u.created_at });

adminUsersRouter.get("/", async (_req, res) => {
  res.json((await q("SELECT * FROM users WHERE role = 'worker' ORDER BY active DESC, username")).map(row));
});

const createSchema = z.object({
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,32}$/, "3-32 chars: letters, digits . _ -"),
  displayName: z.string().trim().max(80).default(""),
  password: workerPassword.optional(), // left out = the server generates one
});

adminUsersRouter.post("/", async (req, res) => {
  const body = createSchema.parse(req.body);
  const generated = !body.password;
  const pw = body.password ?? generatePassword();
  const hash = await hashPassword(pw);
  const user = await tx(async (c) => {
    const [u] = await q(
      "INSERT INTO users (username, display_name, password_hash, role) VALUES ($1,$2,$3,'worker') RETURNING *",
      [body.username, body.displayName, hash], c,
    );
    await audit(req.user!.id, "user_created", { type: "user", id: u.id }, { username: u.username }, req.ip, c);
    return u;
  });
  // only a generated password is sent back (once); one the admin typed is not echoed
  res.status(201).json({ user: row(user), ...(generated ? { generatedPassword: pw } : {}) });
});

async function worker(id: string) {
  const u = await q1("SELECT * FROM users WHERE id=$1 AND role='worker'", [id]);
  if (!u) throw notFound("worker not found");
  return u;
}

adminUsersRouter.patch("/:id", async (req, res) => {
  const id = uuidParam(req, "id");
  await worker(id);
  const { displayName } = z.object({ displayName: z.string().trim().max(80) }).parse(req.body);
  await q("UPDATE users SET display_name=$1, updated_at=now() WHERE id=$2", [displayName, id]);
  await audit(req.user!.id, "user_updated", { type: "user", id }, { displayName }, req.ip);
  res.json(row(await q1("SELECT * FROM users WHERE id=$1", [id])));
});

adminUsersRouter.post("/:id/deactivate", async (req, res) => {
  const id = uuidParam(req, "id");
  await worker(id);
  await tx(async (c) => {
    await q("UPDATE users SET active=false, updated_at=now() WHERE id=$1", [id], c);
    await deleteUserSessions(id, undefined, c); // signed out everywhere, right now
    await audit(req.user!.id, "user_deactivated", { type: "user", id }, undefined, req.ip, c);
  });
  res.json(row(await q1("SELECT * FROM users WHERE id=$1", [id])));
});

adminUsersRouter.post("/:id/activate", async (req, res) => {
  const id = uuidParam(req, "id");
  await worker(id);
  await q("UPDATE users SET active=true, updated_at=now() WHERE id=$1", [id]);
  await audit(req.user!.id, "user_activated", { type: "user", id }, undefined, req.ip);
  res.json(row(await q1("SELECT * FROM users WHERE id=$1", [id])));
});

/** The one way to change a worker's password: an admin types a new one, or leaves it out to generate one. */
adminUsersRouter.post("/:id/password", async (req, res) => {
  const id = uuidParam(req, "id");
  await worker(id);
  const body = z.object({ password: workerPassword.optional() }).parse(req.body ?? {});
  const generated = !body.password;
  const pw = body.password ?? generatePassword();
  const hash = await hashPassword(pw);
  await tx(async (c) => {
    await q("UPDATE users SET password_hash=$1, password_changed_at=now(), updated_at=now() WHERE id=$2", [hash, id], c);
    await deleteUserSessions(id, undefined, c); // old password, old sessions: gone
    await audit(req.user!.id, "password_set", { type: "user", id }, { generated }, req.ip, c);
  });
  res.json(generated ? { generatedPassword: pw } : { ok: true });
});
