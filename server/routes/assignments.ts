import { Router } from "express";
import { z } from "zod";
import { audit } from "../services/audit.ts";
import { q, q1, tx } from "../db.ts";
import type { AssignmentDetail, RecordingSummary } from "../../shared/types.ts";
import { finishAssignment, refreshSegments } from "../services/evaluate.ts";
import { HttpError, notFound, uuidParam } from "../http.ts";

// ---------- shared shape ----------
const SUMMARY = `
  SELECT a.id, a.status, a.created_at, a.updated_at,
         a.user_id, u.username, u.display_name, (u.deleted_at IS NOT NULL) AS user_deleted,
         v.id AS route_version_id, v.version, r.id AS route_id, v.name AS route_name, (r.deleted_at IS NOT NULL) AS route_deleted,
         (SELECT count(*)::int FROM assignment_segments s WHERE s.assignment_id = a.id) AS segment_total,
         (SELECT count(*)::int FROM assignment_segments s WHERE s.assignment_id = a.id AND s.status = 'completed') AS segment_done,
         (SELECT count(*)::int FROM assignment_segments s WHERE s.assignment_id = a.id AND s.required) AS required_total,
         (SELECT count(*)::int FROM assignment_segments s WHERE s.assignment_id = a.id AND s.required AND s.status = 'completed') AS required_done
    FROM assignments a
    JOIN users u ON u.id = a.user_id
    JOIN route_versions v ON v.id = a.route_version_id
    JOIN routes r ON r.id = v.route_id`;

const summary = (a: any) => ({
  id: a.id,
  status: a.status,
  createdAt: a.created_at,
  updatedAt: a.updated_at,
  worker: { id: a.user_id, username: a.username, displayName: a.display_name, deleted: a.user_deleted },
  route: { id: a.route_id, name: a.route_name, versionId: a.route_version_id, version: a.version, deleted: a.route_deleted },
  progress: {
    segmentsDone: a.segment_done,
    segmentsTotal: a.segment_total,
    requiredDone: a.required_done,
    requiredTotal: a.required_total,
  },
});

export async function recordingSummaries(assignmentId: string, userId?: string): Promise<RecordingSummary[]> {
  const rows = await q(
    `SELECT r.*, (SELECT count(*)::int FROM recording_chunks c WHERE c.recording_id = r.id) AS chunks_now,
            (SELECT COALESCE(sum(size),0) FROM recording_chunks c WHERE c.recording_id = r.id) AS bytes_now,
            (SELECT count(*)::int FROM gps_points g WHERE g.recording_id = r.id) AS gps_now
       FROM recordings r WHERE r.assignment_id = $1 AND ($2::uuid IS NULL OR r.user_id = $2) ORDER BY r.started_at_ms`,
    [assignmentId, userId ?? null],
  );
  return rows.map((r) => ({
    id: r.id,
    status: r.status === "server_verified" ? "server_verified" : "uploading",
    startedAtMs: Number(r.started_at_ms),
    endedAtMs: r.ended_at_ms === null ? null : Number(r.ended_at_ms),
    chunkCount: r.chunk_count ?? r.chunks_now,
    bytes: Number(r.file_bytes ?? r.bytes_now),
    gpsCount: r.gps_count ?? r.gps_now,
    simulated: r.simulated,
    stopReason: r.stop_reason,
    assembly: r.assembly_state,
    fileBytes: r.file_bytes === null ? null : Number(r.file_bytes),
  }));
}

