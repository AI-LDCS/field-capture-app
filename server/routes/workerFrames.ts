import { Router, type Request } from "express";
import { ZipArchive } from "archiver";
import { audit } from "../services/audit.ts";
import { q, q1 } from "../db.ts";
import { HttpError, notFound, uuidParam } from "../http.ts";
import { appendImages, framesDocument, recordingIndex } from "../services/frames.ts";

/**
 * A worker's own images, only for assignments made for training (they label them in CVAT). For an inference
 * assignment, and for anyone else's recording, every route here is a 404, as if it did not exist.
 * The ZIP holds the images only: no GPS, no IDs.
 */
export const workerFramesRecordingRouter = Router();
export const workerFramesAssignmentRouter = Router();

const slug = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "route";

async function ownedTraining(req: Request) {
  const rec = await q1(
    `SELECT r.* FROM recordings r JOIN assignments a ON a.id = r.assignment_id
      WHERE r.id = $1 AND r.user_id = $2 AND r.status = 'server_verified' AND a.purpose = 'training'`,
    [uuidParam(req, "id"), req.user!.id],
  );
  if (!rec) throw notFound("recording not found");
  return rec;
}

/** Progress and the list of images (what the page shows). Without GPS: that is not for the labeller. */
workerFramesRecordingRouter.get("/:id/frames", async (req, res) => {
  const rec = await ownedTraining(req);
  const a = await q1(
    `SELECT a.id, a.purpose, v.id AS "routeVersionId", v.route_id AS "routeId" FROM assignments a JOIN route_versions v ON v.id = a.route_version_id WHERE a.id = $1`,
    [rec.assignment_id],
  );
  const doc = await framesDocument(rec, a, await recordingIndex(rec));
  res.json({
    state: rec.frames_state,
    count: doc.frames.length,
    stepM: doc.stepM,
    frames: doc.frames.map((f) => ({ frame: f.frame, file: f.file.replace("images/", ""), bytes: f.bytes })),
  });
});

workerFramesRecordingRouter.get("/:id/frames.zip", async (req, res) => {
  const rec = await ownedTraining(req);
  if (rec.frames_state !== "done")
    throw new HttpError(409, "no_frames", `there are no images for this recording yet (${rec.frames_state})`);
  const dir = `images-${rec.id.slice(0, 8)}`;
  await audit(
    req.user!.id,
    "frames_downloaded",
    { type: "recording", id: rec.id },
    { scope: "recording", by: "worker", count: rec.frames_count },
    req.ip,
  );
  res.attachment(`${dir}.zip`).type("zip");
  const zip = new ZipArchive({ store: true });
  zip.on("error", (e: Error) => res.destroy(e));
  res.on("close", () => zip.abort());
  zip.pipe(res);
  await appendImages(zip, dir, rec.id);
  void zip.finalize();
});

/** All images of the assignment in one folder, named so that they sort in walking order: 01-..., 02-... by recording. */
workerFramesAssignmentRouter.get("/:id/frames.zip", async (req, res) => {
  const id = uuidParam(req, "id");
  const a = await q1(
    `SELECT a.id, v.name FROM assignments a JOIN route_versions v ON v.id = a.route_version_id
      WHERE a.id = $1 AND a.user_id = $2 AND a.purpose = 'training'`,
    [id, req.user!.id],
  );
  if (!a) throw notFound("assignment not found");
  const recs = await q(
    "SELECT id, frames_count FROM recordings WHERE assignment_id = $1 AND status = 'server_verified' AND frames_state = 'done' ORDER BY started_at_ms",
    [id],
  );
  if (!recs.length) throw new HttpError(409, "no_frames", "none of this assignment's recordings has images yet");
  const dir = `${slug(a.name)}-${id.slice(0, 8)}-images`;
  await audit(
    req.user!.id,
    "frames_downloaded",
    { type: "assignment", id },
    { scope: "assignment", by: "worker", recordings: recs.length },
    req.ip,
  );
  res.attachment(`${dir}.zip`).type("zip");
  const zip = new ZipArchive({ store: true });
  zip.on("error", (e: Error) => res.destroy(e));
  res.on("close", () => zip.abort());
  zip.pipe(res);
  for (const [i, r] of recs.entries()) await appendImages(zip, dir, r.id, `${String(i + 1).padStart(2, "0")}-`);
  void zip.finalize();
});
