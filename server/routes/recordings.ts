import crypto from "node:crypto";
import express, { Router, type Request } from "express";
import { z } from "zod";
import { audit } from "../audit.ts";
import { config } from "../config.ts";
import { q, q1, tx } from "../db.ts";
import { kickAssembler } from "../assemble.ts";
import { refreshSegments } from "../evaluate.ts";
import { HttpError, notFound, uuidParam } from "../http.ts";
import { sendGpsDownload, sendVideoDownload } from "../downloads.ts";
import { putObject } from "../storage.ts";

/** Everything a worker does with a recording. Each route is scoped to recordings the caller owns. */
export const workerRecordingsRouter = Router();

const MAX_CHUNK_BYTES = 32 * 1024 * 1024;
const MAX_CHUNKS = 100_000;

async function owned(req: Request) {
  const rec = await q1("SELECT * FROM recordings WHERE id = $1 AND user_id = $2", [uuidParam(req, "id"), req.user!.id]);
  if (!rec) throw notFound("recording not found"); // someone else's id looks exactly like a missing one
  return rec;
}
const openOnly = (rec: any) => {
  if (rec.status === "server_verified") throw new HttpError(409, "already_verified", "this recording is already verified");
};

const registerSchema = z.object({
  id: z.uuid(),
  assignmentId: z.uuid(),
  mime: z
    .string()
    .regex(/^video\/[a-z0-9.+-]+(;.*)?$/i)
    .max(100),
  startedAt: z.number().int().positive(),
  simulated: z.boolean().default(false),
});

/** Idempotent, and only for the caller's own assignment. */
workerRecordingsRouter.post("/", async (req, res) => {
  const b = registerSchema.parse(req.body);
  if (b.simulated && !config.devTools) throw new HttpError(400, "dev_tools_off", "simulated recordings are not accepted here");

  const existing = await q1("SELECT user_id, assignment_id FROM recordings WHERE id = $1", [b.id]);
  if (existing) {
    if (existing.user_id !== req.user!.id || existing.assignment_id !== b.assignmentId) throw notFound("recording not found");
    return void res.json({ ok: true, existing: true });
  }
  await tx(async (c) => {
    const a = await q1("SELECT status FROM assignments WHERE id = $1 AND user_id = $2 FOR UPDATE", [b.assignmentId, req.user!.id], c);
    if (!a) throw notFound("assignment not found");
    if (a.status === "completed") throw new HttpError(409, "completed", "this assignment is already completed");
    await q(
      "INSERT INTO recordings (id, assignment_id, user_id, mime, started_at_ms, simulated) VALUES ($1,$2,$3,$4,$5,$6)",
      [b.id, b.assignmentId, req.user!.id, b.mime, b.startedAt, b.simulated],
      c,
    );
    if (a.status === "assigned" || a.status === "pending_sync")
      await q("UPDATE assignments SET status = 'in_progress', updated_at = now() WHERE id = $1", [b.assignmentId], c);
    await audit(
      req.user!.id,
      "recording_registered",
      { type: "recording", id: b.id },
      { assignmentId: b.assignmentId, simulated: b.simulated },
      req.ip,
      c,
    );
  });
  res.status(201).json({ ok: true });
});

workerRecordingsRouter.get("/:id/status", async (req, res) => {
  const rec = await owned(req);
  res.json({
    verified: rec.status === "server_verified",
    chunkSeqs: (await q("SELECT seq FROM recording_chunks WHERE recording_id = $1 ORDER BY seq", [rec.id])).map((r) => r.seq),
    gpsSeqs: (await q("SELECT seq FROM gps_points WHERE recording_id = $1 ORDER BY seq", [rec.id])).map((r) => r.seq),
  });
});

