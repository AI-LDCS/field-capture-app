import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, describe, it } from "node:test";
import { ANON_TOKEN, Client, adminLogin, assignTo, createWorker, publishRoute, sha256, startTestServer } from "./helpers.ts";

/**
 * The anonymized copy: the queue the GPU worker pulls from, and who may download which file.
 * The worker below is a stand-in: it speaks the same HTTP as video-anonymizer/worker.py.
 */
let t: Awaited<ReturnType<typeof startTestServer>>;
let admin: Client;
before(async () => {
  t = await startTestServer();
  t.config.anonymizer.videoEnabled = true; // this file is about the whole-video copy, which is off by default
  admin = await adminLogin(t.base);
});
after(async () => {
  await t.stop();
});

/** Calls as the GPU worker does: a bearer token, no cookie, no Origin header. */
async function gpu(
  method: string,
  path: string,
  opts: { token?: string | null; lease?: string; body?: Buffer | object; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? ANON_TOKEN}`;
  if (opts.lease) headers["x-lease-id"] = opts.lease;
  let body: BodyInit | undefined;
  if (Buffer.isBuffer(opts.body)) {
    headers["content-type"] = "application/octet-stream";
    body = new Uint8Array(opts.body) as unknown as BodyInit;
  } else if (opts.body) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const r = await fetch(t.base + path, { method, headers, body });
  const bytes = Buffer.from(await r.arrayBuffer());
  let json: any;
  try {
    json = bytes.length ? JSON.parse(bytes.toString("utf8")) : undefined;
  } catch {
    json = undefined;
  }
  return { status: r.status, body: json, bytes, headers: r.headers };
}

async function builtRecording(label: string) {
  const w = await createWorker(t.base, admin, label);
  const asg = await assignTo(admin, (await publishRoute(admin, `Route ${label}`)).id, w.id);
  const coords = asg.segments[0].coords;
  const id = crypto.randomUUID();
  const chunks = [crypto.randomBytes(5000), crypto.randomBytes(4000)];
  const pts = coords
    .filter((_, i) => i % 5 === 0)
    .map((c, i) => ({ seq: i, t: Date.now() - 300_000 + i * 1000, lng: c[0], lat: c[1], acc: 5 }));
  assert.equal(
    (await w.client.post("/api/me/recordings", { id, assignmentId: asg.id, mime: "video/webm", startedAt: Date.now() - 300_000 })).status,
    201,
  );
  for (const [i, b] of chunks.entries())
    assert.equal((await w.client.putRaw(`/api/me/recordings/${id}/chunks/${i}`, b, { "x-sha256": sha256(b) })).status, 200);
  assert.equal((await w.client.post(`/api/me/recordings/${id}/gps`, { points: pts })).status, 200);
  const fin = await w.client.post(`/api/me/recordings/${id}/finalize`, {
    endedAt: Date.now(),
    chunks: chunks.map((b, seq) => ({ seq, sha256: sha256(b) })),
    gpsCount: pts.length,
  });
  assert.equal(fin.status, 200, JSON.stringify(fin.body));
  for (let i = 0; i < 100; i++) {
    await t.kickAssembler();
    if ((await t.pool.query("SELECT assembly_state s FROM recordings WHERE id=$1", [id])).rows[0].s === "done") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  // the queue is shared by every test in this file, so leave only this recording waiting
  await t.pool.query("UPDATE recordings SET anon_state = 'none' WHERE id <> $1 AND anon_state IN ('pending', 'running')", [id]);
  return { id, worker: w, assignmentId: asg.id, original: Buffer.concat(chunks) };
}
const state = async (id: string) =>
  (await t.pool.query("SELECT anon_state, anon_attempts, anon_error, anon_key FROM recordings WHERE id=$1", [id])).rows[0];

describe("who may call the worker routes", () => {
  it("answers 404 while no token is configured, and 401 without the right one", async () => {
    const saved = t.config.anonymizer.token;
    t.config.anonymizer.token = "";
    assert.equal((await gpu("POST", "/api/anonymizer/claim")).status, 404, "off until a token is set");
    t.config.anonymizer.token = saved;

    assert.equal((await gpu("POST", "/api/anonymizer/claim", { token: null })).status, 401, "no token");
    const wrong = await gpu("POST", "/api/anonymizer/claim", { token: "x".repeat(40) });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error, "bad_token");
    // a signed-in admin's cookie is not a token
    assert.equal((await admin.post("/api/anonymizer/claim")).status, 401);
    const w = await createWorker(t.base, admin, "anon-nobody");
    assert.equal((await w.client.post("/api/anonymizer/claim")).status, 401);
  });
  it("claims nothing when nothing is waiting", async () => {
    await t.pool.query("UPDATE recordings SET anon_state = 'none' WHERE anon_state IN ('pending', 'running')");
    const r = await gpu("POST", "/api/anonymizer/claim");
    assert.equal(r.status, 204);
  });
});

describe("the anonymizing round trip", () => {
  it("queues after the build, hands the original to the worker that claimed it, and stores what it sends back", async () => {
    const r = await builtRecording("round-trip");
    assert.equal((await state(r.id)).anon_state, "pending", "building the video queues the job");

    const claim = await gpu("POST", "/api/anonymizer/claim");
    assert.equal(claim.status, 200);
    assert.equal(claim.body.id, r.id);
    assert.equal(claim.body.ext, "webm");
    assert.equal(claim.body.bytes, r.original.length);
    assert.equal(claim.body.sha256, sha256(r.original));
    assert.equal(claim.body.attempt, 1);
    const lease = claim.body.leaseId as string;
    assert.equal((await state(r.id)).anon_state, "running");
    assert.equal((await gpu("POST", "/api/anonymizer/claim")).status, 204, "a claimed recording is not handed out twice");

    // the original: only with the claim's lease
    assert.equal((await gpu("GET", `/api/anonymizer/${r.id}/source`)).status, 400, "no lease");
    const wrongLease = await gpu("GET", `/api/anonymizer/${r.id}/source`, { lease: crypto.randomUUID() });
    assert.equal(wrongLease.status, 409);
    assert.equal(wrongLease.body.error, "lease_lost");
    const src = await gpu("GET", `/api/anonymizer/${r.id}/source`, { lease });
    assert.equal(src.status, 200);
    assert.ok(src.bytes.equals(r.original));
    assert.equal((await gpu("GET", `/api/anonymizer/${crypto.randomUUID()}/source`, { lease })).status, 404);

    assert.equal((await gpu("POST", `/api/anonymizer/${r.id}/heartbeat`, { lease })).status, 200);

    // a result is checked against its own hash before it counts
    const result = crypto.randomBytes(11 * 1024 * 1024); // several parts at the test's 5 MiB part size
    t.config.anonymizer.partBytes = 5 * 1024 * 1024;
    const noHash = await gpu("PUT", `/api/anonymizer/${r.id}/result`, { lease, body: result });
    assert.equal(noHash.status, 400);
    assert.equal(noHash.body.error, "bad_checksum");
    const bad = await gpu("PUT", `/api/anonymizer/${r.id}/result`, { lease, body: result, headers: { "x-sha256": "0".repeat(64) } });
    assert.equal(bad.status, 422);
    assert.equal(bad.body.error, "checksum_mismatch");
    assert.equal((await state(r.id)).anon_state, "running", "a bad upload changes nothing");
    assert.deepEqual(
      (await t.storage.listKeys(`rec/${r.id}/`)).filter((k) => k.includes("anon")),
      [],
      "and leaves no file behind",
    );
    const badMode = await gpu("PUT", `/api/anonymizer/${r.id}/result`, {
      lease,
      body: result,
      headers: { "x-sha256": sha256(result), "x-anon-mode": "Not A Mode" },
    });
    assert.equal(badMode.status, 400);
    assert.equal(badMode.body.error, "bad_mode");
    const ok = await gpu("PUT", `/api/anonymizer/${r.id}/result`, {
      lease,
      body: result,
      headers: { "x-sha256": sha256(result), "x-anon-mode": "solid" },
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    t.config.anonymizer.partBytes = 8 * 1024 * 1024;

    const row = (await t.pool.query("SELECT * FROM recordings WHERE id=$1", [r.id])).rows[0];
    assert.equal(row.anon_state, "done");
    assert.equal(Number(row.anon_bytes), result.length);
    assert.equal(row.anon_sha256, sha256(result));
    assert.equal(row.anon_mode, "solid");
    assert.equal(row.anon_lease_id, null);
    assert.ok(row.anonymized_at);
    assert.equal(row.file_sha256, sha256(r.original), "the original is untouched");
    assert.equal(
      (await t.storage.listKeys(`rec/${r.id}/`)).sort().join(),
      [row.file_key, row.anon_key].sort().join(),
      "the original and the anonymized copy sit side by side",
    );

    // the claim is spent
    const late = await gpu("PUT", `/api/anonymizer/${r.id}/result`, { lease, body: result, headers: { "x-sha256": sha256(result) } });
    assert.equal(late.status, 409);
    assert.equal(late.body.error, "not_claimed");

    // ---- who downloads what ----
    const mine = r.worker.client;
    const other = await createWorker(t.base, admin, "anon-other");

    // a worker: anonymized by default, the original on request, only their own
    const wDefault = await mine.get(`/api/me/recordings/${r.id}/download`);
    assert.equal(wDefault.status, 200);
    assert.ok(wDefault.bytes.equals(result));
    assert.match(wDefault.headers.get("content-disposition") ?? "", /filename="recording-[0-9a-f]{8}-anonymized\.webm"/);
    const wOriginal = await mine.get(`/api/me/recordings/${r.id}/download?variant=original`);
    assert.ok(wOriginal.bytes.equals(r.original));
    assert.match(wOriginal.headers.get("content-disposition") ?? "", /filename="recording-[0-9a-f]{8}\.webm"/);
    assert.equal((await mine.get(`/api/me/recordings/${r.id}/download?variant=anonymized`)).status, 200);
    assert.equal((await mine.get(`/api/me/recordings/${r.id}/download?variant=nonsense`)).status, 400);
    for (const v of ["anonymized", "original"])
      assert.equal((await other.client.get(`/api/me/recordings/${r.id}/download?variant=${v}`)).status, 404);

    // an admin: the original by default, everything on request
    const aDefault = await admin.get(`/api/admin/recordings/${r.id}/download`);
    assert.ok(aDefault.bytes.equals(r.original));
    const aAnon = await admin.get(`/api/admin/recordings/${r.id}/download?variant=anonymized`);
    assert.ok(aAnon.bytes.equals(result));
    assert.match(aAnon.headers.get("content-disposition") ?? "", /-anonymized\.webm/);
    assert.equal((await admin.get(`/api/admin/recordings/${r.id}/download?variant=nonsense`)).status, 400);
    const play = await admin.get(`/api/admin/recordings/${r.id}/video?variant=anonymized`, { range: "bytes=10-19" });
    assert.equal(play.status, 206);
    assert.equal(play.headers.get("content-range"), `bytes 10-19/${result.length}`);
    assert.ok(play.bytes.equals(result.subarray(10, 20)));
    assert.equal((await mine.get(`/api/admin/recordings/${r.id}/download?variant=anonymized`)).status, 403);

    // the assignment export carries both files
    const exp = await admin.get(`/api/admin/assignments/${r.assignmentId}/export.json`);
    assert.equal(exp.status, 200);
    assert.match(exp.body.recordings[0].anonymizedFile, /-anonymized\.webm$/);
    assert.equal(exp.body.recordings[0].anonymizedSha256, sha256(result));
    const zip = await admin.get(`/api/admin/assignments/${r.assignmentId}/export.zip`);
    assert.equal(zip.status, 200);
    assert.ok(zip.bytes.includes(Buffer.from("-anonymized.webm")), "the zip lists the anonymized file");
    assert.ok(zip.bytes.length > result.length + r.original.length, "and holds both videos");

    // what the pages see
    const list = await admin.get("/api/admin/recordings");
    const row2 = list.body.find((x: any) => x.id === r.id);
    assert.equal(row2.anonymization, "done");
    assert.equal(row2.anonymizedBytes, result.length);
    const mineList = await mine.get(`/api/me/assignments/${r.assignmentId}`);
    assert.equal(mineList.body.recordings[0].anonymization, "done");

    // audited
    const actions = (await t.pool.query("SELECT action, details FROM audit_log WHERE target_id = $1", [r.id])).rows;
    for (const a of ["recording_anonymize_started", "recording_anonymized"])
      assert.ok(
        actions.some((x) => x.action === a),
        a,
      );
    const downloads = actions.filter((x) => x.action === "recording_downloaded");
    assert.ok(downloads.some((x) => x.details?.variant === "anonymized" && x.details?.by === "worker"));
    assert.ok(downloads.some((x) => x.details?.variant === "original" && x.details?.by === undefined));
  });

  it("does not offer the anonymized copy before it exists, and never falls back to the original", async () => {
    const r = await builtRecording("no-fallback");
    for (const s of ["pending", "running", "failed"]) {
      await t.pool.query("UPDATE recordings SET anon_state = $2 WHERE id = $1", [r.id, s]);
      for (const p of [`/api/me/recordings/${r.id}/download`, `/api/me/recordings/${r.id}/download?variant=anonymized`]) {
        const w = await r.worker.client.get(p);
        assert.equal(w.status, 409, `${s} ${p}`);
        assert.equal(w.body.error, "not_anonymized");
      }
      assert.equal((await admin.get(`/api/admin/recordings/${r.id}/download?variant=anonymized`)).status, 409);
      assert.equal((await admin.get(`/api/admin/recordings/${r.id}/video?variant=anonymized`)).status, 409);
    }
  });
});

describe("a worker that fails or goes quiet", () => {
  it("retries a failed job until its attempts run out, then an admin can queue it again", async () => {
    const r = await builtRecording("retries");
    const attempts: number[] = [];
    for (let i = 1; i <= t.config.anonymizer.maxAttempts; i++) {
      const claim = await gpu("POST", "/api/anonymizer/claim");
      assert.equal(claim.status, 200, `claim ${i}`);
      attempts.push(claim.body.attempt);
      const bad = await gpu("POST", `/api/anonymizer/${r.id}/fail`, { lease: claim.body.leaseId, body: { error: `boom ${i}` } });
      assert.equal(bad.status, 200);
      assert.equal(bad.body.retry, i < t.config.anonymizer.maxAttempts);
    }
    assert.deepEqual(attempts, [1, 2, 3]);
    const s = await state(r.id);
    assert.equal(s.anon_state, "failed");
    assert.equal(s.anon_error, "boom 3");
    assert.equal((await gpu("POST", "/api/anonymizer/claim")).status, 204, "a failed job is not handed out again by itself");

    // only an admin queues it again, and only when it failed
    assert.equal((await r.worker.client.post(`/api/admin/recordings/${r.id}/reanonymize`)).status, 403);
    assert.equal((await admin.post(`/api/admin/recordings/${r.id}/reanonymize`)).status, 200);
    const s2 = await state(r.id);
    assert.equal(s2.anon_state, "pending");
    assert.equal(s2.anon_attempts, 0);
    const again = await admin.post(`/api/admin/recordings/${r.id}/reanonymize`);
    assert.equal(again.status, 409);
    assert.equal(again.body.error, "cannot_reanonymize");
    assert.ok(
      (await t.pool.query("SELECT 1 FROM audit_log WHERE target_id=$1 AND action='recording_anonymize_requeued'", [r.id])).rows.length,
    );
  });

  it("takes a claim back when the worker goes silent, so the old worker cannot finish it", async () => {
    const r = await builtRecording("lease");
    const first = await gpu("POST", "/api/anonymizer/claim");
    assert.equal(first.status, 200);
    await t.pool.query("UPDATE recordings SET anon_lease_until = now() - interval '1 minute' WHERE id = $1", [r.id]);

    // an expired lease is already refused...
    const late = await gpu("GET", `/api/anonymizer/${r.id}/source`, { lease: first.body.leaseId });
    assert.equal(late.status, 409);
    assert.equal(late.body.error, "lease_lost");
    assert.equal((await gpu("POST", `/api/anonymizer/${r.id}/heartbeat`, { lease: first.body.leaseId })).status, 409);

    // ...and the next claim gets the job again, with a new lease
    const second = await gpu("POST", "/api/anonymizer/claim");
    assert.equal(second.status, 200);
    assert.equal(second.body.id, r.id);
    assert.notEqual(second.body.leaseId, first.body.leaseId);
    assert.equal(second.body.attempt, 2);
    const stale = Buffer.from("old worker result");
    const lost = await gpu("PUT", `/api/anonymizer/${r.id}/result`, {
      lease: first.body.leaseId,
      body: stale,
      headers: { "x-sha256": sha256(stale) },
    });
    assert.equal(lost.status, 409, "the old worker's lease no longer matches");
    assert.equal((await state(r.id)).anon_state, "running");
    assert.equal((await gpu("POST", `/api/anonymizer/${r.id}/fail`, { lease: first.body.leaseId, body: { error: "late" } })).status, 409);
  });

  it("fails a job whose worker kept disappearing, and the sweep reports it", async () => {
    const r = await builtRecording("gives-up");
    await t.pool.query(
      "UPDATE recordings SET anon_state = 'running', anon_attempts = $2, anon_lease_id = gen_random_uuid(), anon_lease_until = now() - interval '1 minute' WHERE id = $1",
      [r.id, t.config.anonymizer.maxAttempts],
    );
    const { expireLeases } = await import("../../server/services/anonymize.ts");
    assert.deepEqual(await expireLeases(), { requeued: 0, failed: 1 });
    const s = await state(r.id);
    assert.equal(s.anon_state, "failed");
    assert.match(s.anon_error, /stopped answering/);
    assert.equal((await gpu("POST", "/api/anonymizer/claim")).status, 204);
    assert.ok(
      (await t.pool.query("SELECT 1 FROM audit_log WHERE target_id=$1 AND action='recording_anonymize_failed'", [r.id])).rows.length,
    );
  });
});

describe("with whole-video copies switched off (the default)", () => {
  it("queues nothing, hands nothing out, hides a stuck state, and refuses to queue again", async () => {
    t.config.anonymizer.videoEnabled = false;
    try {
      const r = await builtRecording("video-off");
      assert.equal((await state(r.id)).anon_state, "none", "building the video does not queue a copy");
      assert.equal((await gpu("POST", "/api/anonymizer/claim")).status, 204, "nothing is handed out");

      // a job that was already waiting before the switch is reported as nothing, not as "anonymizing…" for ever
      await t.pool.query("UPDATE recordings SET anon_state = 'pending' WHERE id = $1", [r.id]);
      assert.equal((await gpu("POST", "/api/anonymizer/claim")).status, 204, "still not handed out");
      const mine = await r.worker.client.get(`/api/me/assignments/${r.assignmentId}`);
      assert.equal(mine.body.recordings[0].anonymization, "none");
      const list = (await admin.get("/api/admin/recordings")).body.find((x: any) => x.id === r.id);
      assert.equal(list.anonymization, "none");

      // a copy that exists stays visible
      await t.pool.query("UPDATE recordings SET anon_state = 'done' WHERE id = $1", [r.id]);
      assert.equal((await admin.get("/api/admin/recordings")).body.find((x: any) => x.id === r.id).anonymization, "done");
      await t.pool.query("UPDATE recordings SET anon_state = 'failed' WHERE id = $1", [r.id]);

      const again = await admin.post(`/api/admin/recordings/${r.id}/reanonymize`);
      assert.equal(again.status, 409);
      assert.equal(again.body.error, "video_anonymization_off");
      assert.equal((await state(r.id)).anon_state, "failed", "nothing changed");

      // the worker still downloads its own video: the original
      const own = await r.worker.client.get(`/api/me/recordings/${r.id}/download?variant=original`);
      assert.equal(own.status, 200);
      assert.ok(own.bytes.equals(r.original));
    } finally {
      t.config.anonymizer.videoEnabled = true;
    }
  });
});
