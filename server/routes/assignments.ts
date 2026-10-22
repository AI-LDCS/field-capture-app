import { Router } from "express";
import { z } from "zod";
import { audit } from "../audit.ts";
import { q, q1, tx } from "../db.ts";
import { HttpError, notFound, uuidParam } from "../http.ts";

// ---------- shared shape ----------
const SUMMARY = `
  SELECT a.id, a.status, a.created_at, a.updated_at,
         a.user_id, u.username, u.display_name,
         v.id AS route_version_id, v.version, r.id AS route_id, v.name AS route_name,
         (SELECT count(*)::int FROM assignment_segments s WHERE s.assignment_id = a.id) AS segment_total,
         (SELECT count(*)::int FROM assignment_segments s WHERE s.assignment_id = a.id AND s.status = 'completed') AS segment_done,
         (SELECT count(*)::int FROM assignment_segments s WHERE s.assignment_id = a.id AND s.required) AS required_total,
         (SELECT count(*)::int FROM assignment_segments s WHERE s.assignment_id = a.id AND s.required AND s.status = 'completed') AS required_done
    FROM assignments a
    JOIN users u ON u.id = a.user_id
    JOIN route_versions v ON v.id = a.route_version_id
    JOIN routes r ON r.id = v.route_id`;

const summary = (a: any) => ({
  id: a.id, status: a.status, createdAt: a.created_at, updatedAt: a.updated_at,
  worker: { id: a.user_id, username: a.username, displayName: a.display_name },
  route: { id: a.route_id, name: a.route_name, versionId: a.route_version_id, version: a.version },
  progress: { segmentsDone: a.segment_done, segmentsTotal: a.segment_total, requiredDone: a.required_done, requiredTotal: a.required_total },
});

async function detail(id: string, userId?: string) {
  const a = await q1(`${SUMMARY} WHERE a.id = $1 AND ($2::uuid IS NULL OR a.user_id = $2)`, [id, userId ?? null]);
  if (!a) return undefined;
  const segs = await q(
    `SELECT s.id, s.ord, s.required, s.status, s.skip_reason, s.completed_at, s.route_segment_id,
            rs.name, rs.min_coverage_ratio, ST_AsGeoJSON(rs.geom)::json AS g, ST_Length(rs.geom::geography) AS length_m
       FROM assignment_segments s JOIN route_segments rs ON rs.id = s.route_segment_id
      WHERE s.assignment_id = $1 ORDER BY s.ord`, [id],
  );
  return {
    ...summary(a),
    segments: segs.map((s) => ({
      id: s.id, routeSegmentId: s.route_segment_id, order: s.ord, name: s.name, required: s.required, status: s.status,
      skipReason: s.skip_reason, completedAt: s.completed_at, coords: s.g.coordinates,
      minCoverageRatio: s.min_coverage_ratio, lengthM: Math.round(s.length_m * 10) / 10,
    })),
  };
}

// ---------- admin ----------
export const adminAssignmentsRouter = Router();

adminAssignmentsRouter.get("/", async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : null;
  const userId = typeof req.query.userId === "string" ? uuidParam({ params: { u: req.query.userId } } as any, "u") : null;
  const rows = await q(
    `${SUMMARY} WHERE ($1::text IS NULL OR a.status = $1) AND ($2::uuid IS NULL OR a.user_id = $2) ORDER BY a.created_at DESC LIMIT 500`,
    [status, userId],
  );
  res.json(rows.map(summary));
});

adminAssignmentsRouter.get("/:id", async (req, res) => {
  const d = await detail(uuidParam(req, "id"));
  if (!d) throw notFound("assignment not found");
  res.json(d);
});

const createSchema = z.object({ routeVersionId: z.uuid(), userId: z.uuid() });

adminAssignmentsRouter.post("/", async (req, res) => {
  const body = createSchema.parse(req.body);
  const id = await tx(async (c) => {
    const v = await q1("SELECT id, status FROM route_versions WHERE id = $1", [body.routeVersionId], c);
    if (!v) throw notFound("route version not found");
    if (v.status !== "published") throw new HttpError(409, "not_published", `only published route versions can be assigned (this one is ${v.status})`);
    const u = await q1("SELECT id, role, active FROM users WHERE id = $1", [body.userId], c);
    if (!u || u.role !== "worker") throw notFound("worker not found");
    if (!u.active) throw new HttpError(409, "worker_inactive", "this worker is deactivated");

    const [a] = await q(
      "INSERT INTO assignments (route_version_id, user_id, assigned_by) VALUES ($1,$2,$3) RETURNING id",
      [body.routeVersionId, body.userId, req.user!.id], c,
    );
    // snapshot of the segment list and the required flag at assignment time
    await q(
      `INSERT INTO assignment_segments (assignment_id, route_segment_id, ord, required)
       SELECT $1, id, ord, required FROM route_segments WHERE route_version_id = $2 ORDER BY ord`,
      [a.id, body.routeVersionId], c,
    );
    await audit(req.user!.id, "assignment_created", { type: "assignment", id: a.id }, { userId: body.userId, versionId: body.routeVersionId }, req.ip, c);
    return a.id as string;
  });
  res.status(201).json(await detail(id));
});

/** Only an assignment nobody has started can be withdrawn. */
adminAssignmentsRouter.delete("/:id", async (req, res) => {
  const id = uuidParam(req, "id");
  await tx(async (c) => {
    const a = await q1("SELECT status FROM assignments WHERE id = $1 FOR UPDATE", [id], c);
    if (!a) throw notFound("assignment not found");
    if (a.status !== "assigned") throw new HttpError(409, "already_started", `assignment is ${a.status}; it cannot be withdrawn`);
    await q("DELETE FROM assignments WHERE id = $1", [id], c);
    await audit(req.user!.id, "assignment_withdrawn", { type: "assignment", id }, undefined, req.ip, c);
  });
  res.json({ ok: true });
});

// ---------- worker: only their own, everything else is a 404 ----------
export const workerAssignmentsRouter = Router();

workerAssignmentsRouter.get("/", async (req, res) => {
  const rows = await q(`${SUMMARY} WHERE a.user_id = $1 ORDER BY a.created_at DESC`, [req.user!.id]);
  res.json(rows.map(summary));
});

workerAssignmentsRouter.get("/:id", async (req, res) => {
  const d = await detail(uuidParam(req, "id"), req.user!.id);
  if (!d) throw notFound("assignment not found");
  res.json(d);
});
