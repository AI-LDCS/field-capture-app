import { Router, type Request, type Response } from "express";
import { ZipArchive } from "archiver";
import { audit } from "../services/audit.ts";
import { kickAssembler } from "../services/assemble.ts";
import { q, q1 } from "../db.ts";
import { HttpError, notFound, uuidParam } from "../http.ts";
import { getObject } from "../services/storage.ts";
import { extOf, gpsExport, ready, sendGpsDownload, sendVideoDownload, variantOf } from "../services/downloads.ts";
import { detail } from "./assignments.ts";

/**
 * Admins can reach every file here: the original video, the anonymized copy (`?variant=anonymized`), and the GPS.
 * A worker gets only their own recordings from /api/me, anonymized by default; the anonymizer worker reads the
 * original through /api/anonymizer. Every view or download is audited.
 */
export const adminRecordingsRouter = Router();

const slug = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "route";

async function recording(req: Request) {
  const rec = await q1("SELECT * FROM recordings WHERE id = $1", [uuidParam(req, "id")]);
  if (!rec) throw notFound("recording not found");
  return rec;
}
const LIST_LIMIT = 1000;

/** Every verified recording, newest first, for the Downloads page. Bytes still go through the routes below. */
adminRecordingsRouter.get("/", async (_req, res) => {
  const rows = await q(
    `SELECT r.id, r.assignment_id, r.verified_at, r.started_at_ms, r.ended_at_ms, r.gps_count, r.file_bytes, r.assembly_state, r.simulated,
            r.anon_state, r.anon_bytes, r.anon_error, r.anon_attempts, r.frames_state, r.frames_count,
            u.id AS user_id, u.username, u.display_name, (u.deleted_at IS NOT NULL) AS user_deleted,
            v.name AS route_name, v.version, (rt.deleted_at IS NOT NULL) AS route_deleted
       FROM recordings r
       JOIN users u ON u.id = r.user_id
       JOIN assignments a ON a.id = r.assignment_id
       JOIN route_versions v ON v.id = a.route_version_id
       JOIN routes rt ON rt.id = v.route_id
      WHERE r.status = 'server_verified'
      ORDER BY r.verified_at DESC LIMIT ${LIST_LIMIT}`,
  );
  res.json(
    rows.map((r) => ({
      id: r.id,
      assignmentId: r.assignment_id,
      verifiedAt: r.verified_at,
      startedAtMs: Number(r.started_at_ms),
      endedAtMs: r.ended_at_ms === null ? null : Number(r.ended_at_ms),
      gpsCount: r.gps_count ?? 0,
      fileBytes: r.file_bytes === null ? null : Number(r.file_bytes),
      assembly: r.assembly_state,
      anonymization: r.anon_state,
      anonymizedBytes: r.anon_bytes === null ? null : Number(r.anon_bytes),
      frames: { state: r.frames_state, count: r.frames_count },
      simulated: r.simulated,
      worker: { id: r.user_id, username: r.username, displayName: r.display_name, deleted: r.user_deleted },
      route: { name: r.route_name, version: r.version, deleted: r.route_deleted },
    })),
  );
});

adminRecordingsRouter.get("/:id/gps", async (req, res) => {
  const rec = await recording(req);
  res.json(
    (await q("SELECT seq, t_ms, lat, lng, acc FROM gps_points WHERE recording_id = $1 ORDER BY seq", [rec.id])).map((p) => ({
      seq: p.seq,
      t: Number(p.t_ms),
      lat: p.lat,
      lng: p.lng,
      acc: p.acc,
    })),
  );
});

/** Range-aware proxy: browsers (iOS Safari especially) will not play video without real 206 responses. The original unless `?variant=anonymized`. */
adminRecordingsRouter.get("/:id/video", async (req: Request, res: Response) => {
  const rec = await recording(req);
  const variant = variantOf(req, "original");
  const file = ready(rec, variant);
  const range = typeof req.headers.range === "string" ? req.headers.range : undefined;
  let obj: Awaited<ReturnType<typeof getObject>>;
  try {
    obj = await getObject(file.key, range);
  } catch (e: any) {
    if (e?.$metadata?.httpStatusCode === 416) {
      res.status(416).set("Content-Range", `bytes */${file.bytes}`).end();
      return;
    }
    throw e;
  }
  if (!range || /^bytes=0-/.test(range))
    await audit(req.user!.id, "recording_viewed", { type: "recording", id: rec.id }, { variant }, req.ip);
  res.status(obj.status).set({
    "Content-Type": rec.file_mime,
    "Accept-Ranges": "bytes",
    "Content-Length": String(obj.length),
    "Cache-Control": "private, no-store",
  });
  if (obj.contentRange) res.set("Content-Range", obj.contentRange);
  res.on("close", () => obj.body.destroy());
  obj.body.pipe(res);
});

/** The original unless `?variant=anonymized`. */
adminRecordingsRouter.get("/:id/download", async (req, res) => {
  await sendVideoDownload(req, res, await recording(req), variantOf(req, "original"));
});

adminRecordingsRouter.get("/:id/gps.json", async (req, res) => {
  await sendGpsDownload(req, res, await recording(req));
});

