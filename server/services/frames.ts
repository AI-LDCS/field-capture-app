import { ZipArchive } from "archiver";
import { audit } from "./audit.ts";
import { config } from "../config.ts";
import { q, q1 } from "../db.ts";
import { timeCheck } from "../../shared/timing.ts";
import { deleteObjects, getObject, listKeys } from "./storage.ts";

/**
 * Still images cut from a finished video. The GPU worker samples the video (the sharpest frame every SAMPLE_STEP_M
 * metres walked), anonymizes the frames and uploads them; this file keeps that queue honest, deletes frames, queues a
 * re-run, and turns rows into the JSON and ZIP layouts people download. The queue copies the one in anonymize.ts:
 * a claim is a lease, and a worker that goes quiet loses it. Claiming, uploading and failing: routes/framesWorker.ts.
 */
export const framesPrefix = (recordingId: string) => `rec/${recordingId}/frames-`;

/** Gives claims that ran out of time back to the queue, or fails them once they have used all their attempts. */
export async function expireFrameLeases() {
  const failed = await q(
    `UPDATE recordings SET frames_state = 'failed', frames_error = 'the worker stopped answering', frames_lease_id = NULL, frames_lease_until = NULL
      WHERE frames_state = 'running' AND frames_lease_until < now() AND frames_attempts >= $1 RETURNING id, frames_attempts`,
    [config.anonymizer.maxAttempts],
  );
  const requeued = await q(
    `UPDATE recordings SET frames_state = 'pending', frames_lease_id = NULL, frames_lease_until = NULL
      WHERE frames_state = 'running' AND frames_lease_until < now() RETURNING id`,
  );
  for (const r of failed)
    await audit(
      null,
      "recording_frames_failed",
      { type: "recording", id: r.id },
      { error: "the worker stopped answering", attempts: r.frames_attempts },
    );
  return { requeued: requeued.length, failed: failed.length };
}

/** Removes a recording's images: the rows and every file stored for them, including leftovers of an earlier attempt. */
export async function dropFrameData(recordingId: string) {
  await q("DELETE FROM recording_frames WHERE recording_id = $1", [recordingId]);
  await deleteObjects(await listKeys(framesPrefix(recordingId)));
}

/**
 * Throws away the images of every built recording of an assignment and queues them again, in order. They must run
 * in order: each recording carries on from the counter at the end of the one before it. Returns how many were queued.
 */
export async function rerunAssignmentFrames(assignmentId: string, actorId: string, ip?: string) {
  const recs = await q(
    `SELECT id FROM recordings WHERE assignment_id = $1 AND status = 'server_verified' AND assembly_state = 'done' ORDER BY started_at_ms`,
    [assignmentId],
  );
  for (const r of recs) {
    await q(
      `UPDATE recordings SET frames_state = 'pending', frames_attempts = 0, frames_error = NULL, frames_lease_id = NULL,
              frames_lease_until = NULL, frames_count = NULL, frames_step_m = NULL, frames_mode = NULL, frames_carry = NULL, frames_at = NULL
        WHERE id = $1`,
      [r.id],
    );
    await dropFrameData(r.id); // after the reset: a worker still holding the old claim can no longer add to it
    await audit(actorId, "recording_frames_requeued", { type: "recording", id: r.id }, { assignmentId, stepM: config.frames.stepM }, ip);
  }
  return recs.length;
}

/** A recording's position among the verified recordings of its assignment, starting at 1. Same order as the export. */
export async function recordingIndex(rec: { id: string; assignment_id: string; started_at_ms: string | number }) {
  const r = await q1(
    "SELECT count(*)::int AS n FROM recordings WHERE assignment_id = $1 AND status = 'server_verified' AND started_at_ms <= $2",
    [rec.assignment_id, rec.started_at_ms],
  );
  return r.n as number;
}

export type FrameRow = ReturnType<typeof frameJson>;

/** A row as the people and tools downloading it see it. `file` is relative to the folder holding frames.json. */
export function frameJson(f: any) {
  return {
    frame: f.frame as number,
    bin: f.bin as number,
    file: `images/${f.file_name}` as string,
    timestamp: new Date(f.taken_at).toISOString(),
    videoTimeS: f.video_time_s as number,
    walkedStartM: f.walked_start_m as number,
    walkedEndM: f.walked_end_m as number,
    latitude: f.latitude as number,
    longitude: f.longitude as number,
    accuracyM: f.accuracy_m as number,
    headingDeg: f.heading_deg as number | null,
    sharpness: f.sharpness as number,
    lowSharpness: f.low_sharpness as boolean,
    timeUncertain: f.time_uncertain as boolean,
    afterGap: f.after_gap as boolean,
    gapM: f.gap_m as number | null,
    bytes: Number(f.file_bytes),
    sha256: f.file_sha256 as string,
  };
}

const CSV_COLUMNS: [string, keyof FrameRow][] = [
  ["frame", "frame"],
  ["bin", "bin"],
  ["file", "file"],
  ["timestamp", "timestamp"],
  ["video_time_s", "videoTimeS"],
  ["walked_start_m", "walkedStartM"],
  ["walked_end_m", "walkedEndM"],
  ["latitude", "latitude"],
  ["longitude", "longitude"],
  ["accuracy_m", "accuracyM"],
  ["heading_deg", "headingDeg"],
  ["sharpness", "sharpness"],
  ["low_sharpness", "lowSharpness"],
  ["time_uncertain", "timeUncertain"],
  ["after_gap", "afterGap"],
  ["gap_m", "gapM"],
  ["sha256", "sha256"],
];

export function manifestCsv(frames: FrameRow[]) {
  const cell = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "boolean" ? (v ? "1" : "0") : String(v));
  return [CSV_COLUMNS.map(([h]) => h).join(","), ...frames.map((f) => CSV_COLUMNS.map(([, k]) => cell(f[k])).join(","))].join("\n") + "\n";
}

export const framesOf = async (recordingId: string) =>
  (await q("SELECT * FROM recording_frames WHERE recording_id = $1 ORDER BY frame", [recordingId])).map(frameJson);

/** The frames.json of one recording: what the scoring engine and CVAT tooling read. */
export async function framesDocument(
  rec: any,
  assignment: { id: string; purpose: string; routeId: string; routeVersionId: string },
  index: number,
) {
  const check = timeCheck(
    rec.ended_at_ms == null ? null : Number(rec.ended_at_ms) - Number(rec.started_at_ms),
    rec.video_duration_ms == null ? null : Number(rec.video_duration_ms),
  );
  return {
    routeId: assignment.routeId,
    routeVersionId: assignment.routeVersionId,
    assignmentId: assignment.id,
    recordingId: rec.id as string,
    recordingIndex: index,
    purpose: assignment.purpose,
    stepM: rec.frames_step_m === null ? null : Number(rec.frames_step_m),
    anonymization: rec.frames_mode as string | null,
    timeWarning: check.timeWarning,
    frames: await framesOf(rec.id),
  };
}

/** Adds the images of one recording to a ZIP, one at a time from storage, so no image waits in memory. */
export async function appendImages(zip: ZipArchive, dir: string, recordingId: string, namePrefix = "") {
  const rows = await q("SELECT file_name, file_key FROM recording_frames WHERE recording_id = $1 ORDER BY frame", [recordingId]);
  for (const r of rows) {
    const obj = await getObject(r.file_key);
    const done = new Promise((resolve) => zip.once("entry", resolve));
    zip.append(obj.body, { name: `${dir}/${namePrefix}${r.file_name}` });
    await done; // next image only after this one is fully written
  }
}
