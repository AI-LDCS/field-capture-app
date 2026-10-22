import crypto from "node:crypto";
import type { Request, Response } from "express";
import { config } from "../config.ts";
import { q, q1, type Db } from "../db.ts";

export type SessionUser = {
  id: string;
  username: string;
  displayName: string;
  role: "admin" | "worker";
  sessionId: string;
};

export const COOKIE_NAME = () => (config.cookieSecure ? "__Host-sid" : "sid");
const sha = (t: string) => crypto.createHash("sha256").update(t).digest("hex");

export function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
}

/** New random token on every login (no fixation). Only its hash is stored. */
export async function createSession(userId: string, req: Request, res: Response, db?: Db) {
  const token = crypto.randomBytes(32).toString("base64url");
  const maxAgeMs = config.session.absoluteHours * 3600_000;
  await q(
    "INSERT INTO sessions (id, user_id, expires_at, ip, user_agent) VALUES ($1,$2, now() + ($3 || ' milliseconds')::interval, $4, $5)",
    [sha(token), userId, String(maxAgeMs), req.ip ?? null, (req.headers["user-agent"] ?? "").slice(0, 300)],
    db,
  );
  res.cookie(COOKIE_NAME(), token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeMs,
  });
  return sha(token);
}

export function clearCookie(res: Response) {
  res.clearCookie(COOKIE_NAME(), { httpOnly: true, secure: config.cookieSecure, sameSite: "lax", path: "/" });
}

/** Valid only if the user is still active and both the absolute and idle limits hold. */
export async function loadSession(req: Request): Promise<SessionUser | null> {
  const token = readCookie(req, COOKIE_NAME());
  if (!token) return null;
  const id = sha(token);
  const row = await q1(
    `SELECT s.id AS session_id, s.last_seen_at, u.id, u.username, u.display_name, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.expires_at > now()
        AND s.last_seen_at > now() - ($2 || ' hours')::interval
        AND u.active`,
    [id, String(config.session.idleHours)],
  );
  if (!row) return null;
  if (Date.now() - new Date(row.last_seen_at).getTime() > 60_000) {
    await q("UPDATE sessions SET last_seen_at = now() WHERE id = $1", [id]);
  }
  return {
    id: row.id, username: row.username, displayName: row.display_name, role: row.role, sessionId: id,
  };
}

export const deleteSession = (sessionId: string, db?: Db) => q("DELETE FROM sessions WHERE id = $1", [sessionId], db);
/** Kill every session of a user, optionally keeping one (the caller's own after a password change). */
export const deleteUserSessions = (userId: string, exceptSessionId?: string, db?: Db) =>
  q("DELETE FROM sessions WHERE user_id = $1 AND ($2::text IS NULL OR id <> $2)", [userId, exceptSessionId ?? null], db);
