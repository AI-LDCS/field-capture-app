import crypto from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ZodError } from "zod";
import { config } from "./config.ts";
import { loadSession, type SessionUser } from "./auth/sessions.ts";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
    public extra: object = {},
  ) {
    super(message ?? code);
  }
}
export const notFound = (what = "not found") => new HttpError(404, "not_found", what);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function uuidParam(req: Request, name: string): string {
  const v = String(req.params[name] ?? "");
  if (!UUID.test(v)) throw notFound();
  return v;
}

export const attachUser: RequestHandler = async (req, _res, next) => {
  try {
    req.user = (await loadSession(req)) ?? undefined;
    next();
  } catch (e) {
    next(e);
  }
};

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(new HttpError(401, "unauthenticated", "login required"));
  next();
};

export const requireRole =
  (role: "admin" | "worker"): RequestHandler =>
  (req, _res, next) => {
    if (!req.user) return next(new HttpError(401, "unauthenticated", "login required"));
    if (req.user.role !== role) return next(new HttpError(403, "forbidden", "not allowed"));
    next();
  };

/**
 * The anonymizer worker's routes. They accept the bearer token only (never a session cookie, see
 * requireAnonymizerToken), so a browser cannot be tricked into acting through them, and the CSRF checks
 * below do not apply: the worker is not a browser, so it sends no Origin and uploads raw video.
 */
const isAnonymizerCall = (req: Request) => req.originalUrl.startsWith("/api/anonymizer/");

/** Off (404) until ANONYMIZER_TOKEN is set. The token is compared by digest, in constant time. */
export const requireAnonymizerToken: RequestHandler = (req, _res, next) => {
  const want = config.anonymizer.token;
  if (!want) return next(notFound("no such endpoint"));
  const m = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""));
  if (!m) return next(new HttpError(401, "unauthenticated", "bearer token required"));
  const digest = (s: string) => crypto.createHash("sha256").update(s).digest();
  if (!crypto.timingSafeEqual(digest(m[1]), digest(want))) return next(new HttpError(401, "bad_token", "wrong token"));
  next();
};

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * CSRF defence on top of SameSite=Lax: state-changing requests must come from a known origin
 * and must be JSON (a cross-site HTML form cannot send application/json).
 */
export const csrfGuard: RequestHandler = (req, _res, next) => {
  if (!UNSAFE.has(req.method)) return next();
  if (isAnonymizerCall(req)) return next();
  const origin = req.headers.origin;
  if (origin) {
    if (!config.publicOrigins.includes(origin.replace(/\/$/, ""))) return next(new HttpError(403, "bad_origin", "origin not allowed"));
  } else if (!["same-origin", "none"].includes(String(req.headers["sec-fetch-site"] ?? ""))) {
    return next(new HttpError(403, "bad_origin", "origin required"));
  }
  const hasBody = Number(req.headers["content-length"] ?? 0) > 0 || req.headers["transfer-encoding"];
  // the one route that takes raw bytes; a cross-site form cannot send this content type
  const isChunk = req.method === "PUT" && /^\/api\/me\/recordings\/[0-9a-f-]{36}\/chunks\/\d+$/i.test(req.originalUrl.split("?")[0]);
  if (hasBody && !req.is("application/json") && !(isChunk && req.is("application/octet-stream"))) {
    return next(new HttpError(415, "json_required", "send application/json"));
  }
  next();
};

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) return void res.status(err.status).json({ error: err.code, message: err.message, ...err.extra });
  if (err instanceof ZodError) {
    return void res.status(400).json({
      error: "invalid_input",
      message: err.issues
        .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
        .slice(0, 5)
        .join("; "),
    });
  }
  const e = err as { code?: string; message?: string; type?: string; status?: number };
  if (e?.type === "entity.parse.failed") return void res.status(400).json({ error: "invalid_json", message: "body is not valid JSON" });
  if (e?.type === "entity.too.large") return void res.status(413).json({ error: "too_large", message: "body too large" });
  // database rules (unique, check, our guard triggers) are conflicts with current state, not server bugs
  if (e?.code === "23505") return void res.status(409).json({ error: "conflict", message: "already exists" });
  if (e?.code === "P0001" || e?.code === "23514" || e?.code === "23503") {
    return void res.status(409).json({ error: "rule_violation", message: e.message });
  }
  console.error(err);
  res.status(500).json({ error: "server_error", message: "something went wrong" });
}
