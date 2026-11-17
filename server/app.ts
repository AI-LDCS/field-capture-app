import path from "node:path";
import fs from "node:fs";
import express, { type RequestHandler, type Router } from "express";
import helmet from "helmet";
import { config } from "./config.ts";
import { pool } from "./db.ts";
import { attachUser, csrfGuard, errorHandler, HttpError, requireAnonymizerToken, requireAuth, requireRole } from "./http.ts";
import { adminAssignmentsRouter, workerAssignmentsRouter } from "./routes/assignments.ts";
import { adminRoutesRouter } from "./routes/adminRoutes.ts";
import { adminUsersRouter } from "./routes/adminUsers.ts";
import { adminExportRouter, adminRecordingsRouter } from "./routes/adminRecordings.ts";
import { workerRecordingsRouter } from "./routes/recordings.ts";
import { authRouter } from "./routes/auth.ts";
import { anonymizerRouter } from "./routes/anonymizer.ts";

/** Every router and where it is mounted. The app is built from this table, and tests check against it. */
const MOUNTS: { prefix: string; guards: RequestHandler[]; routers: Router[] }[] = [
  { prefix: "/api/auth", guards: [], routers: [authRouter] },
  { prefix: "/api/admin/users", guards: [requireAuth, requireRole("admin")], routers: [adminUsersRouter] },
  { prefix: "/api/admin/assignments", guards: [requireAuth, requireRole("admin")], routers: [adminExportRouter, adminAssignmentsRouter] },
  { prefix: "/api/admin/recordings", guards: [requireAuth, requireRole("admin")], routers: [adminRecordingsRouter] },
  { prefix: "/api/admin", guards: [requireAuth, requireRole("admin")], routers: [adminRoutesRouter] },
  { prefix: "/api/anonymizer", guards: [requireAnonymizerToken], routers: [anonymizerRouter] },
  { prefix: "/api/me/assignments", guards: [requireAuth, requireRole("worker")], routers: [workerAssignmentsRouter] },
  { prefix: "/api/me/recordings", guards: [requireAuth, requireRole("worker")], routers: [workerRecordingsRouter] },
];

/** "METHOD /full/path" for every endpoint the app serves (API and health check). */
export function listEndpoints(): string[] {
  const out = ["GET /healthz"];
  for (const m of MOUNTS) {
    for (const r of m.routers) {
      for (const layer of (r as any).stack as any[]) {
        if (!layer.route) continue;
        for (const method of Object.keys(layer.route.methods)) out.push(`${method.toUpperCase()} ${m.prefix}${layer.route.path}`);
      }
    }
  }
  return out.sort();
}

export function createApp(opts: { onHit?: (endpoint: string, status: number) => void } = {}) {
  const app = express();
  app.disable("x-powered-by");
  // tests record which route served each request. Express forgets the matched route (and the mount
  // path) once an error handler runs, so remember both at the moment the route is matched.
  if (opts.onHit) {
    app.use((req, res, next) => {
      let current: any;
      let seen: { path: string; base: string } | null = null;
      Object.defineProperty(req, "route", {
        configurable: true,
        get: () => current,
        set: (v) => {
          current = v;
          if (v) seen = { path: v.path, base: req.baseUrl };
        },
      });
      res.on("finish", () => {
        if (seen) opts.onHit!(`${req.method} ${seen.base}${seen.path}`, res.statusCode);
      });
      next();
    });
  }
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"], // Leaflet positions with inline styles
          imgSrc: [
            "'self'",
            "data:",
            "blob:",
            "https://tile.openstreetmap.org",
            "https://tile.opentopomap.org",
            "https://server.arcgisonline.com",
          ],
          mediaSrc: ["'self'", "blob:"],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: config.cookieSecure ? [] : null,
        },
      },
      // OSM and other tile servers reject requests with no Referer. Send only our origin, and only cross-origin.
      referrerPolicy: { policy: "strict-origin-when-cross-origin" },
      // plain-http local development must not be forced to https
      strictTransportSecurity: config.cookieSecure,
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(express.json({ limit: "2mb" }));

  app.get("/healthz", async (_req, res) => {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  });

  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use("/api", csrfGuard, attachUser);

  for (const m of MOUNTS) app.use(m.prefix, ...m.guards, ...m.routers);
  app.use("/api", (_req, _res, next) => next(new HttpError(404, "not_found", "no such endpoint")));

  // built web app (dev: ../dist/web next to server/, container: ./web next to dist/server.js)
  const web = [path.resolve(import.meta.dirname, "web"), path.resolve(import.meta.dirname, "../dist/web")].find((p) => fs.existsSync(p));
  if (web) {
    app.use(express.static(web, { index: "index.html", maxAge: "1h" }));
  }

  app.use(errorHandler);
  return app;
}
