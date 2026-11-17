import { audit } from "./audit.ts";
import { config } from "../config.ts";
import { q } from "../db.ts";

/**
 * The anonymized copy of a recording is made by a separate worker (the GPU machine), not by this process.
 * This file keeps that queue honest: a claim is a lease, and a worker that goes quiet loses it.
 * Enqueuing happens where the video is built (assemble.ts); claiming, uploading and failing are in routes/anonymizer.ts.
 */
let timer: NodeJS.Timeout | null = null;

/**
 * Gives claims that ran out of time back to the queue, or fails them once they have used all their attempts.
 * Returns how many were requeued and how many failed.
 */
export async function expireLeases() {
  const failed = await q(
    `UPDATE recordings SET anon_state = 'failed', anon_error = 'the worker stopped answering', anon_lease_id = NULL, anon_lease_until = NULL
      WHERE anon_state = 'running' AND anon_lease_until < now() AND anon_attempts >= $1 RETURNING id, anon_attempts`,
    [config.anonymizer.maxAttempts],
  );
  const requeued = await q(
    `UPDATE recordings SET anon_state = 'pending', anon_lease_id = NULL, anon_lease_until = NULL
      WHERE anon_state = 'running' AND anon_lease_until < now() RETURNING id, anon_attempts`,
  );
  for (const r of failed)
    await audit(
      null,
      "recording_anonymize_failed",
      { type: "recording", id: r.id },
      { error: "the worker stopped answering", attempts: r.anon_attempts },
    );
  return { requeued: requeued.length, failed: failed.length };
}

export function startAnonymizeSweep() {
  timer ??= setInterval(() => void expireLeases().catch((e) => console.error("anonymize sweep failed", e)), config.anonymizer.sweepMs);
  void expireLeases().catch((e) => console.error("anonymize sweep failed", e));
}
export function stopAnonymizeSweep() {
  if (timer) clearInterval(timer);
  timer = null;
}
