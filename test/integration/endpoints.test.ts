import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Client, NIL, WORKER_PW, adminLogin, assignTo, createWorker, publishRoute, sha256, startTestServer } from "./helpers.ts";

/**
 * Endpoint coverage: every route gets a success test, a refusal where one can happen, and a sweep that
 * sends bad input / no login to all of them. test/check-endpoints.ts fails the run if any route is missed.
 */
let t: Awaited<ReturnType<typeof startTestServer>>;
before(async () => {
  t = await startTestServer();
});
after(async () => {
  await t.stop();
});

const walk = (coords: number[][]) =>
  coords.filter((_, i) => i % 5 === 0).map((c, i) => ({ seq: i, t: Date.now() - 300_000 + i * 1000, lng: c[0], lat: c[1], acc: 5 }));

async function verifiedRecording(worker: Client, assignmentId: string, coords: number[][]) {
  const id = crypto.randomUUID();
  const chunks = [crypto.randomBytes(4000), crypto.randomBytes(3000)];
  const pts = walk(coords);
  assert.equal(
    (await worker.post("/api/me/recordings", { id, assignmentId, mime: "video/webm", startedAt: Date.now() - 300_000 })).status,
    201,
  );
  for (const [i, b] of chunks.entries())
    assert.equal((await worker.putRaw(`/api/me/recordings/${id}/chunks/${i}`, b, { "x-sha256": sha256(b) })).status, 200);
  assert.equal((await worker.post(`/api/me/recordings/${id}/gps`, { points: pts })).status, 200);
  assert.equal(
    (
      await worker.post(`/api/me/recordings/${id}/finalize`, {
        endedAt: Date.now(),
        chunks: chunks.map((b, seq) => ({ seq, sha256: sha256(b) })),
        gpsCount: pts.length,
      })
    ).status,
    200,
  );
  return { id, chunks };
}
async function assembled(id: string) {
  await t.kickAssembler();
  for (let i = 0; i < 100; i++) {
    const s = (await t.pool.query("SELECT assembly_state FROM recordings WHERE id=$1", [id])).rows[0].assembly_state;
    if (s === "done") return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("assembly did not finish");
}

describe("auth", () => {
  it("logout ends the session, and is harmless without one", async () => {
    const c = new Client(t.base);
    await c.post("/api/auth/login", { username: "testadmin", password: "initial-admin-password-1" });
    assert.equal((await c.get("/api/auth/me")).status, 200);
    const out = await c.post("/api/auth/logout");
    assert.equal(out.status, 200);
    assert.equal((await c.get("/api/auth/me")).status, 401, "the cookie no longer works");
    assert.equal(
      (await t.pool.query("SELECT count(*)::int n FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.username='testadmin'")).rows[0].n,
      0,
      "and the session row is gone",
    );
    assert.equal((await new Client(t.base).post("/api/auth/logout")).status, 200);
  });
  it("health check answers and touches the database", async () => {
    const r = await fetch(t.base + "/healthz");
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
  });
});

describe("workers", () => {
  it("lists, renames, and refuses bad or unknown targets", async () => {
    const admin = await adminLogin(t.base);
    const w = await createWorker(t.base, admin, "rename-me");
    const list = await admin.get("/api/admin/users");
    assert.ok(list.body.some((u: any) => u.id === w.id));
    const r = await admin.patch(`/api/admin/users/${w.id}`, { displayName: "  New Name  " });
    assert.equal(r.status, 200);
    assert.equal(r.body.displayName, "New Name", "trimmed");
    assert.equal((await admin.patch(`/api/admin/users/${w.id}`, { displayName: "x".repeat(81) })).status, 400);
    assert.equal((await admin.patch(`/api/admin/users/${w.id}`, {})).status, 400);
    assert.equal((await admin.patch(`/api/admin/users/${NIL}`, { displayName: "x" })).status, 404);
    assert.equal((await admin.patch("/api/admin/users/not-a-uuid", { displayName: "x" })).status, 404);
    const me = await admin.get("/api/auth/me");
    assert.equal(
      (await admin.patch(`/api/admin/users/${me.body.user.id}`, { displayName: "x" })).status,
      404,
      "admins are not managed here",
    );
    assert.equal((await admin.post(`/api/admin/users/${NIL}/activate`)).status, 404);
    assert.equal((await admin.post(`/api/admin/users/${NIL}/deactivate`)).status, 404);
    assert.equal((await admin.post(`/api/admin/users/${NIL}/password`, {})).status, 404);
    // usernames: lowercased, unique, valid characters only
    assert.equal((await admin.post("/api/admin/users", { username: "Bad Name!", password: WORKER_PW })).status, 400);
    assert.equal((await admin.post("/api/admin/users", { username: "ab", password: WORKER_PW })).status, 400);
    const dup = await admin.post("/api/admin/users", { username: "RENAME-ME", password: WORKER_PW });
    assert.equal(dup.status, 409, "same name in another case is the same name");
  });
});

describe("route versions", () => {
  it("archives a published version; refuses a draft, a repeat and an unknown id; reads versions and routes", async () => {
    const admin = await adminLogin(t.base);
    const v = await publishRoute(admin, "Archive me");
    const read = await admin.get(`/api/admin/route-versions/${v.id}`);
    assert.equal(read.status, 200);
    assert.equal(read.body.status, "published");
    assert.equal((await admin.get(`/api/admin/route-versions/${NIL}`)).status, 404);
    assert.equal((await admin.get(`/api/admin/routes/${NIL}`)).status, 404);
    assert.equal((await admin.get("/api/admin/routes/not-a-uuid")).status, 404);

    const done = await admin.post(`/api/admin/route-versions/${v.id}/archive`);
    assert.equal(done.status, 200);
    assert.equal(done.body.status, "archived");
    assert.equal((await admin.post(`/api/admin/route-versions/${v.id}/archive`)).status, 409, "already archived");
    assert.equal((await admin.post(`/api/admin/route-versions/${NIL}/archive`)).status, 404);
    const draft = await admin.post("/api/admin/routes", {
      name: "Only a draft",
      segments: [
        {
          required: true,
          coords: [
            [100.5, 13.75],
            [100.502, 13.75],
          ],
        },
      ],
    });
    assert.equal(
      (await admin.post(`/api/admin/route-versions/${draft.body.id}/archive`)).status,
      409,
      "only a published version can be archived",
    );
  });

  it("deletes a draft; the route goes with its last version but stays while other versions exist", async () => {
    const admin = await adminLogin(t.base);
    const only = await admin.post("/api/admin/routes", {
      name: "Throwaway",
      segments: [
        {
          required: true,
          coords: [
            [100.5, 13.75],
            [100.502, 13.75],
          ],
        },
      ],
    });
    assert.equal((await admin.del(`/api/admin/route-versions/${only.body.id}`)).status, 200);
    assert.equal((await admin.get(`/api/admin/route-versions/${only.body.id}`)).status, 404);
    assert.equal((await admin.get(`/api/admin/routes/${only.body.routeId}`)).status, 404, "an empty route is removed too");

    const pub = await publishRoute(admin, "Has history");
    const nv = await admin.post(`/api/admin/routes/${pub.routeId}/new-version`);
    assert.equal((await admin.del(`/api/admin/route-versions/${nv.body.id}`)).status, 200);
    assert.equal((await admin.get(`/api/admin/routes/${pub.routeId}`)).status, 200, "v1 is still there");
    assert.equal((await admin.del(`/api/admin/route-versions/${pub.id}`)).status, 409, "a published version cannot be deleted");
    assert.equal((await admin.del(`/api/admin/route-versions/${NIL}`)).status, 404);
  });
});

describe("assignments (admin)", () => {
  it("lists with filters, reads one with its recordings, and refuses unknown ids and bad filters", async () => {
    const admin = await adminLogin(t.base);
    const a = await createWorker(t.base, admin, "list-a"),
      b = await createWorker(t.base, admin, "list-b");
    const v = await publishRoute(admin, "Listed");
    const asgA = await assignTo(admin, v.id, a.id);
    await assignTo(admin, v.id, b.id);
    await t.pool.query("UPDATE assignments SET status='needs_review' WHERE id=$1", [asgA.id]);

    const all = await admin.get("/api/admin/assignments");
    assert.equal(all.status, 200);
    assert.ok(all.body.length >= 2);
    const onlyA = await admin.get(`/api/admin/assignments?userId=${a.id}`);
    assert.deepEqual(
      onlyA.body.map((x: any) => x.id),
      [asgA.id],
    );
    const review = await admin.get("/api/admin/assignments?status=needs_review");
    assert.ok(review.body.every((x: any) => x.status === "needs_review") && review.body.some((x: any) => x.id === asgA.id));
    const none = await admin.get(`/api/admin/assignments?userId=${a.id}&status=completed`);
    assert.deepEqual(none.body, []);
    assert.equal((await admin.get("/api/admin/assignments?userId=nope")).status, 404);

    const one = await admin.get(`/api/admin/assignments/${asgA.id}`);
    assert.equal(one.status, 200);
    assert.equal(one.body.worker.username, "list-a");
    assert.equal(one.body.segments.length, 2);
    assert.ok(Array.isArray(one.body.recordings) && Array.isArray(one.body.reasons));
    assert.equal((await admin.get(`/api/admin/assignments/${NIL}`)).status, 404);
    assert.equal((await admin.get(`/api/admin/assignments/${NIL}/audit`)).status, 200, "an unknown id simply has no audit entries");
    assert.equal((await admin.post(`/api/admin/assignments/${NIL}/re-evaluate`)).status, 404);
    assert.equal((await admin.post(`/api/admin/assignments/${NIL}/review`, { decision: "approve" })).status, 404);
    const idle = await assignTo(admin, v.id, b.id);
    assert.equal(
      (await admin.post(`/api/admin/assignments/${idle.id}/review`, { decision: "approve" })).status,
      409,
      "only an assignment in review can be decided",
    );
    assert.equal((await admin.get(`/api/admin/assignments/${NIL}/export.json`)).status, 404);
    assert.equal((await admin.get(`/api/admin/assignments/${NIL}/export.zip`)).status, 404);
  });

  it("shows the audit trail of an assignment and of its recordings, newest first, with the actor", async () => {
    const admin = await adminLogin(t.base);
    const w = await createWorker(t.base, admin, "audited");
    const asg = await assignTo(admin, (await publishRoute(admin, "Audited")).id, w.id);
    const rec = await verifiedRecording(w.client, asg.id, asg.segments[0].coords);
    const trail = await admin.get(`/api/admin/assignments/${asg.id}/audit`);
    assert.equal(trail.status, 200);
    const actions = trail.body.map((e: any) => e.action);
    for (const a of ["assignment_created", "recording_registered", "recording_verified"]) assert.ok(actions.includes(a), a);
    const ids = trail.body.map((e: any) => e.id);
    assert.deepEqual(
      ids,
      [...ids].sort((x: number, y: number) => y - x),
      "newest first",
    );
    assert.equal(trail.body.find((e: any) => e.action === "recording_verified").actor, "audited");
    assert.ok(rec.id);
  });
});

describe("recordings (admin)", () => {
  it("returns the GPS track, refuses unknown ids and unverified recordings, and can rebuild a failed video", async () => {
    const admin = await adminLogin(t.base);
    const w = await createWorker(t.base, admin, "rebuilder");
    const asg = await assignTo(admin, (await publishRoute(admin, "Rebuild")).id, w.id);
    const { id, chunks } = await verifiedRecording(w.client, asg.id, asg.segments[0].coords);
    await assembled(id);

    const gps = await admin.get(`/api/admin/recordings/${id}/gps`);
    assert.equal(gps.status, 200);
    assert.ok(gps.body.length > 10 && typeof gps.body[0].lat === "number" && typeof gps.body[0].t === "number");
    assert.equal((await admin.get(`/api/admin/recordings/${NIL}/gps`)).status, 404);
    assert.equal((await admin.get(`/api/admin/recordings/${NIL}/video`)).status, 404);
    assert.equal((await admin.get(`/api/admin/recordings/${NIL}/download`)).status, 404);
    assert.equal((await admin.get(`/api/admin/recordings/${NIL}/gps.json`)).status, 404);
    assert.equal((await admin.post(`/api/admin/recordings/${NIL}/reassemble`)).status, 404);

    // a finished, cleaned-up recording has nothing left to rebuild from
    assert.equal((await admin.post(`/api/admin/recordings/${id}/reassemble`)).status, 409);

    // simulate a failed build whose chunks are still in storage
    const rows = (await t.pool.query("SELECT seq, object_key FROM recording_chunks WHERE recording_id=$1 ORDER BY seq", [id])).rows;
    for (const r of rows) await t.storage.putObject(r.object_key, chunks[r.seq]);
    await t.pool.query(
      "UPDATE recordings SET assembly_state='failed', assembly_error='disk full', chunks_purged=false, file_key=NULL, file_bytes=NULL WHERE id=$1",
      [id],
    );
    assert.equal((await admin.get(`/api/admin/recordings/${id}/video`)).status, 409, "no video while the build is failed");
    assert.equal((await admin.post(`/api/admin/recordings/${id}/reassemble`)).status, 200);
    await assembled(id);
    const back = await admin.get(`/api/admin/recordings/${id}/video`);
    assert.equal(back.status, 200);
    assert.ok(back.bytes.equals(Buffer.concat(chunks)), "the rebuilt file is the same video");

    // unverified: no downloads
    const {
      rows: [open],
    } = await t.pool.query(
      "INSERT INTO recordings (id, assignment_id, user_id, mime, started_at_ms) SELECT gen_random_uuid(), $1, user_id, 'video/webm', 1 FROM assignments WHERE id=$1 RETURNING id",
      [asg.id],
    );
    assert.equal((await admin.get(`/api/admin/recordings/${open.id}/gps.json`)).status, 409);
    assert.equal((await admin.get(`/api/admin/recordings/${open.id}/download`)).status, 409);
    assert.equal((await admin.post(`/api/admin/recordings/${open.id}/reassemble`)).status, 409, "only verified recordings are rebuilt");
  });
});

describe("worker assignment actions", () => {
  it("finish, preflight and skip refuse other workers' assignments and unknown ids; unskip is scoped too", async () => {
    const admin = await adminLogin(t.base);
    const a = await createWorker(t.base, admin, "act-a"),
      b = await createWorker(t.base, admin, "act-b");
    const asg = await assignTo(admin, (await publishRoute(admin, "Actions")).id, a.id);
    const [req, opt] = (await a.client.get(`/api/me/assignments/${asg.id}`)).body.segments;
    const pre = { result: "passed", durationMs: 1000, samples: 6, bestAccuracyM: 4 };
    for (const [m, p, body] of [
      ["POST", `/api/me/assignments/${asg.id}/finish`, {}],
      ["POST", `/api/me/assignments/${asg.id}/preflight`, pre],
      ["POST", `/api/me/assignments/${asg.id}/segments/${opt.id}/skip`, {}],
      ["POST", `/api/me/assignments/${asg.id}/segments/${opt.id}/unskip`, {}],
    ] as const) {
      assert.equal((await b.client.req(m, p, body)).status, 404, `B on A's ${p}`);
      assert.equal((await a.client.req(m, p.replace(asg.id, NIL), body)).status, 404, `unknown assignment ${p}`);
    }
    assert.equal((await a.client.post(`/api/me/assignments/${asg.id}/segments/${NIL}/skip`, {})).status, 404, "unknown segment");
    assert.equal((await a.client.post(`/api/me/assignments/${asg.id}/preflight`, pre)).status, 200);
    // an unskip on something not skipped changes nothing
    assert.equal((await a.client.post(`/api/me/assignments/${asg.id}/segments/${req.id}/unskip`)).status, 200);
    assert.equal((await a.client.get(`/api/me/assignments/${asg.id}`)).body.preflight.result, "passed");
    // finishing with nothing recorded says so, and does not complete anything
    const fin = await a.client.post(`/api/me/assignments/${asg.id}/finish`);
    assert.equal(fin.body.status, "in_progress");
    assert.deepEqual(fin.body.reasons, ["no recordings uploaded yet"]);
    // a completed assignment is closed to every action
    await t.pool.query("UPDATE assignments SET status='completed' WHERE id=$1", [asg.id]);
    assert.equal((await a.client.post(`/api/me/assignments/${asg.id}/finish`)).status, 409);
    assert.equal((await a.client.post(`/api/me/assignments/${asg.id}/segments/${opt.id}/skip`, {})).status, 409);
    assert.equal((await a.client.post(`/api/me/assignments/${asg.id}/segments/${opt.id}/unskip`)).status, 409);
  });

  it("the worker's own recording list, status and delete behave", async () => {
    const admin = await adminLogin(t.base);
    const w = await createWorker(t.base, admin, "own-rec");
    const asg = await assignTo(admin, (await publishRoute(admin, "OwnRec")).id, w.id);
    const id = crypto.randomUUID();
    await w.client.post("/api/me/recordings", { id, assignmentId: asg.id, mime: "video/webm", startedAt: Date.now() });
    const st = await w.client.get(`/api/me/recordings/${id}/status`);
    assert.deepEqual(st.body, { verified: false, chunkSeqs: [], gpsSeqs: [] });
    assert.equal((await w.client.get(`/api/me/recordings/${NIL}/status`)).status, 404);
    assert.equal((await w.client.del(`/api/me/recordings/${id}`)).status, 200, "an empty recording can be dropped");
    assert.equal((await w.client.get(`/api/me/recordings/${id}/status`)).status, 404);
    const detail = (await w.client.get(`/api/me/assignments/${asg.id}`)).body;
    assert.deepEqual(detail.recordings, []);
  });
});

// ---------- sweeps over every endpoint ----------
describe("every endpoint refuses bad input and missing login", () => {
  it("returns 400 (not 500) for malformed bodies on every endpoint that takes one", async () => {
    const admin = await adminLogin(t.base);
    const w = await createWorker(t.base, admin, "sweeper");
    const v = await publishRoute(admin, "Sweep");
    const asg = await assignTo(admin, v.id, w.id);
    const draft = await admin.post("/api/admin/routes", { name: "Sweep draft", segments: [] });
    const recId = crypto.randomUUID();
    await w.client.post("/api/me/recordings", { id: recId, assignmentId: asg.id, mime: "video/webm", startedAt: Date.now() });
    const seg = asg.segments[1].id;

    const cases: [Client, string, string, unknown][] = [
      [new Client(t.base), "POST", "/api/auth/login", { username: 1 }],
      [admin, "POST", "/api/auth/change-password", { currentPassword: "" }],
      [admin, "POST", "/api/admin/users", { password: "x" }],
      [admin, "PATCH", `/api/admin/users/${w.id}`, { displayName: 5 }],
      [admin, "POST", `/api/admin/users/${w.id}/password`, { password: "short" }],
      [admin, "POST", "/api/admin/routes", { name: "", segments: [] }],
      [admin, "POST", "/api/admin/routes", { name: "x", segments: [{ required: true, coords: [[1, 2]] }] }],
      [
        admin,
        "POST",
        "/api/admin/routes",
        {
          name: "x",
          segments: [
            {
              required: true,
              coords: [
                [500, 2],
                [1, 2],
              ],
            },
          ],
        },
      ],
      [admin, "PUT", `/api/admin/route-versions/${draft.body.id}`, { segments: "nope" }],
      [admin, "POST", "/api/admin/assignments", { routeVersionId: "x", userId: "y" }],
      [admin, "POST", `/api/admin/assignments/${asg.id}/review`, { decision: "maybe" }],
      [w.client, "POST", `/api/me/assignments/${asg.id}/preflight`, { result: "great" }],
      [w.client, "POST", `/api/me/assignments/${asg.id}/segments/${seg}/skip`, { reason: "x".repeat(300) }],
      [w.client, "POST", "/api/me/recordings", { id: "nope" }],
      [w.client, "POST", `/api/me/recordings/${recId}/gps`, { points: [{ seq: 0, t: 1, lat: 99, lng: 0, acc: 1 }] }],
      [w.client, "POST", `/api/me/recordings/${recId}/gps`, { points: [] }],
      [w.client, "POST", `/api/me/recordings/${recId}/finalize`, { chunks: [], gpsCount: 0 }],
    ];
    for (const [c, m, p, body] of cases) {
      const r = await c.req(m, p, body as any);
      assert.equal(r.status, 400, `${m} ${p} ${JSON.stringify(body).slice(0, 60)} -> ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
      assert.equal(r.body.error, "invalid_input", `${m} ${p}`);
    }
    // not JSON at all
    assert.equal((await admin.req("POST", "/api/admin/users", "{broken")).status, 400);
  });

  it("answers 401 without login and 403 for the wrong role on every worker endpoint", async () => {
    const admin = await adminLogin(t.base);
    const WORKER_ENDPOINTS: [string, string][] = [
      ["GET", "/api/me/assignments"],
      ["GET", `/api/me/assignments/${NIL}`],
      ["POST", `/api/me/assignments/${NIL}/preflight`],
      ["POST", `/api/me/assignments/${NIL}/finish`],
      ["POST", `/api/me/assignments/${NIL}/segments/${NIL}/skip`],
      ["POST", `/api/me/assignments/${NIL}/segments/${NIL}/unskip`],
      ["POST", "/api/me/recordings"],
      ["GET", `/api/me/recordings/${NIL}/status`],
      ["GET", `/api/me/recordings/${NIL}/gps`],
      ["POST", `/api/me/recordings/${NIL}/gps`],
      ["POST", `/api/me/recordings/${NIL}/finalize`],
      ["DELETE", `/api/me/recordings/${NIL}`],
      ["GET", `/api/me/recordings/${NIL}/frames`],
      ["GET", `/api/me/recordings/${NIL}/frames.zip`],
      ["GET", `/api/me/assignments/${NIL}/frames.zip`],
    ];
    for (const [m, p] of WORKER_ENDPOINTS) {
      assert.equal((await new Client(t.base).req(m, p, m === "GET" ? undefined : {})).status, 401, `anon ${m} ${p}`);
      assert.equal((await admin.req(m, p, m === "GET" ? undefined : {})).status, 403, `admin ${m} ${p}`);
    }
    // admin-only endpoints added since the first sweep
    const w = await createWorker(t.base, admin, "role-check");
    for (const [m, p] of [
      ["GET", `/api/admin/assignments/${NIL}/audit`],
      ["GET", `/api/admin/assignments/${NIL}/export.zip`],
      ["GET", `/api/admin/assignments/${NIL}/export.json`],
      ["POST", `/api/admin/assignments/${NIL}/review`],
      ["POST", `/api/admin/assignments/${NIL}/re-evaluate`],
      ["GET", `/api/admin/recordings/${NIL}/gps`],
      ["GET", `/api/admin/recordings/${NIL}/video`],
      ["GET", `/api/admin/recordings/${NIL}/download`],
      ["GET", `/api/admin/recordings/${NIL}/gps.json`],
      ["POST", `/api/admin/recordings/${NIL}/reassemble`],
      ["POST", `/api/admin/recordings/${NIL}/reanonymize`],
      ["GET", `/api/admin/recordings/${NIL}/frames`],
      ["GET", `/api/admin/recordings/${NIL}/frames.zip`],
      ["GET", `/api/admin/recordings/${NIL}/frames/0`],
      ["GET", `/api/admin/assignments/${NIL}/frames.zip`],
      ["POST", `/api/admin/assignments/${NIL}/frames/rerun`],
      ["GET", `/api/admin/routes/${NIL}/frames.zip`],
      ["GET", `/api/admin/route-versions/${NIL}`],
    ] as const) {
      assert.equal((await new Client(t.base).req(m, p, m === "GET" ? undefined : {})).status, 401, `anon ${m} ${p}`);
      assert.equal((await w.client.req(m, p, m === "GET" ? undefined : {})).status, 403, `worker ${m} ${p}`);
    }
    assert.equal((await new Client(t.base).get("/api/auth/me")).status, 401);
    assert.equal((await new Client(t.base).post("/api/auth/change-password", {})).status, 401);
  });

  it("unknown API paths answer 404 JSON, and unknown methods on known paths do not crash", async () => {
    const admin = await adminLogin(t.base);
    const r = await admin.get("/api/does-not-exist");
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "not_found");
    assert.equal((await admin.req("PATCH", "/api/admin/routes", {})).status, 404);
  });
});