/** A worker's own GPS track (not video): the app uses it to show what is already covered. */
workerRecordingsRouter.get("/:id/gps", async (req, res) => {
  const rec = await owned(req);
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

/** A worker's own files, once they are on the server (verified, and for the video, built). Someone else's id is a 404. */
workerRecordingsRouter.get("/:id/download", async (req, res) => {
  await sendVideoDownload(req, res, await owned(req));
});
workerRecordingsRouter.get("/:id/gps.json", async (req, res) => {
  await sendGpsDownload(req, res, await owned(req));
});

// Chunks are content-addressed: the key holds the hash, so two racing uploads of the same seq cannot overwrite each other.
workerRecordingsRouter.put(
  "/:id/chunks/:seq",
  express.raw({ type: "application/octet-stream", limit: MAX_CHUNK_BYTES }),
  async (req, res) => {
    const rec = await owned(req);
    openOnly(rec);
    const seq = Number(req.params.seq);
    if (!Number.isInteger(seq) || seq < 0 || seq >= MAX_CHUNKS) throw new HttpError(400, "bad_seq", "bad sequence number");
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) throw new HttpError(400, "empty_chunk", "empty chunk");

    const claimed = String(req.header("x-sha256") ?? "").toLowerCase();
    const actual = crypto.createHash("sha256").update(body).digest("hex");
    if (claimed !== actual) throw new HttpError(422, "checksum_mismatch", "checksum does not match the data");

    const have = await q1("SELECT sha256 FROM recording_chunks WHERE recording_id = $1 AND seq = $2", [rec.id, seq]);
    if (have) {
      if (have.sha256 === actual) return void res.json({ ok: true, duplicate: true });
      throw new HttpError(409, "seq_conflict", "this sequence number is already stored with different data");
    }
    const key = `rec/${rec.id}/c/${seq}-${actual}`;
    await putObject(key, body, "application/octet-stream");
    const ins = await q(
      "INSERT INTO recording_chunks (recording_id, seq, sha256, size, object_key) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING seq",
      [rec.id, seq, actual, body.length, key],
    );
    if (!ins.length) {
      const now = await q1("SELECT sha256 FROM recording_chunks WHERE recording_id = $1 AND seq = $2", [rec.id, seq]);
      if (now?.sha256 === actual) return void res.json({ ok: true, duplicate: true });
      throw new HttpError(409, "seq_conflict", "this sequence number is already stored with different data");
    }
    res.json({ ok: true });
  },
);

const gpsSchema = z.object({
  points: z
    .array(
      z.object({
        seq: z.number().int().min(0).max(1_000_000),
        t: z.number().int().positive(),
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        acc: z.number().min(0).max(1_000_000),
      }),
    )
    .min(1)
    .max(1000),
});

workerRecordingsRouter.post("/:id/gps", async (req, res) => {
  const rec = await owned(req);
  openOnly(rec);
  const { points } = gpsSchema.parse(req.body);
  await tx(async (c) => {
    for (const p of points) {
      await q(
        "INSERT INTO gps_points (recording_id, seq, t_ms, lat, lng, acc) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
        [rec.id, p.seq, p.t, p.lat, p.lng, p.acc],
        c,
      );
    }
  });
  res.json({ ok: true });
});

const finalizeSchema = z.object({
  startedAt: z.number().int().positive().optional(),
  endedAt: z.number().int().positive().nullable().optional(),
  stopReason: z.string().max(100).nullable().optional(),
  chunks: z
    .array(z.object({ seq: z.number().int().min(0), sha256: z.string().regex(/^[0-9a-f]{64}$/) }))
    .min(1)
    .max(MAX_CHUNKS),
  gpsCount: z.number().int().min(0).max(1_000_000),
});

/** The manifest decides, not the HTTP status of earlier requests. Cheap: no video is read here. */
workerRecordingsRouter.post("/:id/finalize", async (req, res) => {
  const m = finalizeSchema.parse(req.body);
  const result = await tx(async (c) => {
    const rec = await q1("SELECT * FROM recordings WHERE id = $1 AND user_id = $2 FOR UPDATE", [uuidParam(req, "id"), req.user!.id], c);
    if (!rec) throw notFound("recording not found");
    if (rec.status === "server_verified") return { existing: true as const }; // a retried finalize is safe

    const have = new Map(
      (await q("SELECT seq, sha256 FROM recording_chunks WHERE recording_id = $1", [rec.id], c)).map((r) => [
        r.seq as number,
        r.sha256 as string,
      ]),
    );
    const missingChunks: number[] = [];
    const mismatched: number[] = [];
    m.chunks.forEach((ch, i) => {
      if (ch.seq !== i) mismatched.push(ch.seq); // the manifest must be exactly 0..n-1
      const h = have.get(ch.seq);
      if (!h) missingChunks.push(ch.seq);
      else if (h !== ch.sha256) mismatched.push(ch.seq);
    });
    const extra = [...have.keys()].filter((s) => s >= m.chunks.length);
    const gps = (await q("SELECT seq FROM gps_points WHERE recording_id = $1 ORDER BY seq", [rec.id], c)).map((r) => r.seq as number);
    const gpsOk = gps.length === m.gpsCount && gps.every((s, i) => s === i);
    if (missingChunks.length || mismatched.length || extra.length || !gpsOk) {
      await audit(
        req.user!.id,
        "recording_verify_failed",
        { type: "recording", id: rec.id },
        { missingChunks: missingChunks.slice(0, 20), mismatched: mismatched.slice(0, 20), extra: extra.slice(0, 20), gpsOk },
        req.ip,
        c,
      );
      return { failed: { missingChunks, mismatched, extra, gpsOk, gpsHave: gps.length } };
    }
    await q(
      `UPDATE recordings SET status = 'server_verified', verified_at = now(), chunk_count = $2, gps_count = $3,
              ended_at_ms = $4, stop_reason = $5, started_at_ms = COALESCE($6, started_at_ms), assembly_state = 'pending'
        WHERE id = $1`,
      [rec.id, m.chunks.length, m.gpsCount, m.endedAt ?? null, m.stopReason ?? null, m.startedAt ?? null],
      c,
    );
    await refreshSegments(rec.assignment_id, c);
    await audit(
      req.user!.id,
      "recording_verified",
      { type: "recording", id: rec.id },
      { chunks: m.chunks.length, gps: m.gpsCount },
      req.ip,
      c,
    );
    return { ok: true as const };
  });
  if ("failed" in result) throw new HttpError(409, "manifest_mismatch", "stored data does not match the manifest", result.failed);
  void kickAssembler();
  res.json({ ok: true });
});

/** A recording that never got a chunk can be dropped so it never blocks the assignment. */
workerRecordingsRouter.delete("/:id", async (req, res) => {
  const rec = await owned(req);
  openOnly(rec);
  if (await q1("SELECT 1 FROM recording_chunks WHERE recording_id = $1", [rec.id]))
    throw new HttpError(409, "has_chunks", "this recording already has data");
  await q("DELETE FROM recordings WHERE id = $1", [rec.id]);
  await audit(req.user!.id, "recording_discarded", { type: "recording", id: rec.id }, undefined, req.ip);
  res.json({ ok: true });
});
