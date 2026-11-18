import { Router, type Request, type Response } from "express";
import { ZipArchive } from "archiver";
import { audit } from "../services/audit.ts";
import { config } from "../config.ts";
import { q, q1 } from "../db.ts";
import { HttpError, notFound, uuidParam } from "../http.ts";
import { appendImages, framesDocument, manifestCsv, recordingIndex, rerunAssignmentFrames } from "../services/frames.ts";
import { getObject } from "../services/storage.ts";
import { detail } from "./assignments.ts";

/**
 * The still images of a recording, for admins: the list with every image's metadata (the shape a scoring engine
 * reads), one image, and ZIPs per recording, assignment and route. Admins can reach every purpose; a worker only
 * their own training images (routes/workerFrames.ts). ZIP downloads are audited; single images are not, because
 * a page of thumbnails would write one audit row per image.
 */
export const adminFramesRecordingRouter = Router();
export const adminFramesAssignmentRouter = Router();
export const adminFramesRouteRouter = Router();

const slug = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "route";

/** The assignment facts a frames.json carries. */
async function assignmentOf(assignmentId: string) {
  const a = await q1(
    `SELECT a.id, a.purpose, v.id AS "routeVersionId", v.route_id AS "routeId", v.name, v.version
       FROM assignments a JOIN route_versions v ON v.id = a.route_version_id WHERE a.id = $1`,
    [assignmentId],
  );
  return a as { id: string; purpose: string; routeVersionId: string; routeId: string; name: string; version: number };
}

async function verified(req: Request) {
  const rec = await q1("SELECT * FROM recordings WHERE id = $1", [uuidParam(req, "id")]);
  if (!rec) throw notFound("recording not found");
  if (rec.status !== "server_verified") throw new HttpError(409, "not_verified", "this recording is not verified yet");
  return rec;
}

function startZip(res: Response, filename: string) {
  res.attachment(filename).type("zip");
  const zip = new ZipArchive({ store: true }); // PNG is already compressed
  zip.on("error", (e: Error) => res.destroy(e));
  res.on("close", () => zip.abort());
  zip.pipe(res);
  return zip;
}

/** One recording's folder: frames.json, manifest.csv, images/. Returns the number of images. */
async function appendRecording(zip: ZipArchive, dir: string, rec: any, a: Awaited<ReturnType<typeof assignmentOf>>, index: number) {
  const doc = await framesDocument(rec, a, index);
  zip.append(JSON.stringify(doc, null, 2), { name: `${dir}/frames.json` });
  zip.append(manifestCsv(doc.frames), { name: `${dir}/manifest.csv` });
  await appendImages(zip, `${dir}/images`, rec.id);
  return doc.frames.length;
}

/** An assignment's folder: assignment.json, then one folder per recording that has images. Returns the number of images. */
async function appendAssignment(zip: ZipArchive, dir: string, assignmentId: string) {
  const a = await assignmentOf(assignmentId);
  const recs = await q("SELECT * FROM recordings WHERE assignment_id = $1 AND status = 'server_verified' ORDER BY started_at_ms", [
    assignmentId,
  ]);
  const summary = [];
  let total = 0;
  for (const [i, r] of recs.entries()) {
    const sub = `${dir}/recording-${i + 1}-${r.id.slice(0, 8)}`;
    const doc = await framesDocument(r, a, i + 1);
    summary.push({
      index: i + 1,
      recordingId: r.id,
      startedAt: new Date(Number(r.started_at_ms)).toISOString(),
      endedAt: r.ended_at_ms === null ? null : new Date(Number(r.ended_at_ms)).toISOString(),
      stopReason: r.stop_reason,
      state: r.frames_state,
      frames: doc.frames.length,
      stepM: doc.stepM,
      timeWarning: doc.timeWarning,
    });
    if (r.frames_state !== "done") continue;
    total += await appendRecording(zip, sub, r, a, i + 1);
  }
  zip.append(
    JSON.stringify(
      { assignmentId: a.id, routeId: a.routeId, routeVersionId: a.routeVersionId, purpose: a.purpose, recordings: summary },
      null,
      2,
    ),
    { name: `${dir}/assignment.json` },
  );
  return total;
}

async function routeJson(assignmentId: string) {
  const d = await detail(assignmentId);
  if (!d) throw notFound("assignment not found");
  return {
    routeId: d.route.id,
    name: d.route.name,
    versionId: d.route.versionId,
    version: d.route.version,
    geojson: {
      type: "FeatureCollection",
      features: d.segments.map((s) => ({
        type: "Feature",
        geometry: { type: "LineString", coordinates: s.coords },
        properties: { order: s.order, name: s.name, required: s.required },
      })),
    },
  };
}

const framesDone = async (assignmentId: string) =>
  (await q1("SELECT count(*)::int AS n FROM recordings WHERE assignment_id = $1 AND frames_state = 'done'", [assignmentId])).n as number;

// ---------- one recording ----------

/** The state of the job and, once it is done, every image with its metadata. */
adminFramesRecordingRouter.get("/:id/frames", async (req, res) => {
  const rec = await verified(req);
  const a = await assignmentOf(rec.assignment_id);
  const doc = await framesDocument(rec, a, await recordingIndex(rec));
  res.json({ state: rec.frames_state, error: rec.frames_error, ...doc });
});

