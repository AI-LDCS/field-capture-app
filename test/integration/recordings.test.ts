import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Client, sha256, startTestServer } from "./helpers.ts";

let t: Awaited<ReturnType<typeof startTestServer>>;
const ADMIN = { username: "testadmin", password: "initial-admin-password-1" };
const UA = "worker-password-1";

before(async () => {
  t = await startTestServer();
});
after(async () => {
  await t.stop();
});

async function adminClient() {
  const c = new Client(t.base);
  assert.equal((await c.post("/api/auth/login", ADMIN)).status, 200);
  return c;
}
async function makeWorker(admin: Client, username: string) {
  const r = await admin.post("/api/admin/users", { username, displayName: username, password: UA });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const c = new Client(t.base);
  assert.equal((await c.post("/api/auth/login", { username, password: UA })).status, 200);
  return { client: c, id: r.body.user.id as string };
}

// one curved required segment (a big arc), one straight optional segment
const ARC = [
  [100.5, 13.75],
  [100.5012, 13.7515],
  [100.5024, 13.75],
];
const OPT = [
  [100.503, 13.75],
  [100.5045, 13.75],
];

async function publish(admin: Client, name: string, segs?: any[]) {
  const r = await admin.post("/api/admin/routes", {
    name,
    segments: segs ?? [
      { required: true, smooth: true, coords: ARC },
      { required: false, coords: OPT },
    ],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const p = await admin.post(`/api/admin/route-versions/${r.body.id}/publish`);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  return p.body;
}
async function assign(admin: Client, versionId: string, userId: string) {
  const r = await admin.post("/api/admin/assignments", { routeVersionId: versionId, userId });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

type P = { seq: number; t: number; lat: number; lng: number; acc: number };
/** GPS fixes every ~10 m along a line, one per second */
function walk(coords: number[][], from = Date.now() - 600_000, acc = 6): P[] {
  const pts: P[] = [];
  let seq = 0;
  for (let i = 0; i < coords.length; i += 5) pts.push({ seq: seq++, t: from + seq * 1000, lng: coords[i][0], lat: coords[i][1], acc });
  const last = coords[coords.length - 1];
  pts.push({ seq: seq, t: from + seq * 1000, lng: last[0], lat: last[1], acc });
  return pts;
}
const chunksOf = (n: number, size = 3000) => Array.from({ length: n }, (_, i) => crypto.randomBytes(size + i));

async function register(c: Client, assignmentId: string, id = crypto.randomUUID(), extra: object = {}) {
  const r = await c.post("/api/me/recordings", {
    id,
    assignmentId,
    mime: "video/webm;codecs=vp9",
    startedAt: Date.now() - 600_000,
    ...extra,
  });
  return { id, res: r };
}
const putChunk = (c: Client, id: string, seq: number, b: Buffer, hash = sha256(b)) =>
  c.putRaw(`/api/me/recordings/${id}/chunks/${seq}`, b, { "x-sha256": hash });
const manifest = (chunks: Buffer[], gps: P[]) => ({
  endedAt: Date.now(),
  chunks: chunks.map((b, seq) => ({ seq, sha256: sha256(b) })),
  gpsCount: gps.length,
});

/** register + chunks + gps + finalize */
async function upload(c: Client, assignmentId: string, chunks: Buffer[], gps: P[], extra: object = {}) {
  const { id, res } = await register(c, assignmentId, crypto.randomUUID(), extra);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  for (const [i, b] of chunks.entries()) assert.equal((await putChunk(c, id, i, b)).status, 200);
  assert.equal((await c.post(`/api/me/recordings/${id}/gps`, { points: gps })).status, 200);
  const fin = await c.post(`/api/me/recordings/${id}/finalize`, manifest(chunks, gps));
  assert.equal(fin.status, 200, JSON.stringify(fin.body));
  return id;
}
async function assembled(id: string) {
  await t.kickAssembler();
  for (let i = 0; i < 100; i++) {
    const { rows } = await t.pool.query("SELECT assembly_state, assembly_error FROM recordings WHERE id = $1", [id]);
    if (rows[0].assembly_state === "done") return;
    if (rows[0].assembly_state === "failed") throw new Error("assembly failed: " + rows[0].assembly_error);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("assembly did not finish");
}
async function curveOf(c: Client, assignmentId: string): Promise<number[][]> {
  return (await c.get(`/api/me/assignments/${assignmentId}`)).body.segments[0].coords;
}

describe("ownership", () => {
  it("worker B cannot register on, upload to, read, finalize or delete worker A's recording; a reused id is a plain 404", async () => {
    const admin = await adminClient();
    const a = await makeWorker(admin, "own-a"),
      b = await makeWorker(admin, "own-b");
    const v = await publish(admin, "Own");
    const asgA = await assign(admin, v.id, a.id);
    const { id, res } = await register(a.client, asgA.id);
    assert.equal(res.status, 201);

    assert.equal((await register(b.client, asgA.id)).res.status, 404, "register on someone else's assignment");
    assert.equal((await register(b.client, asgA.id, id)).res.status, 404, "reusing A's recording id must not say 'existing'");
    const chunk = crypto.randomBytes(2000);
    assert.equal((await putChunk(b.client, id, 0, chunk)).status, 404);
    assert.equal((await b.client.get(`/api/me/recordings/${id}/status`)).status, 404);
    assert.equal((await b.client.get(`/api/me/recordings/${id}/gps`)).status, 404);
    assert.equal((await a.client.get(`/api/me/recordings/${id}/gps`)).status, 200);
    assert.equal((await b.client.post(`/api/me/recordings/${id}/gps`, { points: [{ seq: 0, t: 1, lat: 1, lng: 1, acc: 1 }] })).status, 404);
    assert.equal((await b.client.post(`/api/me/recordings/${id}/finalize`, manifest([chunk], []))).status, 404);
    assert.equal((await b.client.del(`/api/me/recordings/${id}`)).status, 404);
    // A is untouched and can still register the same id again
    assert.equal((await register(a.client, asgA.id, id)).res.body.existing, true);
  });

  it("registering is idempotent, rejects simulated data unless dev tools are on, and a completed assignment takes no new recordings", async () => {
    const admin = await adminClient();
    const w = await makeWorker(admin, "reg-idem");
    const v = await publish(admin, "Reg");
    const asg = await assign(admin, v.id, w.id);
    const { id, res } = await register(w.client, asg.id);
    assert.equal(res.status, 201);
    assert.equal((await register(w.client, asg.id, id)).res.body.existing, true);
    assert.equal((await register(w.client, asg.id, crypto.randomUUID(), { simulated: true })).res.status, 400);
    t.config.devTools = true;
    try {
      assert.equal((await register(w.client, asg.id, crypto.randomUUID(), { simulated: true })).res.status, 201);
    } finally {
      t.config.devTools = false;
    }
    assert.equal((await w.client.get(`/api/me/assignments/${asg.id}`)).body.status, "in_progress");

    await t.pool.query("UPDATE assignments SET status='completed' WHERE id=$1", [asg.id]);
    assert.equal((await register(w.client, asg.id)).res.status, 409);
  });
});

describe("chunk upload", () => {
  it("422 on a bad checksum, 200 on a duplicate, 409 on conflicting data, 415 for other content types", async () => {
    const admin = await adminClient();
    const w = await makeWorker(admin, "chunker");
    const v = await publish(admin, "Chunks");
    const asg = await assign(admin, v.id, w.id);
    const { id } = await register(w.client, asg.id);
    const b = crypto.randomBytes(5000);
    assert.equal((await putChunk(w.client, id, 0, b, "0".repeat(64))).status, 422);
    assert.equal((await putChunk(w.client, id, 0, b)).status, 200);
    assert.equal((await putChunk(w.client, id, 0, b)).body.duplicate, true);
    const other = crypto.randomBytes(5000);
    assert.equal((await putChunk(w.client, id, 0, other)).status, 409);
    assert.equal((await putChunk(w.client, id, 100000, b)).status, 400);
    assert.equal((await putChunk(w.client, id, -1, b)).status, 415, "a malformed path is not the chunk route");

    // raw bytes are allowed on this one route only, and only as octet-stream
    const txt = await w.client.req("PUT", `/api/me/recordings/${id}/chunks/1`, "plain text", {
      "content-type": "text/plain",
      "x-sha256": sha256(Buffer.from("plain text")),
    });
    assert.equal(txt.status, 415);
    const form = await w.client.req("PUT", `/api/me/recordings/${id}/chunks/1`, "a=b", {
      "content-type": "application/x-www-form-urlencoded",
    });
    assert.equal(form.status, 415);
    const elsewhere = await new Client(t.base).req("POST", "/api/auth/login", Buffer.from("{}"), {
      "content-type": "application/octet-stream",
    });
    assert.equal(elsewhere.status, 415, "octet-stream must not be accepted on other routes");
    const evil = await new Client(t.base, "https://evil.example").putRaw(`/api/me/recordings/${id}/chunks/1`, b, { "x-sha256": sha256(b) });
    assert.equal(evil.status, 403);

    const st = await w.client.get(`/api/me/recordings/${id}/status`);
    assert.deepEqual(st.body.chunkSeqs, [0]);
  });

  it("stores each chunk under a key that includes its hash", async () => {
    const admin = await adminClient();
    const w = await makeWorker(admin, "keyed");
    const asg = await assign(admin, (await publish(admin, "Keyed")).id, w.id);
    const { id } = await register(w.client, asg.id);
    const b = crypto.randomBytes(4000);
    await putChunk(w.client, id, 0, b);
    const keys = await t.storage.listKeys(`rec/${id}/`);
    assert.deepEqual(keys, [`rec/${id}/c/0-${sha256(b)}`]);
  });
});

describe("finalize and assembly", () => {
  it("lists missing chunks, rejects a wrong GPS count, succeeds, and is safe to repeat; a verified recording is frozen", async () => {
    const admin = await adminClient();
    const w = await makeWorker(admin, "finalizer"),
      x = await makeWorker(admin, "finalizer-x");
    const asg = await assign(admin, (await publish(admin, "Fin")).id, w.id);
    const chunks = chunksOf(3);
    const gps = walk(await curveOf(w.client, asg.id));
    const { id } = await register(w.client, asg.id);
    await putChunk(w.client, id, 0, chunks[0]);
    await putChunk(w.client, id, 2, chunks[2]);
    await w.client.post(`/api/me/recordings/${id}/gps`, { points: gps });

    const missing = await w.client.post(`/api/me/recordings/${id}/finalize`, manifest(chunks, gps));
    assert.equal(missing.status, 409);
    assert.deepEqual(missing.body.missingChunks, [1]);
    await putChunk(w.client, id, 1, chunks[1]);
    const wrongGps = await w.client.post(`/api/me/recordings/${id}/finalize`, { ...manifest(chunks, gps), gpsCount: gps.length + 5 });
    assert.equal(wrongGps.status, 409);
    assert.equal(wrongGps.body.gpsOk, false);
    const wrongHash = await w.client.post(`/api/me/recordings/${id}/finalize`, {
      ...manifest(chunks, gps),
      chunks: chunks.map((_, seq) => ({ seq, sha256: sha256(Buffer.from("x" + seq)) })),
    });
    assert.equal(wrongHash.status, 409);

    assert.equal((await x.client.post(`/api/me/recordings/${id}/finalize`, manifest(chunks, gps))).status, 404);
    assert.equal((await w.client.post(`/api/me/recordings/${id}/finalize`, manifest(chunks, gps))).status, 200);
    assert.equal(
      (await w.client.post(`/api/me/recordings/${id}/finalize`, manifest(chunks, gps))).status,
      200,
      "a retried finalize is safe",
    );

    assert.equal((await putChunk(w.client, id, 3, crypto.randomBytes(100))).status, 409, "no new data after verification");
    await assert.rejects(t.pool.query("UPDATE recordings SET chunk_count = 99 WHERE id = $1", [id]), /immutable/);
    await assert.rejects(
      t.pool.query("INSERT INTO gps_points (recording_id, seq, t_ms, lat, lng, acc) VALUES ($1, 9999, 1, 1, 1, 1)", [id]),
      /immutable/,
    );
    await assert.rejects(
      t.pool.query("UPDATE recordings SET user_id = (SELECT id FROM users WHERE username='testadmin') WHERE id = $1", [id]),
      /owner/,
    );
  });

  it("assembles one playable file, serves it with real range responses to admins only, and frees the chunk copies", async () => {
    const admin = await adminClient();
    const w = await makeWorker(admin, "player");
    const asg = await assign(admin, (await publish(admin, "Play")).id, w.id);
    const chunks = chunksOf(4, 6000);
    const id = await upload(w.client, asg.id, chunks, walk(await curveOf(w.client, asg.id)));
    await assembled(id);
    const whole = Buffer.concat(chunks);

    const full = await admin.get(`/api/admin/recordings/${id}/video`);
    assert.equal(full.status, 200);
    assert.ok(full.bytes.equals(whole), "assembled file = chunks in order");
    assert.equal(full.headers.get("accept-ranges"), "bytes");
    assert.equal(full.headers.get("content-type"), "video/webm");

    const part = await admin.get(`/api/admin/recordings/${id}/video`, { range: "bytes=100-199" });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), `bytes 100-199/${whole.length}`);
    assert.ok(part.bytes.equals(whole.subarray(100, 200)));
    assert.equal((await admin.get(`/api/admin/recordings/${id}/video`, { range: `bytes=${whole.length + 10}-` })).status, 416);

    // the admin routes stay admin-only; a worker gets their own files from /api/me (see "worker downloads")
    for (const p of [`/api/admin/recordings/${id}/video`, `/api/admin/recordings/${id}/download`, `/api/admin/recordings/${id}/gps.json`]) {
      assert.equal((await w.client.get(p)).status, 403, p);
    }
    assert.equal((await w.client.get(`/api/me/recordings/${id}/video`)).status, 404);
    assert.equal((await new Client(t.base).get(`/api/admin/recordings/${id}/video`)).status, 401);

    const { rows } = await t.pool.query("SELECT file_key, file_bytes, file_sha256, chunks_purged FROM recordings WHERE id = $1", [id]);
    assert.equal(Number(rows[0].file_bytes), whole.length);
    assert.equal(rows[0].file_sha256, sha256(whole));
    assert.equal(rows[0].chunks_purged, true);
    assert.deepEqual(await t.storage.listKeys(`rec/${id}/`), [rows[0].file_key], "only the assembled file is left");

    const dl = await admin.get(`/api/admin/recordings/${id}/download`);
    assert.equal(dl.status, 200);
    assert.match(dl.headers.get("content-disposition") ?? "", /attachment/);
    const gj = await admin.get(`/api/admin/recordings/${id}/gps.json`);
    assert.ok(gj.body.points[0].videoTimeS !== undefined);
    const audit = (await t.pool.query("SELECT DISTINCT action FROM audit_log WHERE target_id = $1", [id])).rows.map((r) => r.action);
    for (const a of [
      "recording_registered",
      "recording_verified",
      "recording_assembled",
      "recording_viewed",
      "recording_downloaded",
      "gps_downloaded",
    ])
      assert.ok(audit.includes(a), a);
  });

  it("a crash during assembly is picked up again on restart", async () => {
    const admin = await adminClient();
    const w = await makeWorker(admin, "crashy");
    const asg = await assign(admin, (await publish(admin, "Crash")).id, w.id);
    const id = await upload(w.client, asg.id, chunksOf(2, 4000), walk(await curveOf(w.client, asg.id)));
    await assembled(id);
    // pretend the process died halfway: the file is not built yet and the job says "running"
    await t.pool.query(
      "UPDATE recordings SET assembly_state='running', file_key=NULL, file_bytes=NULL, file_sha256=NULL, chunks_purged=false WHERE id=$1",
      [id],
    );
    // the chunk objects were deleted by the first run; put the recording back to a state that can fail cleanly
    const { startAssembler, stopAssembler } = await import("../../server/services/assemble.ts");
    startAssembler();
    for (let i = 0; i < 60; i++) {
      const s = (await t.pool.query("SELECT assembly_state FROM recordings WHERE id=$1", [id])).rows[0].assembly_state;
      if (s === "failed" || s === "done") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    stopAssembler();
    const s = (await t.pool.query("SELECT assembly_state, assembly_error FROM recordings WHERE id=$1", [id])).rows[0];
    // it was picked up (no longer stuck in "running"); with the chunks gone it fails cleanly and says why
    assert.notEqual(s.assembly_state, "running");
    assert.equal(s.assembly_state, "failed");
    assert.ok(s.assembly_error);
  });

  it("with ffmpeg, the assembled video gets a real duration and can be seeked (real WebM, split at arbitrary points)", {
    skip: !hasFfmpeg(),
  }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fc-test-"));
    try {
      const src = path.join(dir, "src.webm");
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=duration=2:size=320x240:rate=15",
        "-c:v",
        "libvpx",
        "-b:v",
        "300k",
        "-f",
        "webm",
        src,
      ]);
      const bytes = fs.readFileSync(src);
      const cuts = [0, Math.floor(bytes.length / 3), Math.floor((2 * bytes.length) / 3), bytes.length];
      const chunks = cuts.slice(1).map((c, i) => bytes.subarray(cuts[i], c));

      const admin = await adminClient();
      const w = await makeWorker(admin, "remuxer");
      const asg = await assign(admin, (await publish(admin, "Remux")).id, w.id);
      t.config.assembly.remux = true;
      let id: string;
      try {
        id = await upload(w.client, asg.id, chunks, walk(await curveOf(w.client, asg.id)));
        await assembled(id);
      } finally {
        t.config.assembly.remux = false;
      }
      const out = path.join(dir, "out.webm");
      fs.writeFileSync(out, (await admin.get(`/api/admin/recordings/${id}/video`)).bytes);
      const dur = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", out])
        .toString()
        .trim();
      assert.ok(Number(dur) > 1.5 && Number(dur) < 2.6, `duration ${dur}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

function hasFfmpeg() {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("who decides completion", () => {
  it("unverified is pending_sync; short coverage stays in progress; walking the curve completes; the straight chord does not", async () => {
    const admin = await adminClient();
    const w = await makeWorker(admin, "decider");
    const asg = await assign(admin, (await publish(admin, "Decide")).id, w.id);
    const curve = await curveOf(w.client, asg.id);
    assert.ok(curve.length > 50, "the worker's segment is the dense curve");

    // a recording that is still uploading
    const { id: openId } = await register(w.client, asg.id);
    await putChunk(w.client, openId, 0, crypto.randomBytes(1000));
    let f = await w.client.post(`/api/me/assignments/${asg.id}/finish`);
    assert.equal(f.body.status, "pending_sync");
    await w.client.del(`/api/me/recordings/${openId}`).catch(() => {});
    await t.pool.query("DELETE FROM recording_chunks WHERE recording_id=$1", [openId]);
    assert.equal((await w.client.del(`/api/me/recordings/${openId}`)).status, 200);

    // straight line from start to end of the arc: far from the curve in the middle
    const chord: number[][] = Array.from({ length: 60 }, (_, i) => [ARC[0][0] + ((ARC[2][0] - ARC[0][0]) * i) / 59, ARC[0][1]]);
    await upload(w.client, asg.id, chunksOf(2), walk(chord));
    f = await w.client.post(`/api/me/assignments/${asg.id}/finish`);
    assert.equal(f.body.status, "in_progress", "walking the chord must not count");
    assert.ok(f.body.segments[0].coverage < 0.9, `coverage ${f.body.segments[0].coverage}`);
    assert.ok(f.body.reasons.some((r: string) => /required segment 1/.test(r)));

    // half of the curve: still short
    await upload(w.client, asg.id, chunksOf(2), walk(curve.slice(0, Math.floor(curve.length * 0.5))));
    f = await w.client.post(`/api/me/assignments/${asg.id}/finish`);
    assert.equal(f.body.status, "in_progress");

    // the whole curve, with a passed preflight
    await w.client.post(`/api/me/assignments/${asg.id}/preflight`, { result: "passed", durationMs: 15000, samples: 15, bestAccuracyM: 4 });
    await upload(w.client, asg.id, chunksOf(2), walk(curve));
    f = await w.client.post(`/api/me/assignments/${asg.id}/finish`);
    assert.equal(f.body.status, "completed", JSON.stringify(f.body.reasons));
    assert.ok(f.body.segments[0].coverage >= 0.9);
    assert.equal(f.body.segments[1].status, "pending", "the optional segment was never walked and need not be");
    assert.ok(
      f.body.segments[0].evidence.length >= 1 && f.body.segments[0].evidence[0].firstTMs,
      "evidence records when the segment was covered",
    );

    // done is done
    assert.equal((await register(w.client, asg.id)).res.status, 409);
    assert.equal(
      (await w.client.post(`/api/me/assignments/${asg.id}/preflight`, { result: "passed", durationMs: 1, samples: 1, bestAccuracyM: 1 }))
        .status,
      409,
    );
  });

  it("a skipped GPS check, poor accuracy or simulated data sends it to review; an admin approves or sends it back", async () => {
    const admin = await adminClient();
    const w = await makeWorker(admin, "reviewme");
    const v = await publish(admin, "Review");
    const asg = await assign(admin, v.id, w.id);
    const curve = await curveOf(w.client, asg.id);
    await w.client.post(`/api/me/assignments/${asg.id}/preflight`, {
      result: "skipped",
      durationMs: 90000,
      samples: 3,
      bestAccuracyM: 40,
      note: "accuracy 40 m > 15 m",
    });
    await upload(w.client, asg.id, chunksOf(2), walk(curve));
    const f = await w.client.post(`/api/me/assignments/${asg.id}/finish`);
    assert.equal(f.body.status, "needs_review");
    assert.ok(f.body.reasons.includes("GPS check was skipped"));

    assert.equal((await w.client.post(`/api/admin/assignments/${asg.id}/review`, { decision: "approve" })).status, 403);
    const back = await admin.post(`/api/admin/assignments/${asg.id}/review`, { decision: "reject" });
    assert.equal(back.body.status, "in_progress");
    assert.equal(
      (await admin.post(`/api/admin/assignments/${asg.id}/review`, { decision: "approve" })).status,
      409,
      "no longer waiting for review",
    );
    const again = await admin.post(`/api/admin/assignments/${asg.id}/re-evaluate`);
    assert.equal(again.body.status, "needs_review");
    const ok = await admin.post(`/api/admin/assignments/${asg.id}/review`, { decision: "approve" });
    assert.equal(ok.body.status, "completed");

    // simulated data never passes as real
    const x = await makeWorker(admin, "faker");
    const asgX = await assign(admin, v.id, x.id);
    await x.client.post(`/api/me/assignments/${asgX.id}/preflight`, { result: "passed", durationMs: 9000, samples: 9, bestAccuracyM: 5 });
    t.config.devTools = true;
    try {
      await upload(x.client, asgX.id, chunksOf(2), walk(await curveOf(x.client, asgX.id)), { simulated: true });
    } finally {
      t.config.devTools = false;
    }
    const fx = await x.client.post(`/api/me/assignments/${asgX.id}/finish`);
    assert.equal(fx.body.status, "needs_review");
    assert.ok(fx.body.reasons.some((r: string) => /simulated/.test(r)));
  });

  it("poor accuracy points are kept but do not count toward coverage", async () => {
    const admin = await adminClient();
    const w = await makeWorker(admin, "fuzzy");
    const asg = await assign(admin, (await publish(admin, "Fuzzy")).id, w.id);
    await upload(w.client, asg.id, chunksOf(2), walk(await curveOf(w.client, asg.id), Date.now() - 600_000, 80));
    const f = await w.client.post(`/api/me/assignments/${asg.id}/finish`);
    assert.equal(f.body.status, "in_progress");
    assert.equal(f.body.segments[0].coverage, 0);
    assert.ok(f.body.recordings[0].gpsCount > 10, "the points are still stored");
  });

  it("required segments cannot be skipped; optional ones can, and be un-skipped", async () => {
    const admin = await adminClient();
    const w = await makeWorker(admin, "skip-w");
    const asg = await assign(admin, (await publish(admin, "Skip")).id, w.id);
    const [req, opt] = (await w.client.get(`/api/me/assignments/${asg.id}`)).body.segments;
    assert.equal((await w.client.post(`/api/me/assignments/${asg.id}/segments/${req.id}/skip`, { reason: "no" })).status, 400);
    const s = await w.client.post(`/api/me/assignments/${asg.id}/segments/${opt.id}/skip`, { reason: "blocked by a market" });
    assert.equal(s.status, 200);
    assert.equal(s.body.segments[1].status, "skipped");
    assert.equal(s.body.segments[1].skipReason, "blocked by a market");
    assert.equal((await w.client.post(`/api/me/assignments/${asg.id}/segments/${opt.id}/unskip`)).body.segments[1].status, "pending");
    // someone else's assignment: nothing found
    const other = await makeWorker(admin, "skip-other");
    assert.equal((await other.client.post(`/api/me/assignments/${asg.id}/segments/${opt.id}/skip`, {})).status, 404);
  });
});

describe("export", () => {
  it("admins get a streamed zip and a json; workers get 403; the export is audited", async () => {
    const admin = await adminClient();
    const w = await makeWorker(admin, "exporter");
    const asg = await assign(admin, (await publish(admin, "Export")).id, w.id);
    const chunks = chunksOf(3, 5000);
    const id = await upload(w.client, asg.id, chunks, walk(await curveOf(w.client, asg.id)));
    await assembled(id);

    assert.equal((await w.client.get(`/api/admin/assignments/${asg.id}/export.zip`)).status, 403);
    const zip = await admin.get(`/api/admin/assignments/${asg.id}/export.zip`);
    assert.equal(zip.status, 200);
    assert.match(zip.headers.get("content-disposition") ?? "", /\.zip/);
    assert.equal(zip.bytes.subarray(0, 2).toString(), "PK");
    const text = zip.bytes.toString("latin1");
    for (const name of ["assignment.json", `gps-1-${id.slice(0, 8)}.json`, `recording-1-${id.slice(0, 8)}.webm`])
      assert.ok(text.includes(name), name);
    assert.ok(zip.bytes.includes(Buffer.concat(chunks).subarray(0, 4000)), "the video bytes are inside (stored, not compressed)");

    const js = await admin.get(`/api/admin/assignments/${asg.id}/export.json`);
    assert.equal(js.body.recordings.length, 1);
    assert.ok(js.body.routeGeoJSON.features.length === 2);
    assert.ok((await t.pool.query("SELECT 1 FROM audit_log WHERE action='assignment_exported' AND target_id=$1", [asg.id])).rowCount! >= 2);
    // an assignment with nothing verified has nothing to zip
    const w2 = await makeWorker(admin, "exporter2");
    const asg2 = await assign(admin, (await publish(admin, "Empty export")).id, w2.id);
    assert.equal((await admin.get(`/api/admin/assignments/${asg2.id}/export.zip`)).status, 409);
  });
});

describe("worker downloads", () => {
  it("a worker can download their own verified video and GPS, but not someone else's, and not before it is on the server", async () => {
    const admin = await adminClient();
    const mine = await makeWorker(admin, "dl-owner");
    const other = await makeWorker(admin, "dl-other");
    const asg = await assign(admin, (await publish(admin, "Worker download")).id, mine.id);
    const chunks = chunksOf(3, 5000);
    const id = await upload(mine.client, asg.id, chunks, walk(await curveOf(mine.client, asg.id)));
    await assembled(id);

    const video = await mine.client.get(`/api/me/recordings/${id}/download`);
    assert.equal(video.status, 200);
    assert.match(video.headers.get("content-disposition") ?? "", /attachment; filename="recording-[0-9a-f]{8}\.webm"/);
    assert.ok(video.bytes.equals(Buffer.concat(chunks)), "the same bytes that were uploaded");
    const gps = await mine.client.get(`/api/me/recordings/${id}/gps.json`);
    assert.equal(gps.status, 200);
    assert.match(gps.headers.get("content-disposition") ?? "", /attachment/);
    assert.equal(gps.body.recordingId, id);
    assert.ok(gps.body.points.length > 0 && gps.body.points[0].videoTimeS !== undefined);

    // another worker's id looks exactly like a missing one; nobody signed in gets 401; an admin account has no worker routes
    for (const p of [`/api/me/recordings/${id}/download`, `/api/me/recordings/${id}/gps.json`]) {
      assert.equal((await other.client.get(p)).status, 404, p);
      assert.equal((await new Client(t.base).get(p)).status, 401, p);
      assert.equal((await admin.get(p)).status, 403, p);
    }
    assert.equal((await mine.client.get(`/api/me/recordings/${crypto.randomUUID()}/download`)).status, 404);

    // not on the server yet: registered but never verified
    const half = await register(mine.client, asg.id);
    assert.equal(half.res.status, 201);
    for (const p of [`/api/me/recordings/${half.id}/download`, `/api/me/recordings/${half.id}/gps.json`]) {
      const r = await mine.client.get(p);
      assert.equal(r.status, 409, p);
      assert.equal(r.body.error, "not_verified");
    }

    // verified but the video is still being built: the GPS is available, the video says so
    await t.pool.query("UPDATE recordings SET assembly_state = 'pending' WHERE id = $1", [id]);
    const early = await mine.client.get(`/api/me/recordings/${id}/download`);
    assert.equal(early.status, 409);
    assert.equal(early.body.error, "not_ready");
    assert.equal((await mine.client.get(`/api/me/recordings/${id}/gps.json`)).status, 200);
    await t.pool.query("UPDATE recordings SET assembly_state = 'done' WHERE id = $1", [id]);

    // audited, and marked as done by the worker
    const rows = (
      await t.pool.query(
        "SELECT action, details FROM audit_log WHERE target_id = $1 AND action IN ('recording_downloaded','gps_downloaded')",
        [id],
      )
    ).rows;
    assert.ok(rows.some((r) => r.action === "recording_downloaded" && r.details?.by === "worker"));
    assert.ok(rows.some((r) => r.action === "gps_downloaded" && r.details?.by === "worker"));
  });
});

describe("downloads list", () => {
  it("admins get every verified recording with who, which route and what is ready; workers get 403; unverified ones are left out", async () => {
    const admin = await adminClient();
    const w = await makeWorker(admin, "lister");
    const asg = await assign(admin, (await publish(admin, "Listed route")).id, w.id);
    const id = await upload(w.client, asg.id, chunksOf(2, 4000), walk(await curveOf(w.client, asg.id)));
    await assembled(id);
    const half = await register(w.client, asg.id); // registered, never finished: not verified, so not listed
    assert.equal(half.res.status, 201);

    assert.equal((await w.client.get("/api/admin/recordings")).status, 403);
    assert.equal((await new Client(t.base).get("/api/admin/recordings")).status, 401);
    const list = await admin.get("/api/admin/recordings");
    assert.equal(list.status, 200);
    const row = list.body.find((r: any) => r.id === id);
    assert.ok(row, "the verified recording is listed");
    assert.equal(row.assignmentId, asg.id);
    assert.equal(row.worker.username, "lister");
    assert.equal(row.route.name, "Listed route");
    assert.equal(row.assembly, "done");
    assert.ok(row.fileBytes > 0 && row.gpsCount > 0);
    assert.ok(!list.body.some((r: any) => r.id === half.id), "unverified recordings are not offered for download");

    // deleting the worker keeps the row, marked
    await admin.del(`/api/admin/users/${w.id}`);
    assert.equal((await admin.get("/api/admin/recordings")).body.find((r: any) => r.id === id).worker.deleted, true);
  });
});

describe("misc", () => {
  it("/api/auth/me says whether dev tools are on", async () => {
    const admin = await adminClient();
    assert.equal((await admin.get("/api/auth/me")).body.devTools, false);
  });
});
