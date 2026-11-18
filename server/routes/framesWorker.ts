import { Router, type Request } from "express";
import { z } from "zod";
import { audit } from "../services/audit.ts";
import { config } from "../config.ts";
import { q, q1 } from "../db.ts";
import { HttpError, notFound, uuidParam } from "../http.ts";
import { extOf, gpsExport } from "../services/downloads.ts";
import { dropFrameData, expireFrameLeases, framesPrefix, recordingIndex } from "../services/frames.ts";
import { deleteObjects, getObject, putStream } from "../services/storage.ts";

/**
 * What the GPU worker calls to make still images: claim a recording, read the video, report that it is still working,
 * upload each anonymized image, say it is complete, or give up. Same rules as routes/anonymizer.ts: bearer token only,
 * and every call after the claim carries the `x-lease-id` the claim returned. Mounted under /api/anonymizer/frames.
 */
export const framesWorkerRouter = Router();

const leaseSeconds = () => config.anonymizer.leaseMinutes * 60;

async function held(req: Request) {
  const lease = String(req.header("x-lease-id") ?? "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(lease))
    throw new HttpError(400, "bad_lease", "send the x-lease-id from the claim");
  const rec = await q1("SELECT * FROM recordings WHERE id = $1", [uuidParam(req, "id")]);
  if (!rec) throw notFound("recording not found");
  if (rec.frames_state !== "running") throw new HttpError(409, "not_claimed", `this recording is not claimed (${rec.frames_state})`);
  if (rec.frames_lease_id !== lease.toLowerCase() || new Date(rec.frames_lease_until).getTime() < Date.now())
    throw new HttpError(409, "lease_lost", "this claim ran out or belongs to another worker");
  return { rec, lease: lease.toLowerCase() };
}

/**
 * Takes the oldest recording that is ready, or answers 204. A recording is ready when it is built and every earlier
 * recording of its assignment has finished (or was never queued): the distance counter and frame numbers carry on
 * from one recording to the next, so they must be made in order.
 */
framesWorkerRouter.post("/claim", async (req, res) => {
  await expireFrameLeases();
  const rec = await q1(
    `UPDATE recordings SET frames_state = 'running', frames_attempts = frames_attempts + 1, frames_error = NULL,
            frames_lease_id = gen_random_uuid(), frames_lease_until = now() + make_interval(secs => $1)
      WHERE id = (SELECT r.id FROM recordings r
                   WHERE r.frames_state = 'pending' AND r.assembly_state = 'done' AND r.status = 'server_verified'
                     AND NOT EXISTS (SELECT 1 FROM recordings p
                                      WHERE p.assignment_id = r.assignment_id AND p.status = 'server_verified'
                                        AND p.started_at_ms < r.started_at_ms AND p.frames_state IN ('pending', 'running'))
                   ORDER BY r.verified_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    [leaseSeconds()],
  );
  if (!rec) return void res.status(204).end();
  await dropFrameData(rec.id); // nothing from an earlier, abandoned attempt may stay
  const a = await q1(
    `SELECT a.id, a.purpose, v.id AS route_version_id, v.route_id FROM assignments a JOIN route_versions v ON v.id = a.route_version_id WHERE a.id = $1`,
    [rec.assignment_id],
  );
  const prev = await q1(
    `SELECT frames_state, frames_carry FROM recordings WHERE assignment_id = $1 AND status = 'server_verified' AND started_at_ms < $2
      ORDER BY started_at_ms DESC LIMIT 1`,
    [rec.assignment_id, rec.started_at_ms],
  );
  const gps = await gpsExport(rec);
  await audit(null, "recording_frames_started", { type: "recording", id: rec.id }, { attempt: rec.frames_attempts }, req.ip);
  res.json({
    id: rec.id,
    leaseId: rec.frames_lease_id,
    leaseSeconds: leaseSeconds(),
    attempt: rec.frames_attempts,
    ext: extOf(rec.mime),
    mime: rec.file_mime,
    bytes: Number(rec.file_bytes),
    sha256: rec.file_sha256,
    stepM: config.frames.stepM,
    gapMaxM: config.frames.gapMaxM,
    purpose: a.purpose,
    embed: a.purpose === "inference", // GPS and IDs are written into the images only for inference
    assignmentId: a.id,
    routeId: a.route_id,
    routeVersionId: a.route_version_id,
    recordingId: rec.id,
    recordingIndex: await recordingIndex(rec),
    carry: prev?.frames_state === "done" ? prev.frames_carry : null, // not "done" before it: no counter to carry on from
    timeUncertain: gps.timeWarning !== null,
    gps: gps.points,
  });
});

/** The original video, streamed. Only for the worker that holds the claim. */
framesWorkerRouter.get("/:id/source", async (req, res) => {
  const { rec } = await held(req);
  const obj = await getObject(rec.file_key);
  res.set({ "Content-Type": rec.file_mime, "Content-Length": String(obj.length), "Cache-Control": "private, no-store" });
  res.on("close", () => obj.body.destroy());
  obj.body.pipe(res);
});

/** "Still working": pushes the lease out again. */
framesWorkerRouter.post("/:id/heartbeat", async (req, res) => {
  const { rec, lease } = await held(req);
  await q("UPDATE recordings SET frames_lease_until = now() + make_interval(secs => $1) WHERE id = $2 AND frames_lease_id = $3", [
    leaseSeconds(),
    rec.id,
    lease,
  ]);
  res.json({ ok: true, leaseSeconds: leaseSeconds() });
});

const FILE_NAME = /^[A-Za-z0-9._-]{1,120}$/;
const num = z.number().finite();
const frameMeta = z.object({
  frame: z.number().int().min(0).max(1_000_000),
  bin: z.number().int().min(0),
  file: z.string().regex(FILE_NAME),
  timestamp: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "not a date"),
  videoTimeS: num,
  walkedStartM: num,
  walkedEndM: num,
  latitude: num.min(-90).max(90),
  longitude: num.min(-180).max(180),
  accuracyM: num.min(0),
  headingDeg: num.min(0).max(360).nullable(),
  sharpness: num,
  lowSharpness: z.boolean(),
  timeUncertain: z.boolean(),
  afterGap: z.boolean(),
  gapM: num.nullable(),
});

/**
 * One anonymized image, as raw PNG bytes; its metadata is in the `x-frame` header (URL-encoded JSON). The image goes
 * into storage as it arrives and is checked against the length and SHA-256 the worker sent. Sending the same frame
 * again replaces it, so a retry is harmless.
 */
framesWorkerRouter.put("/:id/image/:frame", async (req, res) => {
  const { rec, lease } = await held(req);
  const claimedHash = String(req.header("x-sha256") ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(claimedHash)) throw new HttpError(400, "bad_checksum", "send x-sha256: the hex SHA-256 of the body");
  const claimedLength = Number(req.header("content-length"));
  if (!Number.isInteger(claimedLength) || claimedLength <= 0) throw new HttpError(411, "length_required", "send a Content-Length");
  let meta: z.infer<typeof frameMeta>;
  try {
    meta = frameMeta.parse(JSON.parse(decodeURIComponent(String(req.header("x-frame") ?? ""))));
  } catch {
    throw new HttpError(400, "bad_frame", "x-frame must be the frame's metadata as URL-encoded JSON");
  }
  if (meta.frame !== Number(req.params.frame))
    throw new HttpError(400, "bad_frame", "the frame number in x-frame is not the one in the path");

  const key = `${framesPrefix(rec.id)}${lease}/${String(meta.frame).padStart(5, "0")}.png`;
  const stored = await putStream(key, "image/png", req, config.anonymizer.partBytes, (bytes, sha256) => {
    if (bytes !== claimedLength) throw new HttpError(422, "size_mismatch", "the body is not as long as Content-Length said");
    if (sha256 !== claimedHash) throw new HttpError(422, "checksum_mismatch", "checksum does not match the data");
  });
  // the claim may have been lost while the bytes were arriving; then this file is nobody's
  const ok = await q1(
    `INSERT INTO recording_frames (recording_id, frame, bin, file_name, file_key, file_bytes, file_sha256, taken_at, video_time_s,
            walked_start_m, walked_end_m, latitude, longitude, accuracy_m, heading_deg, sharpness, low_sharpness, time_uncertain, after_gap, gap_m)
     SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20
      WHERE EXISTS (SELECT 1 FROM recordings WHERE id = $1 AND frames_state = 'running' AND frames_lease_id = $21)
     ON CONFLICT (recording_id, frame) DO UPDATE SET bin = EXCLUDED.bin, file_name = EXCLUDED.file_name, file_key = EXCLUDED.file_key,
            file_bytes = EXCLUDED.file_bytes, file_sha256 = EXCLUDED.file_sha256, taken_at = EXCLUDED.taken_at,
            video_time_s = EXCLUDED.video_time_s, walked_start_m = EXCLUDED.walked_start_m, walked_end_m = EXCLUDED.walked_end_m,
            latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude, accuracy_m = EXCLUDED.accuracy_m,
            heading_deg = EXCLUDED.heading_deg, sharpness = EXCLUDED.sharpness, low_sharpness = EXCLUDED.low_sharpness,
            time_uncertain = EXCLUDED.time_uncertain, after_gap = EXCLUDED.after_gap, gap_m = EXCLUDED.gap_m
     RETURNING frame`,
    [
      rec.id,
      meta.frame,
      meta.bin,
      meta.file,
      key,
      stored.bytes,
      stored.sha256,
      meta.timestamp,
      meta.videoTimeS,
      meta.walkedStartM,
      meta.walkedEndM,
      meta.latitude,
      meta.longitude,
      meta.accuracyM,
      meta.headingDeg,
      meta.sharpness,
      meta.lowSharpness,
      meta.timeUncertain,
      meta.afterGap,
      meta.gapM,
      lease,
    ],
  );
  if (!ok) {
    await deleteObjects([key]);
    throw new HttpError(409, "lease_lost", "this claim ran out while the image was uploading");
  }
  res.json({ ok: true });
});

const completeSchema = z.object({
  count: z.number().int().min(1).max(1_000_000),
  stepM: z.number().min(1).max(50),
  mode: z.string().regex(/^[a-z]{3,20}$/),
  carry: z.object({ cumM: num, nextFrame: z.number().int().min(0), lastLat: num.min(-90).max(90), lastLng: num.min(-180).max(180) }),
});

/** The worker has sent every image. The recording counts as done only if the server holds exactly that many. */
framesWorkerRouter.post("/:id/complete", async (req, res) => {
  const body = completeSchema.parse(req.body);
  const { rec, lease } = await held(req);
  const have = (await q1("SELECT count(*)::int AS n FROM recording_frames WHERE recording_id = $1", [rec.id])).n as number;
  if (have !== body.count) throw new HttpError(422, "incomplete", `the worker says ${body.count} images, the server holds ${have}`);
  const done = await q1(
    `UPDATE recordings SET frames_state = 'done', frames_count = $1, frames_step_m = $2, frames_mode = $3, frames_carry = $4,
            frames_error = NULL, frames_lease_id = NULL, frames_lease_until = NULL, frames_at = now()
      WHERE id = $5 AND frames_state = 'running' AND frames_lease_id = $6 RETURNING frames_attempts`,
    [body.count, body.stepM, body.mode, JSON.stringify(body.carry), rec.id, lease],
  );
  if (!done) throw new HttpError(409, "lease_lost", "this claim ran out before it was completed");
  await audit(
    null,
    "recording_frames_done",
    { type: "recording", id: rec.id },
    { count: body.count, stepM: body.stepM, mode: body.mode, attempts: done.frames_attempts },
    req.ip,
  );
  res.json({ ok: true });
});

const failSchema = z.object({ error: z.string().max(500).default("unknown error") });

/** The worker could not make the images. It goes back in the queue until it has used all its attempts, then it is failed. */
framesWorkerRouter.post("/:id/fail", async (req, res) => {
  const { error } = failSchema.parse(req.body);
  const { rec, lease } = await held(req);
  const retry = rec.frames_attempts < config.anonymizer.maxAttempts;
  await q(
    "UPDATE recordings SET frames_state = $1, frames_error = $2, frames_lease_id = NULL, frames_lease_until = NULL WHERE id = $3 AND frames_lease_id = $4",
    [retry ? "pending" : "failed", error, rec.id, lease],
  );
  await audit(null, "recording_frames_failed", { type: "recording", id: rec.id }, { error, attempts: rec.frames_attempts, retry }, req.ip);
  res.json({ ok: true, retry });
});
