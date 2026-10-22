import path from "node:path";
import fs from "node:fs";
import express from "express";
import helmet from "helmet";
import { config } from "./config.ts";
import { pool } from "./db.ts";
import { attachUser, csrfGuard, errorHandler, HttpError, requireAuth, requireRole } from "./http.ts";
import { adminAssignmentsRouter, workerAssignmentsRouter } from "./routes/assignments.ts";
import { adminRoutesRouter } from "./routes/adminRoutes.ts";
import { adminUsersRouter } from "./routes/adminUsers.ts";
import { authRouter } from "./routes/auth.ts";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy); // without this, Secure cookies and client IPs break behind the proxy

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"], // Leaflet positions with inline styles
          imgSrc: ["'self'", "data:", "blob:", "https://tile.openstreetmap.org", "https://tile.opentopomap.org"],
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

  app.use("/api/auth", authRouter);
  app.use("/api/admin/users", requireAuth, requireRole("admin"), adminUsersRouter);
  app.use("/api/admin/assignments", requireAuth, requireRole("admin"), adminAssignmentsRouter);
  app.use("/api/admin", requireAuth, requireRole("admin"), adminRoutesRouter);
  app.use("/api/me/assignments", requireAuth, requireRole("worker"), workerAssignmentsRouter);
  app.use("/api", (_req, _res, next) => next(new HttpError(404, "not_found", "no such endpoint")));

  // built web app (dev: ../dist/web next to server/, container: ./web next to dist/server.js)
  const web = [path.resolve(import.meta.dirname, "web"), path.resolve(import.meta.dirname, "../dist/web")].find((p) => fs.existsSync(p));
  if (web) {
    app.use(express.static(web, { index: "index.html", maxAge: "1h" }));
  }

  app.use(errorHandler);
  return app;
}