adminFramesRecordingRouter.get("/:id/frames.zip", async (req, res) => {
  const rec = await verified(req);
  if (rec.frames_state !== "done") throw new HttpError(409, "no_frames", `there are no images for this recording (${rec.frames_state})`);
  const a = await assignmentOf(rec.assignment_id);
  const index = await recordingIndex(rec);
  const dir = `${slug(a.name)}-${a.id.slice(0, 8)}-recording-${index}-${rec.id.slice(0, 8)}`;
  await audit(
    req.user!.id,
    "frames_downloaded",
    { type: "recording", id: rec.id },
    { scope: "recording", count: rec.frames_count },
    req.ip,
  );
  const zip = startZip(res, `${dir}.zip`);
  await appendRecording(zip, dir, rec, a, index);
  void zip.finalize();
});

adminFramesRecordingRouter.get("/:id/frames/:frame", async (req, res) => {
  const rec = await verified(req);
  const n = Number(req.params.frame);
  if (!Number.isInteger(n) || n < 0) throw notFound("image not found");
  const f = await q1("SELECT file_key, file_name FROM recording_frames WHERE recording_id = $1 AND frame = $2", [rec.id, n]);
  if (!f) throw notFound("image not found");
  const obj = await getObject(f.file_key);
  res.set({ "Content-Type": "image/png", "Content-Length": String(obj.length), "Cache-Control": "private, max-age=300" });
  res.on("close", () => obj.body.destroy());
  obj.body.pipe(res);
});

// ---------- one assignment ----------

adminFramesAssignmentRouter.get("/:id/frames.zip", async (req, res) => {
  const id = uuidParam(req, "id");
  if (!(await q1("SELECT 1 FROM assignments WHERE id = $1", [id]))) throw notFound("assignment not found");
  if (!(await framesDone(id))) throw new HttpError(409, "no_frames", "none of this assignment's recordings has images yet");
  const a = await assignmentOf(id);
  const dir = `${slug(a.name)}-v${a.version}-${a.id.slice(0, 8)}`;
  await audit(req.user!.id, "frames_downloaded", { type: "assignment", id }, { scope: "assignment" }, req.ip);
  const zip = startZip(res, `${dir}.zip`);
  zip.append(JSON.stringify(await routeJson(id), null, 2), { name: `${dir}/route.json` });
  await appendAssignment(zip, `${dir}/assignment-${id.slice(0, 8)}`, id);
  void zip.finalize();
});

/**
 * Throws away this assignment's images and makes them again, with the current SAMPLE_STEP_M. Every recording is queued
 * in order, because each one carries on from the one before it.
 */
adminFramesAssignmentRouter.post("/:id/frames/rerun", async (req, res) => {
  const id = uuidParam(req, "id");
  if (!(await q1("SELECT 1 FROM assignments WHERE id = $1", [id]))) throw notFound("assignment not found");
  if (!config.frames.enabled) throw new HttpError(409, "frames_disabled", "FRAMES_ENABLED is off on this server");
  const queued = await rerunAssignmentFrames(id, req.user!.id, req.ip);
  if (!queued) throw new HttpError(409, "nothing_to_queue", "no built recording to make images from");
  res.json({ ok: true, queued, stepM: config.frames.stepM });
});

// ---------- one route ----------

/** Every assignment of the route that has images, grouped by route version: v<version>/route.json and assignment folders. */
adminFramesRouteRouter.get("/:id/frames.zip", async (req, res) => {
  const id = uuidParam(req, "id");
  const route = await q1(
    "SELECT r.id, (SELECT name FROM route_versions WHERE route_id = r.id ORDER BY version DESC LIMIT 1) AS name FROM routes r WHERE r.id = $1",
    [id],
  );
  if (!route) throw notFound("route not found");
  const assignments = await q(
    `SELECT a.id, v.version FROM assignments a JOIN route_versions v ON v.id = a.route_version_id
      WHERE v.route_id = $1 AND EXISTS (SELECT 1 FROM recordings r WHERE r.assignment_id = a.id AND r.frames_state = 'done')
      ORDER BY v.version, a.created_at`,
    [id],
  );
  if (!assignments.length) throw new HttpError(409, "no_frames", "none of this route's assignments has images yet");
  const dir = `route-${id.slice(0, 8)}-${slug(route.name ?? "route")}`;
  await audit(req.user!.id, "frames_downloaded", { type: "route", id }, { scope: "route", assignments: assignments.length }, req.ip);
  const zip = startZip(res, `${dir}.zip`);
  zip.append(
    JSON.stringify(
      { routeId: id, name: route.name, assignments: assignments.map((a) => ({ assignmentId: a.id, version: a.version })) },
      null,
      2,
    ),
    { name: `${dir}/index.json` },
  );
  const seen = new Set<number>();
  for (const a of assignments) {
    if (!seen.has(a.version)) {
      seen.add(a.version);
      zip.append(JSON.stringify(await routeJson(a.id), null, 2), { name: `${dir}/v${a.version}/route.json` });
    }
    await appendAssignment(zip, `${dir}/v${a.version}/assignment-${a.id.slice(0, 8)}`, a.id);
  }
  void zip.finalize();
});
