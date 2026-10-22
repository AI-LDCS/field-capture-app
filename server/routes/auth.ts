import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { audit } from "../audit.ts";
import { dummyHash, hashPassword, verifyPassword } from "../auth/password.ts";
import { clearCookie, COOKIE_NAME, createSession, deleteSession, deleteUserSessions, readCookie } from "../auth/sessions.ts";
import { config } from "../config.ts";
import { q, q1, tx } from "../db.ts";
import { HttpError, requireAuth } from "../http.ts";

export const authRouter = Router();

const loginSchema = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(config.password.maxLength) });
export const workerPassword = z.string().min(config.password.workerMinLength, `at least ${config.password.workerMinLength} characters`).max(config.password.maxLength);
const adminPassword = z.string().min(config.password.adminMinLength, `at least ${config.password.adminMinLength} characters`).max(config.password.maxLength);

const publicUser = (u: { id: string; username: string; displayName: string; role: string }) => ({
  id: u.id, username: u.username, displayName: u.displayName, role: u.role,
});

authRouter.post("/login", async (req, res) => {
  const { username, password } = loginSchema.parse(req.body);
  const uname = username.trim().toLowerCase();
  const ip = req.ip ?? "unknown";
  const { windowMinutes, maxFailuresPerUser, maxFailuresPerIp } = config.login;

  const counts = await q1(
    `SELECT count(*) FILTER (WHERE username = $1) AS by_user, count(*) FILTER (WHERE ip = $2) AS by_ip
       FROM login_attempts WHERE at > now() - ($3 || ' minutes')::interval AND (username = $1 OR ip = $2)`,
    [uname, ip, String(windowMinutes)],
  );
  if (counts.by_user >= maxFailuresPerUser || counts.by_ip >= maxFailuresPerIp) {
    res.set("Retry-After", String(windowMinutes * 60));
    await audit(null, "login_locked", { type: "user", id: uname }, undefined, ip);
    throw new HttpError(429, "too_many_attempts", `too many failed logins; try again in ${windowMinutes} minutes`);
  }

  const user = await q1("SELECT * FROM users WHERE username = $1", [uname]);
  // always run one Argon2 verification, so a wrong username costs the same time as a wrong password
  const ok = await verifyPassword(user?.password_hash ?? (await dummyHash()), password);
  if (!user || !ok || !user.active) {
    await q("INSERT INTO login_attempts (username, ip) VALUES ($1,$2)", [uname, ip]);
    await q("DELETE FROM login_attempts WHERE at < now() - interval '1 day'");
    await audit(user?.id ?? null, "login_failed", { type: "user", id: uname }, undefined, ip);
    throw new HttpError(401, "invalid_credentials", "wrong username or password");
  }

  const old = readCookie(req, COOKIE_NAME());
  if (old) {
    await deleteSession(crypto.createHash("sha256").update(old).digest("hex"));
  }
  await q("DELETE FROM login_attempts WHERE username = $1", [uname]);
  await createSession(user.id, req, res);
  await audit(user.id, "login", { type: "user", id: user.id }, undefined, ip);
  res.json({ user: publicUser({ id: user.id, username: user.username, displayName: user.display_name, role: user.role }), devTools: config.devTools });
});

authRouter.post("/logout", async (req, res) => {
  if (req.user) {
    await deleteSession(req.user.sessionId);
    await audit(req.user.id, "logout", { type: "user", id: req.user.id }, undefined, req.ip);
  }
  clearCookie(res);
  res.json({ ok: true });
});

authRouter.get("/me", requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user!), devTools: config.devTools });
});

const changeSchema = z.object({ currentPassword: z.string().min(1).max(config.password.maxLength), newPassword: adminPassword });

/** Only the admin account changes its own password. A worker's password is set by an admin and is fixed. */
authRouter.post("/change-password", requireAuth, async (req, res) => {
  const me = req.user!;
  if (me.role !== "admin") throw new HttpError(403, "forbidden", "ask an administrator to change your password");
  const { currentPassword, newPassword: np } = changeSchema.parse(req.body);
  const row = await q1("SELECT password_hash FROM users WHERE id = $1", [me.id]);
  if (!row || !(await verifyPassword(row.password_hash, currentPassword))) {
    throw new HttpError(400, "wrong_password", "current password is wrong");
  }
  if (np === currentPassword) throw new HttpError(400, "same_password", "choose a different password");
  const hash = await hashPassword(np);
  await tx(async (c) => {
    await q("UPDATE users SET password_hash=$1, password_changed_at=now(), updated_at=now() WHERE id=$2", [hash, me.id], c);
    await deleteUserSessions(me.id, me.sessionId, c); // every other device is signed out
    await audit(me.id, "password_changed", { type: "user", id: me.id }, undefined, req.ip, c);
  });
  res.json({ ok: true });
});