export async function detail(id: string, userId?: string): Promise<AssignmentDetail | undefined> {
  const a = await q1(`${SUMMARY} WHERE a.id = $1 AND ($2::uuid IS NULL OR a.user_id = $2)`, [id, userId ?? null]);
  if (!a) return undefined;
  const extra = await q1("SELECT preflight, quality, review_reasons, completed_at FROM assignments WHERE id = $1", [id]);
  const segs = await q(
    `SELECT s.id, s.ord, s.required, s.status, s.skip_reason, s.completed_at, s.coverage, s.route_segment_id,
            rs.name, rs.min_coverage_ratio, ST_AsGeoJSON(rs.geom)::json AS g, ST_Length(rs.geom::geography) AS length_m
       FROM assignment_segments s JOIN route_segments rs ON rs.id = s.route_segment_id
      WHERE s.assignment_id = $1 ORDER BY s.ord`,
    [id],
  );
  const ev = await q(
    `SELECT e.assignment_segment_id, e.recording_id, e.coverage, e.first_t_ms, e.last_t_ms
       FROM segment_evidence e JOIN assignment_segments s ON s.id = e.assignment_segment_id
      WHERE s.assignment_id = $1 ORDER BY e.first_t_ms`,
    [id],
  );
  return {
    ...summary(a),
    reasons: extra.review_reasons ?? [],
    preflight: extra.preflight ?? null,
    quality: extra.quality ?? null,
    completedAt: extra.completed_at,
    recordings: await recordingSummaries(id, userId),
    segments: segs.map((s) => ({
      id: s.id,
      routeSegmentId: s.route_segment_id,
      order: s.ord,
      name: s.name,
      required: s.required,
      status: s.status,
      skipReason: s.skip_reason,
      completedAt: s.completed_at,
      coords: s.g.coordinates,
      coverage: s.coverage,
      minCoverageRatio: s.min_coverage_ratio,
      lengthM: Math.round(s.length_m * 10) / 10,
      evidence: ev
        .filter((e) => e.assignment_segment_id === s.id)
        .map((e) => ({
          recordingId: e.recording_id,
          coverage: e.coverage,
          firstTMs: e.first_t_ms === null ? null : Number(e.first_t_ms),
          lastTMs: e.last_t_ms === null ? null : Number(e.last_t_ms),
        })),
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
    if (v.status !== "published")
      throw new HttpError(409, "not_published", `only published route versions can be assigned (this one is ${v.status})`);
    const u = await q1("SELECT id, role, active FROM users WHERE id = $1", [body.userId], c);
    if (!u || u.role !== "worker") throw notFound("worker not found");
    if (!u.active) throw new HttpError(409, "worker_inactive", "this worker is deactivated");

    const [a] = await q(
      "INSERT INTO assignments (route_version_id, user_id, assigned_by) VALUES ($1,$2,$3) RETURNING id",
      [body.routeVersionId, body.userId, req.user!.id],
      c,
    );
    // snapshot of the segment list and the required flag at assignment time
    await q(
      `INSERT INTO assignment_segments (assignment_id, route_segment_id, ord, required)
       SELECT $1, id, ord, required FROM route_segments WHERE route_version_id = $2 ORDER BY ord`,
      [a.id, body.routeVersionId],
      c,
    );
    await audit(
      req.user!.id,
      "assignment_created",
      { type: "assignment", id: a.id },
      { userId: body.userId, versionId: body.routeVersionId },
      req.ip,
      c,
    );
    return a.id as string;
  });
  res.status(201).json(await detail(id));
});

adminAssignmentsRouter.get("/:id/audit", async (req, res) => {
  const id = uuidParam(req, "id");
  const recs = (await q("SELECT id FROM recordings WHERE assignment_id = $1", [id])).map((r) => r.id);
  res.json(
    await q(
      `SELECT l.id, l.at, l.action, l.details, u.username AS actor
       FROM audit_log l LEFT JOIN users u ON u.id = l.actor_id
      WHERE l.target_id = $1 OR l.target_id = ANY($2::text[]) ORDER BY l.id DESC LIMIT 200`,
      [id, recs],
    ),
  );
});

/** Admin decision on an assignment that needs review. */
adminAssignmentsRouter.post("/:id/review", async (req, res) => {
  const id = uuidParam(req, "id");
  const { decision } = z.object({ decision: z.enum(["approve", "reject"]) }).parse(req.body);
  await tx(async (c) => {
    const a = await q1("SELECT status FROM assignments WHERE id = $1 FOR UPDATE", [id], c);
    if (!a) throw notFound("assignment not found");
    if (a.status !== "needs_review") throw new HttpError(409, "not_in_review", "this assignment is not waiting for review");
    await q(
      "UPDATE assignments SET status = $1, completed_at = CASE WHEN $1 = 'completed' THEN now() ELSE NULL END, updated_at = now() WHERE id = $2",
      [decision === "approve" ? "completed" : "in_progress", id],
      c,
    );
    await audit(req.user!.id, "assignment_reviewed", { type: "assignment", id }, { decision }, req.ip, c);
  });
  res.json(await detail(id));
});

adminAssignmentsRouter.post("/:id/re-evaluate", async (req, res) => {
  const id = uuidParam(req, "id");
  if (!(await q1("SELECT 1 FROM assignments WHERE id = $1", [id]))) throw notFound("assignment not found");
  await finishAssignment(id, req.user!.id, req.ip);
  res.json(await detail(id));
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

async function ownedOpen(req: import("express").Request) {
  const id = uuidParam(req, "id");
  const a = await q1("SELECT id, status FROM assignments WHERE id = $1 AND user_id = $2", [id, req.user!.id]);
  if (!a) throw notFound("assignment not found");
  if (a.status === "completed") throw new HttpError(409, "completed", "this assignment is already completed");
  return a;
}

const preflightSchema = z.object({
  result: z.enum(["passed", "skipped"]),
  durationMs: z.number().int().min(0).max(3_600_000),
  samples: z.number().int().min(0).max(100_000),
  bestAccuracyM: z.number().min(0).max(100_000).nullable(),
  note: z.string().max(200).optional(),
});

workerAssignmentsRouter.post("/:id/preflight", async (req, res) => {
  const a = await ownedOpen(req);
  const body = preflightSchema.parse(req.body);
  await q("UPDATE assignments SET preflight = $1, updated_at = now() WHERE id = $2", [JSON.stringify(body), a.id]);
  await audit(req.user!.id, "preflight", { type: "assignment", id: a.id }, body, req.ip);
  res.json({ ok: true });
});

/** Optional segments only. The database also refuses it for a required one. */
workerAssignmentsRouter.post("/:id/segments/:segId/skip", async (req, res) => {
  const a = await ownedOpen(req);
  const segId = uuidParam(req, "segId");
  const { reason } = z.object({ reason: z.string().trim().max(200).default("") }).parse(req.body ?? {});
  const seg = await q1("SELECT required FROM assignment_segments WHERE id = $1 AND assignment_id = $2", [segId, a.id]);
  if (!seg) throw notFound("segment not found");
  if (seg.required) throw new HttpError(400, "required_segment", "a required segment cannot be skipped");
  await q("UPDATE assignment_segments SET status = 'skipped', skip_reason = $1 WHERE id = $2", [reason || "skipped by worker", segId]);
  await audit(req.user!.id, "segment_skipped", { type: "assignment_segment", id: segId }, { reason }, req.ip);
  res.json(await detail(a.id, req.user!.id));
});

workerAssignmentsRouter.post("/:id/segments/:segId/unskip", async (req, res) => {
  const a = await ownedOpen(req);
  const segId = uuidParam(req, "segId");
  await q(
    "UPDATE assignment_segments SET status = 'pending', skip_reason = NULL WHERE id = $1 AND assignment_id = $2 AND status = 'skipped'",
    [segId, a.id],
  );
  await refreshSegments(a.id);
  await audit(req.user!.id, "segment_unskipped", { type: "assignment_segment", id: segId }, undefined, req.ip);
  res.json(await detail(a.id, req.user!.id));
});

/** "I am done": the server checks uploads, GPS evidence and coverage, then decides. */
workerAssignmentsRouter.post("/:id/finish", async (req, res) => {
  const a = await ownedOpen(req);
  await finishAssignment(a.id, req.user!.id, req.ip);
  res.json(await detail(a.id, req.user!.id));
});
