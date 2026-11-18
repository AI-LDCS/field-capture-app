import { Router, type Request } from "express";
import { z } from "zod";
import { audit } from "../services/audit.ts";
import { config } from "../config.ts";
import { q, q1 } from "../db.ts";
import { HttpError, notFound, uuidParam } from "../http.ts";
import { expireLeases } from "../services/anonymize.ts";
import { extOf } from "../services/downloads.ts";
import { deleteObjects, getObject, putStream } from "../services/storage.ts";

/**
 * What the anonymizer worker (the GPU machine) calls: claim a recording, read the original, report that it is
 * still working, upload the anonymized file, or give up. Mounted behind the bearer token only (see
 * requireAnonymizerToken). Every call after the claim carries the `x-lease-id` the claim returned, so a worker
 * that lost its claim (it was silent too long and someone else took the job) cannot finish or overwrite it.
 */
export const anonymizerRouter = Router();

const leaseSeconds = () => config.anonymizer.leaseMinutes * 60;

/** The recording this worker holds right now, or the reason it does not. */
async function held(req: Request) {
  const lease = String(req.header("x-lease-id") ?? "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(lease))
    throw new HttpError(400, "bad_lease", "send the x-lease-id from the claim");
  const rec = await q1("SELECT * FROM recordings WHERE id = $1", [uuidParam(req, "id")]);
  if (!rec) throw notFound("recording not found");
  if (rec.anon_state !== "running") throw new HttpError(409, "not_claimed", `this recording is not claimed (${rec.anon_state})`);
  if (rec.anon_lease_id !== lease.toLowerCase() || new Date(rec.anon_lease_until).getTime() < Date.now())
    throw new HttpError(409, "lease_lost", "this claim ran out or belongs to another worker");
  return { rec, lease: lease.toLowerCase() };
}

/** Takes the oldest recording that is ready, or answers 204. The claim lasts `leaseSeconds` unless the worker reports in. */
anonymizerRouter.post("/claim", async (req, res) => {
  if (!config.anonymizer.videoEnabled) return void res.status(204).end(); // whole-video copies are switched off
  await expireLeases();
  const rec = await q1(
    `UPDATE recordings SET anon_state = 'running', anon_attempts = anon_attempts + 1, anon_error = NULL,
            anon_lease_id = gen_random_uuid(), anon_lease_until = now() + make_interval(secs => $1)
      WHERE id = (SELECT id FROM recordings WHERE anon_state = 'pending' AND assembly_state = 'done'
                   ORDER BY verified_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id, mime, file_mime, file_bytes, file_sha256, anon_lease_id, anon_attempts`,
    [leaseSeconds()],
  );
  if (!rec) return void res.status(204).end();
  await audit(null, "recording_anonymize_started", { type: "recording", id: rec.id }, { attempt: rec.anon_attempts }, req.ip);
  res.json({
    id: rec.id,
    leaseId: rec.anon_lease_id,
    leaseSeconds: leaseSeconds(),
    attempt: rec.anon_attempts,
    ext: extOf(rec.mime),
    mime: rec.file_mime,
    bytes: Number(rec.file_bytes),
    sha256: rec.file_sha256,
  });
});

/** The original video, streamed. Only for the worker that holds the claim. */
anonymizerRouter.get("/:id/source", async (req, res) => {
  const { rec } = await held(req);
  const obj = await getObject(rec.file_key);
  res.set({ "Content-Type": rec.file_mime, "Content-Length": String(obj.length), "Cache-Control": "private, no-store" });
  res.on("close", () => obj.body.destroy());
  obj.body.pipe(res);
});

/** "Still working": pushes the lease out again. */
anonymizerRouter.post("/:id/heartbeat", async (req, res) => {
  const { rec, lease } = await held(req);
  await q("UPDATE recordings SET anon_lease_until = now() + make_interval(secs => $1) WHERE id = $2 AND anon_lease_id = $3", [
    leaseSeconds(),
    rec.id,
    lease,
  ]);
  res.json({ ok: true, leaseSeconds: leaseSeconds() });
});

const MODE = /^[a-z]{3,20}$/;

/**
 * The anonymized video, as raw bytes. It goes into storage as it arrives (never all in memory) and is checked
 * against the length and SHA-256 the worker sent before it counts. Until then nothing is stored under the final key.
 */
anonymizerRouter.put("/:id/result", async (req, res) => {
  const { rec, lease } = await held(req);
  const claimedHash = String(req.header("x-sha256") ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(claimedHash)) throw new HttpError(400, "bad_checksum", "send x-sha256: the hex SHA-256 of the body");
  const claimedLength = Number(req.header("content-length"));
  if (!Number.isInteger(claimedLength) || claimedLength <= 0) throw new HttpError(411, "length_required", "send a Content-Length");
  const mode = String(req.header("x-anon-mode") ?? "unknown").toLowerCase();
  if (!MODE.test(mode)) throw new HttpError(400, "bad_mode", "x-anon-mode is a short lowercase word, such as solid");

  const key = `rec/${rec.id}/anon-${lease}.${extOf(rec.mime)}`;
  const stored = await putStream(key, rec.file_mime, req, config.anonymizer.partBytes, (bytes, sha256) => {
    if (bytes !== claimedLength) throw new HttpError(422, "size_mismatch", "the body is not as long as Content-Length said");
    if (sha256 !== claimedHash) throw new HttpError(422, "checksum_mismatch", "checksum does not match the data");
  });

  // the claim may have been lost while the bytes were arriving; then this file is nobody's
  const done = await q1(
    `UPDATE recordings SET anon_state = 'done', anon_key = $1, anon_bytes = $2, anon_sha256 = $3, anon_mode = $4, anon_error = NULL,
            anon_lease_id = NULL, anon_lease_until = NULL, anonymized_at = now()
      WHERE id = $5 AND anon_state = 'running' AND anon_lease_id = $6 RETURNING anon_attempts`,
    [key, stored.bytes, stored.sha256, mode, rec.id, lease],
  );
  if (!done) {
    await deleteObjects([key]);
    throw new HttpError(409, "lease_lost", "this claim ran out while the file was uploading");
  }
  await audit(
    null,
    "recording_anonymized",
    { type: "recording", id: rec.id },
    { bytes: stored.bytes, mode, attempts: done.anon_attempts },
    req.ip,
  );
  res.json({ ok: true });
});

const failSchema = z.object({ error: z.string().max(500).default("unknown error") });

/** The worker could not make the file. It goes back in the queue until it has used all its attempts, then it is failed. */
anonymizerRouter.post("/:id/fail", async (req, res) => {
  const { error } = failSchema.parse(req.body);
  const { rec, lease } = await held(req);
  const retry = rec.anon_attempts < config.anonymizer.maxAttempts;
  await q(
    "UPDATE recordings SET anon_state = $1, anon_error = $2, anon_lease_id = NULL, anon_lease_until = NULL WHERE id = $3 AND anon_lease_id = $4",
    [retry ? "pending" : "failed", error, rec.id, lease],
  );
  await audit(null, "recording_anonymize_failed", { type: "recording", id: rec.id }, { error, attempts: rec.anon_attempts, retry }, req.ip);
  res.json({ ok: true, retry });
});
