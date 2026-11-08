import { CONFIG } from "../../shared/config.ts";
import { analyseQuality, qualityReasons } from "../../shared/quality.ts";
import { coverageMask, distToLineM } from "../../shared/geo.ts";
import type { AssignmentStatus, GpsPoint, LngLat } from "../../shared/types.ts";
import { audit } from "./audit.ts";
import { q, q1, tx, type Db } from "../db.ts";

type Seg = { id: string; ord: number; required: boolean; status: string; min_cov: number; completed_at: string | null; coords: LngLat[] };

/** The line a worker must walk: the stored geometry (the smooth line for curved segments). */
async function segments(assignmentId: string, db?: Db): Promise<Seg[]> {
  const rows = await q(
    `SELECT s.id, s.ord, s.required, s.status, s.completed_at, rs.min_coverage_ratio AS min_cov, ST_AsGeoJSON(rs.geom)::json AS g
       FROM assignment_segments s JOIN route_segments rs ON rs.id = s.route_segment_id
      WHERE s.assignment_id = $1 ORDER BY s.ord`,
    [assignmentId],
    db,
  );
  return rows.map((r) => ({
    id: r.id,
    ord: r.ord,
    required: r.required,
    status: r.status,
    min_cov: r.min_cov,
    completed_at: r.completed_at,
    coords: r.g.coordinates,
  }));
}

type Track = { id: string; points: GpsPoint[] };

async function verifiedTracks(assignmentId: string, db?: Db): Promise<Track[]> {
  const recs = await q(
    "SELECT id FROM recordings WHERE assignment_id = $1 AND status = 'server_verified' ORDER BY started_at_ms",
    [assignmentId],
    db,
  );
  return Promise.all(
    recs.map(async (r) => ({
      id: r.id as string,
      points: (await q(
        "SELECT seq, t_ms AS t, lat, lng, acc FROM gps_points WHERE recording_id = $1 ORDER BY seq",
        [r.id],
        db,
      )) as GpsPoint[],
    })),
  );
}

/**
 * Recomputes every segment from the GPS the server holds for verified recordings. The server is
 * authoritative: nothing the phone says about coverage is trusted.
 */
export async function refreshSegments(assignmentId: string, db?: Db) {
  const segs = await segments(assignmentId, db);
  const tracks = await verifiedTracks(assignmentId, db);
  const all = tracks.map((t) => t.points);

  await q(
    "DELETE FROM segment_evidence WHERE assignment_segment_id IN (SELECT id FROM assignment_segments WHERE assignment_id = $1)",
    [assignmentId],
    db,
  );
  for (const s of segs) {
    const m = coverageMask(s.coords, all, CONFIG.coverage);
    const cov = m.samples.length ? m.covered.filter(Boolean).length / m.samples.length : 0;
    if (s.status !== "skipped") {
      const status = cov >= s.min_cov ? "completed" : cov > 0 ? "in_progress" : "pending";
      await q(
        "UPDATE assignment_segments SET status = $1, coverage = $2, completed_at = CASE WHEN $1 = 'completed' THEN COALESCE(completed_at, now()) ELSE NULL END WHERE id = $3",
        [status, cov, s.id],
        db,
      );
    } else {
      await q("UPDATE assignment_segments SET coverage = $1 WHERE id = $2", [cov, s.id], db);
    }
    // which stretch of which recording was on this segment (for "jump to segment" in review)
    for (const t of tracks) {
      const tm = coverageMask(s.coords, [t.points], CONFIG.coverage);
      const c = tm.samples.length ? tm.covered.filter(Boolean).length / tm.samples.length : 0;
      const near = t.points.filter(
        (p) => p.acc <= CONFIG.coverage.maxAccuracyM && distToLineM([p.lng, p.lat], s.coords) <= CONFIG.coverage.bufferM,
      );
      if (c > 0 && near.length) {
        await q(
          "INSERT INTO segment_evidence (assignment_segment_id, recording_id, coverage, first_t_ms, last_t_ms) VALUES ($1,$2,$3,$4,$5)",
          [s.id, t.id, c, Math.min(...near.map((p) => p.t)), Math.max(...near.map((p) => p.t))],
          db,
        );
      }
    }
  }
}

/** The backend decides whether an assignment is complete. */
export async function finishAssignment(
  assignmentId: string,
  actorId: string | null,
  ip?: string,
): Promise<{ status: AssignmentStatus; reasons: string[] }> {
  return tx(async (c) => {
    await q("SELECT id FROM assignments WHERE id = $1 FOR UPDATE", [assignmentId], c);
    await refreshSegments(assignmentId, c);
    const segs = await q(
      "SELECT s.ord, s.required, s.status, s.coverage, rs.min_coverage_ratio AS min_cov FROM assignment_segments s JOIN route_segments rs ON rs.id = s.route_segment_id WHERE s.assignment_id = $1 ORDER BY s.ord",
      [assignmentId],
      c,
    );
    const recs = await q("SELECT status FROM recordings WHERE assignment_id = $1", [assignmentId], c);
    const geom = await segments(assignmentId, c);
    const quality = analyseQuality(
      (await verifiedTracks(assignmentId, c)).map((t) => t.points),
      geom.map((s) => s.coords),
    );
    const a = await q1("SELECT preflight FROM assignments WHERE id = $1", [assignmentId], c);

    const reasons: string[] = [];
    let status: AssignmentStatus;
    const unverified = recs.filter((r) => r.status !== "server_verified").length;
    const incomplete = segs.filter((s) => s.required && s.status !== "completed");

    if (recs.length === 0) {
      status = "in_progress";
      reasons.push("no recordings uploaded yet");
    } else if (unverified) {
      status = "pending_sync";
      reasons.push(`${unverified} recording(s) not yet verified by the server`);
    } else if (incomplete.length) {
      status = "in_progress";
      for (const s of incomplete)
        reasons.push(`required segment ${s.ord + 1}: covered ${(s.coverage * 100).toFixed(0)}%, needs ${(s.min_cov * 100).toFixed(0)}%`);
    } else {
      if (a?.preflight?.result === "skipped") reasons.push("GPS check was skipped");
      reasons.push(...qualityReasons(quality));
      if (await q1("SELECT 1 FROM recordings WHERE assignment_id = $1 AND simulated", [assignmentId], c))
        reasons.push("includes simulated (test) data");
      status = reasons.length ? "needs_review" : "completed";
    }
    await q(
      "UPDATE assignments SET status = $1, review_reasons = $2, quality = $3, updated_at = now(), completed_at = CASE WHEN $1 = 'completed' THEN COALESCE(completed_at, now()) ELSE NULL END WHERE id = $4",
      [status, JSON.stringify(reasons), JSON.stringify(quality), assignmentId],
      c,
    );
    await audit(actorId, "assignment_evaluated", { type: "assignment", id: assignmentId }, { status, reasons }, ip, c);
    return { status, reasons };
  });
}