/** Try the build again after a failure (the chunks are still there until it succeeds). */
adminRecordingsRouter.post("/:id/reassemble", async (req, res) => {
  const rec = await recording(req);
  if (rec.status !== "server_verified" || rec.chunks_purged) throw new HttpError(409, "cannot_reassemble", "nothing to rebuild");
  await q("UPDATE recordings SET assembly_state = 'pending', assembly_error = NULL WHERE id = $1 AND assembly_state = 'failed'", [rec.id]);
  void kickAssembler();
  res.json({ ok: true });
});

/** Queue the anonymized copy again after it failed (or if it was never queued). The attempts start over. */
adminRecordingsRouter.post("/:id/reanonymize", async (req, res) => {
  const rec = await recording(req);
  if (rec.status !== "server_verified" || rec.assembly_state !== "done" || !["failed", "none"].includes(rec.anon_state))
    throw new HttpError(409, "cannot_reanonymize", "only a built recording whose anonymized copy failed can be queued again");
  await q("UPDATE recordings SET anon_state = 'pending', anon_attempts = 0, anon_error = NULL WHERE id = $1", [rec.id]);
  await audit(req.user!.id, "recording_anonymize_requeued", { type: "recording", id: rec.id }, undefined, req.ip);
  res.json({ ok: true });
});

// ---------- per-assignment export ----------
export const adminExportRouter = Router();

async function runExport(assignmentId: string) {
  const d = await detail(assignmentId);
  if (!d) throw notFound("assignment not found");
  const recs = await q("SELECT * FROM recordings WHERE assignment_id = $1 AND status = 'server_verified' ORDER BY started_at_ms", [
    assignmentId,
  ]);
  const exp = {
    exportedAt: new Date().toISOString(),
    assignment: {
      id: d.id,
      status: d.status,
      reasons: d.reasons,
      createdAt: d.createdAt,
      completedAt: d.completedAt,
      preflight: d.preflight,
      gpsQuality: d.quality,
    },
    worker: d.worker,
    route: d.route,
    routeGeoJSON: {
      type: "FeatureCollection",
      features: d.segments.map((s) => ({
        type: "Feature",
        geometry: { type: "LineString", coordinates: s.coords },
        properties: {
          order: s.order,
          name: s.name,
          required: s.required,
          status: s.status,
          skipReason: s.skipReason,
          coverage: s.coverage,
          minCoverageRatio: s.minCoverageRatio,
        },
      })),
    },
    recordings: await Promise.all(
      recs.map(async (r, i) => ({
        index: i + 1,
        id: r.id,
        bytes: r.file_bytes === null ? null : Number(r.file_bytes),
        sha256: r.file_sha256,
        file: r.assembly_state === "done" ? `recording-${i + 1}-${r.id.slice(0, 8)}.${extOf(r.mime)}` : null,
        anonymizedBytes: r.anon_bytes === null ? null : Number(r.anon_bytes),
        anonymizedSha256: r.anon_sha256,
        anonymizedFile: r.anon_state === "done" ? `recording-${i + 1}-${r.id.slice(0, 8)}-anonymized.${extOf(r.mime)}` : null,
        ...(await gpsExport(r)),
      })),
    ),
    audit: await q(
      "SELECT at, action, target_type, target_id, details FROM audit_log WHERE target_id = $1 OR target_id = ANY($2::text[]) ORDER BY id",
      [assignmentId, recs.map((r) => r.id)],
    ),
  };
  return { d, recs, exp };
}

adminExportRouter.get("/:id/export.json", async (req, res) => {
  const { d, exp } = await runExport(uuidParam(req, "id"));
  await audit(req.user!.id, "assignment_exported", { type: "assignment", id: d.id }, { format: "json" }, req.ip);
  res
    .attachment(`${slug(d.route.name)}-${d.id.slice(0, 8)}.json`)
    .type("json")
    .send(JSON.stringify(exp, null, 2));
});

/** Streams from storage into the zip one file at a time (the original, then its anonymized copy); never holds a video in memory. */
adminExportRouter.get("/:id/export.zip", async (req, res) => {
  const { d, recs, exp } = await runExport(uuidParam(req, "id"));
  if (!recs.length) throw new HttpError(409, "nothing_to_export", "no verified recordings to download");
  const dir = `${slug(d.route.name)}-${d.id.slice(0, 8)}`;
  await audit(req.user!.id, "assignment_exported", { type: "assignment", id: d.id }, { format: "zip", recordings: recs.length }, req.ip);
  res.attachment(`${dir}.zip`).type("zip");
  const zip = new ZipArchive({ store: true }); // video is already compressed
  zip.on("error", (e: Error) => res.destroy(e));
  res.on("close", () => zip.abort());
  zip.pipe(res);
  zip.append(JSON.stringify(exp, null, 2), { name: `${dir}/assignment.json` });
  for (const r of exp.recordings) {
    zip.append(JSON.stringify(await gpsExport(recs[r.index - 1]), null, 2), { name: `${dir}/gps-${r.index}-${r.id.slice(0, 8)}.json` });
    for (const [name, key] of [
      [r.file, recs[r.index - 1].file_key],
      [r.anonymizedFile, recs[r.index - 1].anon_key],
    ] as const) {
      if (!name || !key) continue;
      const obj = await getObject(key);
      const done = new Promise((resolve) => zip.once("entry", resolve));
      zip.append(obj.body, { name: `${dir}/${name}` });
      await done; // next video only after this one is fully written
    }
  }
  void zip.finalize();
});
