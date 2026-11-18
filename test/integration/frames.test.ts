import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, describe, it } from "node:test";
import { ANON_TOKEN, Client, adminLogin, createWorker, publishRoute, sha256, startTestServer } from "./helpers.ts";

/**
 * The still images: the queue the GPU worker pulls from (in order, one assignment's recordings carry on from each
 * other), what it uploads, and who may download what. The worker below is a stand-in that speaks the same HTTP as
 * video-anonymizer/worker.py.
 */
let t: Awaited<ReturnType<typeof startTestServer>>;
let admin: Client;
before(async () => {
  t = await startTestServer();
  admin = await adminLogin(t.base);
});
after(async () => {
  await t.stop();
});

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
    headers["content-type"] = "image/png";
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

type Worker = Awaited<ReturnType<typeof createWorker>>;

async function assignment(w: Worker, label: string, purpose?: "training" | "inference") {
  const route = await publishRoute(admin, `Route ${label}`);
  const r = await admin.post("/api/admin/assignments", { routeVersionId: route.id, userId: w.id, ...(purpose ? { purpose } : {}) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body as { id: string; purpose: string; route: { id: string }; segments: { coords: number[][] }[] };
}

/** A verified, built recording of an assignment. `ageMs` orders recordings of one assignment (bigger = earlier). */
async function builtRecording(w: Worker, asg: Awaited<ReturnType<typeof assignment>>, ageMs: number) {
  const id = crypto.randomUUID();
  const chunks = [crypto.randomBytes(5000), crypto.randomBytes(4000)];
  const start = Date.now() - ageMs;
  const pts = asg.segments[0].coords
    .filter((_, i) => i % 5 === 0)
    .map((c, i) => ({ seq: i, t: start + i * 1000, lng: c[0], lat: c[1], acc: 5 }));
  assert.equal((await w.client.post("/api/me/recordings", { id, assignmentId: asg.id, mime: "video/webm", startedAt: start })).status, 201);
  for (const [i, b] of chunks.entries())
    assert.equal((await w.client.putRaw(`/api/me/recordings/${id}/chunks/${i}`, b, { "x-sha256": sha256(b) })).status, 200);
  assert.equal((await w.client.post(`/api/me/recordings/${id}/gps`, { points: pts })).status, 200);
  const fin = await w.client.post(`/api/me/recordings/${id}/finalize`, {
    endedAt: start + pts.length * 1000,
    chunks: chunks.map((b, seq) => ({ seq, sha256: sha256(b) })),
    gpsCount: pts.length,
  });
  assert.equal(fin.status, 200, JSON.stringify(fin.body));
  for (let i = 0; i < 100; i++) {
    await t.kickAssembler();
    if ((await t.pool.query("SELECT assembly_state s FROM recordings WHERE id=$1", [id])).rows[0].s === "done") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return { id, original: Buffer.concat(chunks), gpsCount: pts.length };
}

/** Everything else waiting in the shared queue is parked, so a claim can only return the recordings a test made. */
const only = (...ids: string[]) =>
  t.pool.query("UPDATE recordings SET frames_state = 'none' WHERE NOT (id = ANY($1::uuid[])) AND frames_state IN ('pending', 'running')", [
    ids,
  ]);
const row = async (id: string) =>
  (
    await t.pool.query(
      "SELECT frames_state, frames_attempts, frames_error, frames_count, frames_step_m, frames_carry FROM recordings WHERE id=$1",
      [id],
    )
  ).rows[0];

const png = () => crypto.randomBytes(3000);
const meta = (frame: number, over: Record<string, unknown> = {}) => ({
  frame,
  bin: frame,
  file: `abcd1234_${String(frame).padStart(4, "0")}_00${frame}.000s.png`,
  timestamp: "2026-11-03T10:10:58.287Z",
  videoTimeS: frame + 0.5,
  walkedStartM: frame * 3,
  walkedEndM: frame * 3 + 3,
  latitude: 13.7270722,
  longitude: 100.7781985,
  accuracyM: 2.5,
  headingDeg: 191.4,
  sharpness: 1000 + frame,
  lowSharpness: false,
  timeUncertain: false,
  afterGap: false,
  gapM: null,
  ...over,
});
const send = (
  id: string,
  lease: string,
  frame: number,
  body = png(),
  over: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) =>
  gpu("PUT", `/api/anonymizer/frames/${id}/image/${frame}`, {
    lease,
    body,
    headers: { "x-sha256": sha256(body), "x-frame": encodeURIComponent(JSON.stringify(meta(frame, over))), ...headers },
  });
const carry = (cumM: number, nextFrame: number) => ({ cumM, nextFrame, lastLat: 13.7270722, lastLng: 100.7781985 });
const done = (count: number, c = carry(9, count)) => ({ count, stepM: 3, mode: "pixelgauss", carry: c });

/** Claims, uploads `count` images and completes. Returns the claim. */
async function process(count: number, c = carry(9, count)) {
  const claim = await gpu("POST", "/api/anonymizer/frames/claim");
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  const lease = claim.body.leaseId as string;
  const first = claim.body.carry?.nextFrame ?? 0;
  for (let i = 0; i < count; i++) assert.equal((await send(claim.body.id, lease, first + i)).status, 200);
  assert.equal((await gpu("POST", `/api/anonymizer/frames/${claim.body.id}/complete`, { lease, body: done(count, c) })).status, 200);
  return claim.body;
}

describe("who may call the frames worker routes", () => {
  it("needs the worker token, like the video routes", async () => {
    assert.equal((await gpu("POST", "/api/anonymizer/frames/claim", { token: null })).status, 401);
    assert.equal((await gpu("POST", "/api/anonymizer/frames/claim", { token: "x".repeat(40) })).status, 401);
    assert.equal((await admin.post("/api/anonymizer/frames/claim")).status, 401, "an admin cookie is not a token");
  });
  it("claims nothing when nothing is waiting", async () => {
    await only();
    assert.equal((await gpu("POST", "/api/anonymizer/frames/claim")).status, 204);
  });
});

describe("the frames round trip", () => {
  it("queues after the build, hands out the video and GPS, checks every image, and stores what it is sent", async () => {
    const w = await createWorker(t.base, admin, "frames-rt");
    const asg = await assignment(w, "rt", "inference");
    const r = await builtRecording(w, asg, 300_000);
    await only(r.id);
    assert.equal((await row(r.id)).frames_state, "pending", "building the video queues the job");

    const claim = await gpu("POST", "/api/anonymizer/frames/claim");
    assert.equal(claim.status, 200);
    const c = claim.body;
    assert.equal(c.id, r.id);
    assert.equal(c.stepM, t.config.frames.stepM);
    assert.equal(c.gapMaxM, t.config.frames.gapMaxM);
    assert.equal(c.purpose, "inference");
    assert.equal(c.embed, true, "inference images carry GPS and IDs");
    assert.equal(c.assignmentId, asg.id);
    assert.equal(c.routeId, asg.route.id);
    assert.equal(c.recordingId, r.id);
    assert.equal(c.recordingIndex, 1);
    assert.equal(c.carry, null, "the first recording has nothing to carry on from");
    assert.equal(c.gps.length, r.gpsCount);
    assert.ok(c.gps[0].videoTimeS !== undefined && c.gps[0].latitude !== undefined);
    assert.equal(c.bytes, r.original.length);
    assert.equal(c.sha256, sha256(r.original));
    const lease = c.leaseId as string;
    assert.equal((await gpu("POST", "/api/anonymizer/frames/claim")).status, 204, "a claimed recording is not handed out twice");

    // the video: only with the claim's lease
    assert.equal((await gpu("GET", `/api/anonymizer/frames/${r.id}/source`)).status, 400, "no lease");
    assert.equal((await gpu("GET", `/api/anonymizer/frames/${r.id}/source`, { lease: crypto.randomUUID() })).body.error, "lease_lost");
    assert.equal((await gpu("GET", `/api/anonymizer/frames/${crypto.randomUUID()}/source`, { lease })).status, 404);
    const src = await gpu("GET", `/api/anonymizer/frames/${r.id}/source`, { lease });
    assert.equal(src.status, 200);
    assert.ok(src.bytes.equals(r.original));
    assert.equal((await gpu("POST", `/api/anonymizer/frames/${r.id}/heartbeat`, { lease })).status, 200);

    // images are checked before they count
    const body = png();
    assert.equal(
      (
        await gpu("PUT", `/api/anonymizer/frames/${r.id}/image/0`, {
          lease,
          body,
          headers: { "x-frame": encodeURIComponent(JSON.stringify(meta(0))) },
        })
      ).body.error,
      "bad_checksum",
    );
    assert.equal((await send(r.id, lease, 0, body, {}, { "x-sha256": "0".repeat(64) })).body.error, "checksum_mismatch");
    assert.equal((await send(r.id, lease, 0, body, {}, { "x-frame": "not json" })).body.error, "bad_frame");
    assert.equal((await send(r.id, lease, 0, body, { latitude: 123 })).body.error, "bad_frame", "outside the world");
    assert.equal((await send(r.id, lease, 1, body, { frame: 0 })).body.error, "bad_frame", "path and header disagree");
    assert.equal(
      (await t.pool.query("SELECT count(*)::int n FROM recording_frames WHERE recording_id=$1", [r.id])).rows[0].n,
      0,
      "nothing stored yet",
    );

    const images = [png(), png(), png()];
    for (const [i, b] of images.entries()) assert.equal((await send(r.id, lease, i, b, i === 0 ? { headingDeg: null } : {})).status, 200);
    assert.equal((await send(r.id, lease, 1, images[1])).status, 200, "sending a frame again is harmless");
    assert.equal((await t.pool.query("SELECT count(*)::int n FROM recording_frames WHERE recording_id=$1", [r.id])).rows[0].n, 3);

    // complete only when the server holds exactly what the worker says
    const wrong = await gpu("POST", `/api/anonymizer/frames/${r.id}/complete`, { lease, body: done(4) });
    assert.equal(wrong.status, 422);
    assert.equal(wrong.body.error, "incomplete");
    assert.equal(
      (await gpu("POST", `/api/anonymizer/frames/${r.id}/complete`, { lease, body: { count: 3 } })).status,
      400,
      "carry state is required",
    );
    assert.equal((await gpu("POST", `/api/anonymizer/frames/${r.id}/complete`, { lease, body: done(3) })).status, 200);
    const s = await row(r.id);
    assert.equal(s.frames_state, "done");
    assert.equal(s.frames_count, 3);
    assert.equal(Number(s.frames_step_m), 3);
    assert.deepEqual(s.frames_carry, carry(9, 3));
    assert.equal(
      (await gpu("POST", `/api/anonymizer/frames/${r.id}/complete`, { lease, body: done(3) })).status,
      409,
      "a finished job is not claimed any more",
    );

    // admin: the list with every image's metadata, then the images themselves
    const list = await admin.get(`/api/admin/recordings/${r.id}/frames`);
    assert.equal(list.status, 200);
    assert.equal(list.body.state, "done");
    assert.equal(list.body.assignmentId, asg.id);
    assert.equal(list.body.routeId, asg.route.id);
    assert.equal(list.body.purpose, "inference");
    assert.equal(list.body.recordingIndex, 1);
    assert.equal(list.body.stepM, 3);
    assert.equal(list.body.frames.length, 3);
    assert.equal(list.body.frames[0].file, "images/abcd1234_0000_000.000s.png");
    assert.equal(list.body.frames[0].headingDeg, null);
    assert.equal(list.body.frames[1].sha256, sha256(images[1]));
    for (const [i, b] of images.entries()) {
      const img = await admin.get(`/api/admin/recordings/${r.id}/frames/${i}`);
      assert.equal(img.status, 200);
      assert.equal(img.headers.get("content-type"), "image/png");
      assert.ok(img.bytes.equals(b), `image ${i} comes back unchanged`);
    }
    assert.equal((await admin.get(`/api/admin/recordings/${r.id}/frames/99`)).status, 404);
    assert.equal((await admin.get(`/api/admin/recordings/${r.id}/frames/x`)).status, 404);

    const zip = await admin.get(`/api/admin/recordings/${r.id}/frames.zip`);
    assert.equal(zip.status, 200);
    assert.match(zip.headers.get("content-type") ?? "", /zip/);
    for (const name of ["frames.json", "manifest.csv", "images/abcd1234_0000_000.000s.png"])
      assert.ok(zip.bytes.includes(name), `${name} is in the zip`);
    assert.ok(zip.bytes.includes(images[2]), "the image bytes are in the zip");

    const asgZip = await admin.get(`/api/admin/assignments/${asg.id}/frames.zip`);
    assert.equal(asgZip.status, 200);
    for (const name of ["route.json", "assignment.json", `recording-1-${r.id.slice(0, 8)}/frames.json`])
      assert.ok(asgZip.bytes.includes(name), `${name} is in the assignment zip`);
    const routeZip = await admin.get(`/api/admin/routes/${asg.route.id}/frames.zip`);
    assert.equal(routeZip.status, 200);
    assert.ok(routeZip.bytes.includes("index.json") && routeZip.bytes.includes("v1/route.json"));
    assert.equal((await admin.get(`/api/admin/routes/${crypto.randomUUID()}/frames.zip`)).status, 404);

    // downloads are audited; single images are not
    const actions = (await t.pool.query("SELECT DISTINCT action FROM audit_log WHERE target_id = $1", [r.id])).rows.map((x) => x.action);
    for (const a of ["recording_frames_started", "recording_frames_done", "frames_downloaded"]) assert.ok(actions.includes(a), a);
  });

  it("an inference assignment's images are for admins only; a training assignment's are the worker's own", async () => {
    const w = await createWorker(t.base, admin, "frames-who");
    const other = await createWorker(t.base, admin, "frames-who-other");
    const inf = await assignment(w, "who-inf"); // inference is the default
    assert.equal(inf.purpose, "inference");
    const trn = await assignment(w, "who-trn", "training");
    assert.equal(trn.purpose, "training");
    const ri = await builtRecording(w, inf, 300_000);
    const rt = await builtRecording(w, trn, 300_000);
    await only(ri.id, rt.id);
    const claimed = [await process(2), await process(2)];
    const training = claimed.find((c) => c.purpose === "training");
    assert.equal(training.embed, false, "training images stay free of GPS and IDs");

    for (const [id, asgId, ok] of [
      [ri.id, inf.id, false],
      [rt.id, trn.id, true],
    ] as const) {
      const status = (p: string) => w.client.get(p).then((x) => x.status);
      assert.equal(await status(`/api/me/recordings/${id}/frames`), ok ? 200 : 404, `list ${ok}`);
      assert.equal(await status(`/api/me/recordings/${id}/frames.zip`), ok ? 200 : 404, `zip ${ok}`);
      assert.equal(await status(`/api/me/assignments/${asgId}/frames.zip`), ok ? 200 : 404, `assignment zip ${ok}`);
      // someone else's recording looks exactly like a missing one
      assert.equal((await other.client.get(`/api/me/recordings/${id}/frames`)).status, 404);
      assert.equal((await other.client.get(`/api/me/recordings/${id}/frames.zip`)).status, 404);
      assert.equal((await other.client.get(`/api/me/assignments/${asgId}/frames.zip`)).status, 404);
    }
    // what the worker sees has no GPS in it
    const mine = await w.client.get(`/api/me/recordings/${rt.id}/frames`);
    assert.equal(mine.body.count, 2);
    assert.deepEqual(Object.keys(mine.body.frames[0]).sort(), ["bytes", "file", "frame"]);
    const zip = await w.client.get(`/api/me/recordings/${rt.id}/frames.zip`);
    assert.ok(zip.bytes.includes("abcd1234_0000"));
    assert.ok(!zip.bytes.includes("frames.json") && !zip.bytes.includes("manifest.csv"), "images only");
    const all = await w.client.get(`/api/me/assignments/${trn.id}/frames.zip`);
    assert.ok(all.bytes.includes("01-abcd1234_0000"), "named so that they sort in walking order");

    // the summaries tell the page what to show
    const sum = await w.client.get(`/api/me/assignments/${trn.id}`);
    assert.equal(sum.body.purpose, "training");
    assert.equal(sum.body.recordings[0].frames.state, "done");
    assert.equal(sum.body.recordings[0].frames.count, 2);
    const dl = (await admin.get("/api/admin/recordings")).body.find((x: any) => x.id === rt.id);
    assert.deepEqual(dl.frames, { state: "done", count: 2 });
  });
});

describe("recordings of one assignment carry on from each other", () => {
  it("makes them in order, and hands each one the counter the one before ended with", async () => {
    const w = await createWorker(t.base, admin, "frames-chain");
    const asg = await assignment(w, "chain");
    const a = await builtRecording(w, asg, 600_000);
    const b = await builtRecording(w, asg, 300_000);
    await only(a.id, b.id);

    const first = await gpu("POST", "/api/anonymizer/frames/claim");
    assert.equal(first.body.id, a.id, "the earlier recording first");
    assert.equal(first.body.recordingIndex, 1);
    assert.equal((await gpu("POST", "/api/anonymizer/frames/claim")).status, 204, "the second waits while the first is running");
    const lease = first.body.leaseId;
    for (let i = 0; i < 3; i++) assert.equal((await send(a.id, lease, i)).status, 200);
    assert.equal((await gpu("POST", `/api/anonymizer/frames/${a.id}/complete`, { lease, body: done(3, carry(10.5, 3)) })).status, 200);

    const second = await gpu("POST", "/api/anonymizer/frames/claim");
    assert.equal(second.body.id, b.id);
    assert.equal(second.body.recordingIndex, 2);
    assert.deepEqual(second.body.carry, carry(10.5, 3), "the counter continues");
    for (const i of [3, 4]) assert.equal((await send(b.id, second.body.leaseId, i)).status, 200);
    assert.equal(
      (await gpu("POST", `/api/anonymizer/frames/${b.id}/complete`, { lease: second.body.leaseId, body: done(2, carry(16, 5)) })).status,
      200,
    );

    const doc = await admin.get(`/api/admin/assignments/${asg.id}/frames.zip`);
    assert.ok(doc.bytes.includes(`recording-2-${b.id.slice(0, 8)}/frames.json`));

    // a recording whose predecessor failed starts a new counter instead of waiting forever
    const c = await builtRecording(w, asg, 100_000);
    await only(c.id);
    await t.pool.query("UPDATE recordings SET frames_state = 'failed' WHERE id = $1", [b.id]);
    const third = await gpu("POST", "/api/anonymizer/frames/claim");
    assert.equal(third.body.id, c.id);
    assert.equal(third.body.carry, null);
    assert.equal(third.body.recordingIndex, 3);
    await gpu("POST", `/api/anonymizer/frames/${c.id}/fail`, { lease: third.body.leaseId, body: { error: "stop" } });
  });
});

describe("when the worker cannot finish", () => {
  it("puts the job back until it has used its attempts, then marks it failed; an admin can queue it again", async () => {
    const w = await createWorker(t.base, admin, "frames-fail");
    const asg = await assignment(w, "fail");
    const r = await builtRecording(w, asg, 300_000);
    await only(r.id);
    for (let attempt = 1; attempt <= t.config.anonymizer.maxAttempts; attempt++) {
      const claim = await gpu("POST", "/api/anonymizer/frames/claim");
      assert.equal(claim.body.attempt, attempt);
      assert.equal((await send(r.id, claim.body.leaseId, 0)).status, 200, "one image gets as far as the server");
      const fail = await gpu("POST", `/api/anonymizer/frames/${r.id}/fail`, { lease: claim.body.leaseId, body: { error: "boom" } });
      assert.equal(fail.status, 200);
      assert.equal(fail.body.retry, attempt < t.config.anonymizer.maxAttempts);
    }
    const s = await row(r.id);
    assert.equal(s.frames_state, "failed");
    assert.equal(s.frames_error, "boom");
    assert.equal((await gpu("POST", "/api/anonymizer/frames/claim")).status, 204);

    // a new claim starts clean: nothing of an abandoned attempt survives
    const rerun = await admin.post(`/api/admin/assignments/${asg.id}/frames/rerun`);
    assert.equal(rerun.status, 200);
    assert.equal(rerun.body.queued, 1);
    assert.equal(rerun.body.stepM, t.config.frames.stepM);
    assert.equal((await row(r.id)).frames_state, "pending");
    assert.deepEqual(await t.storage.listKeys(`rec/${r.id}/frames-`), [], "the abandoned image is gone from storage");
    assert.equal((await admin.post(`/api/admin/assignments/${crypto.randomUUID()}/frames/rerun`)).status, 404);
  });

  it("loses the claim when the worker goes quiet, and refuses what it sends afterwards", async () => {
    const w = await createWorker(t.base, admin, "frames-lease");
    const asg = await assignment(w, "lease");
    const r = await builtRecording(w, asg, 300_000);
    await only(r.id);
    const claim = await gpu("POST", "/api/anonymizer/frames/claim");
    const lease = claim.body.leaseId;
    await t.pool.query("UPDATE recordings SET frames_lease_until = now() - interval '1 minute' WHERE id = $1", [r.id]);
    const late = await send(r.id, lease, 0);
    assert.equal(late.status, 409);
    assert.equal(late.body.error, "lease_lost");
    assert.deepEqual(await t.storage.listKeys(`rec/${r.id}/frames-`), [], "nothing is kept for a lost claim");
    const { expireFrameLeases } = await import("../../server/services/frames.ts");
    assert.deepEqual(await expireFrameLeases(), { requeued: 1, failed: 0 });
    assert.equal((await row(r.id)).frames_state, "pending");
  });

  it("re-running an assignment starts every built recording again, in order, and drops their images", async () => {
    const w = await createWorker(t.base, admin, "frames-rerun");
    const asg = await assignment(w, "rerun");
    const a = await builtRecording(w, asg, 600_000);
    const b = await builtRecording(w, asg, 300_000);
    await only(a.id, b.id);
    await process(2);
    await process(2, carry(12, 4));
    const before = (await t.pool.query("SELECT count(*)::int n FROM recording_frames WHERE recording_id = ANY($1::uuid[])", [[a.id, b.id]]))
      .rows[0].n;
    assert.equal(before, 4);
    const r = await admin.post(`/api/admin/assignments/${asg.id}/frames/rerun`);
    assert.equal(r.body.queued, 2);
    assert.equal(
      (await t.pool.query("SELECT count(*)::int n FROM recording_frames WHERE recording_id = ANY($1::uuid[])", [[a.id, b.id]])).rows[0].n,
      0,
    );
    assert.equal((await row(a.id)).frames_state, "pending");
    assert.equal((await row(b.id)).frames_count, null);
    assert.equal((await gpu("POST", "/api/anonymizer/frames/claim")).body.id, a.id, "the first recording goes first again");
    assert.equal((await admin.get(`/api/admin/assignments/${asg.id}/frames.zip`)).status, 409, "no images until they are made again");
  });
});

describe("assignments and who may see what", () => {
  it("takes a purpose when the route is assigned, and refuses an unknown one", async () => {
    const w = await createWorker(t.base, admin, "frames-purpose");
    const route = await publishRoute(admin, "Route purpose");
    const bad = await admin.post("/api/admin/assignments", { routeVersionId: route.id, userId: w.id, purpose: "whatever" });
    assert.equal(bad.status, 400);
    const ok = await admin.post("/api/admin/assignments", { routeVersionId: route.id, userId: w.id, purpose: "training" });
    assert.equal(ok.body.purpose, "training");
    assert.equal((await admin.get(`/api/admin/assignments/${ok.body.id}`)).body.purpose, "training");
  });
  it("answers 409 when there is nothing to download yet", async () => {
    const w = await createWorker(t.base, admin, "frames-nothing");
    const asg = await assignment(w, "nothing", "training");
    const r = await builtRecording(w, asg, 300_000);
    await only();
    assert.equal((await admin.get(`/api/admin/recordings/${r.id}/frames.zip`)).body.error, "no_frames");
    assert.equal((await admin.get(`/api/admin/assignments/${asg.id}/frames.zip`)).body.error, "no_frames");
    assert.equal((await admin.get(`/api/admin/routes/${asg.route.id}/frames.zip`)).body.error, "no_frames");
    assert.equal((await w.client.get(`/api/me/recordings/${r.id}/frames.zip`)).body.error, "no_frames");
    assert.equal((await w.client.get(`/api/me/assignments/${asg.id}/frames.zip`)).body.error, "no_frames");
    t.config.frames.enabled = false;
    try {
      assert.equal((await admin.post(`/api/admin/assignments/${asg.id}/frames/rerun`)).body.error, "frames_disabled");
    } finally {
      t.config.frames.enabled = true;
    }
  });
});
