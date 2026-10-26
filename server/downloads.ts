import type { Request, Response } from "express";
import { audit } from "./audit.ts";
import { q } from "./db.ts";
import { HttpError } from "./http.ts";
import { getObject } from "./storage.ts";

/** Shared by the admin and worker download routes: what is ready, what a file is called, and how it is sent. */
export const extOf = (mime: string) => (String(mime).includes("mp4") ? "mp4" : "webm");

export function ready(rec: any) {
  if (rec.status !== "server_verified") throw new HttpError(409, "not_verified", "this recording is not verified yet");
  if (rec.assembly_state !== "done" || !rec.file_key) throw new HttpError(409, "not_ready", `the video is still being prepared (${rec.assembly_state})`);
}

/** GPS with wall-clock and video-relative time so it can be matched to the footage. */
export async function gpsExport(rec: any) {
  const pts = await q("SELECT seq, t_ms, lat, lng, acc FROM gps_points WHERE recording_id = $1 ORDER BY seq", [rec.id]);
  const start = Number(rec.started_at_ms);
  return {
    recordingId: rec.id, assignmentId: rec.assignment_id, mime: rec.mime, simulated: rec.simulated,
    videoStartedAt: new Date(start).toISOString(), videoStartedAtMs: start,
    note: "videoTimeS = seconds from the start of the video file; approximate (camera and GPS delay under about 1 s)",
    points: pts.map((p) => ({
      seq: p.seq, timestamp: new Date(Number(p.t_ms)).toISOString(), timestampMs: Number(p.t_ms),
      latitude: p.lat, longitude: p.lng, accuracyM: p.acc, videoTimeS: Number(((Number(p.t_ms) - start) / 1000).toFixed(3)),
    })),
  };
}

/** The assembled video as an attachment, audited. `rec` must already be checked for access. */
export async function sendVideoDownload(req: Request, res: Response, rec: any) {
  ready(rec);
  const obj = await getObject(rec.file_key);
  await audit(req.user!.id, "recording_downloaded", { type: "recording", id: rec.id }, req.user!.role === "admin" ? undefined : { by: "worker" }, req.ip);
  res.set({ "Content-Type": rec.file_mime, "Content-Length": String(obj.length), "Content-Disposition": `attachment; filename="recording-${rec.id.slice(0, 8)}.${extOf(rec.mime)}"` });
  res.on("close", () => obj.body.destroy());
  obj.body.pipe(res);
}

/** The GPS file as an attachment, audited. `rec` must already be checked for access. */
export async function sendGpsDownload(req: Request, res: Response, rec: any) {
  if (rec.status !== "server_verified") throw new HttpError(409, "not_verified", "this recording is not verified yet");
  await audit(req.user!.id, "gps_downloaded", { type: "recording", id: rec.id }, req.user!.role === "admin" ? undefined : { by: "worker" }, req.ip);
  res.attachment(`gps-${rec.id.slice(0, 8)}.json`).type("json").send(JSON.stringify(await gpsExport(rec), null, 2));
}
