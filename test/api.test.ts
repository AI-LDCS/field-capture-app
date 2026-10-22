import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client, line, startTestServer } from "./helpers.ts";

let t: Awaited<ReturnType<typeof startTestServer>>;
const ADMIN = { username: "testadmin", password: "initial-admin-password-1" };
const as = (u: string) => new Client(t.base).post("/api/auth/login", { username: u, password: "" });

before(async () => { t = await startTestServer(); });
after(async () => { await t.stop(); });

async function adminClient() {
  const c = new Client(t.base);
  const r = await c.post("/api/auth/login", ADMIN);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return c;
}
/** creates a worker, logs in with the temp password, sets a real password, returns a logged-in client */
async function makeWorker(admin: Client, username: string, password = "worker-password-1") {
  const created = await admin.post("/api/admin/users", { username, displayName: username.toUpperCase() });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const w = new Client(t.base);
  assert.equal((await w.post("/api/auth/login", { username, password: created.body.temporaryPassword })).status, 200);
  assert.equal((await w.post("/api/auth/change-password", { currentPassword: created.body.temporaryPassword, newPassword: password })).status, 200);
  return { client: w, id: created.body.user.id as string, username, password };
}
async function publishedRoute(admin: Client, name = "Route", segments?: any[]) {
  const segs = segments ?? [
    { required: true, coords: line(100.5, 13.75) },
    { required: false, coords: line(100.504, 13.75) },
    { required: true, coords: line(100.508, 13.75) },
  ];
  const r = await admin.post("/api/admin/routes", { name, segments: segs });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const p = await admin.post(`/api/admin/route-versions/${r.body.id}/publish`);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  return p.body;
}

describe("authentication", () => {
  it("wrong password and unknown user both give the same 401", async () => {
    const c = new Client(t.base);
    const a = await c.post("/api/auth/login", { username: "testadmin", password: "nope-nope-nope" });
    const b = await c.post("/api/auth/login", { username: "ghost-user", password: "nope-nope-nope" });
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.equal(a.body.message, b.body.message);
  });

  it("locks a username after repeated failures, even for the right password", async () => {
    const admin = await adminClient();
    const w = await makeWorker(admin, "locky");
    const c = new Client(t.base);
    for (let i = 0; i < 5; i++) assert.equal((await c.post("/api/auth/login", { username: "locky", password: "wrong-wrong-1" })).status, 401);
    const locked = await c.post("/api/auth/login", { username: "locky", password: w.password });
    assert.equal(locked.status, 429);
    assert.ok(locked.headers.get("retry-after"));
    await t.pool.query("DELETE FROM login_attempts"); // keep other tests independent
  });

  it("stores passwords as Argon2id", async () => {
    const { rows } = await t.pool.query("SELECT password_hash FROM users");
    assert.ok(rows.length > 0 && rows.every((r) => r.password_hash.startsWith("$argon2id$")));
  });

  it("session cookie is HttpOnly, SameSite=Lax, and __Host- Secure when COOKIE_SECURE=true", async () => {
    const c = new Client(t.base);
    const plain = await c.post("/api/auth/login", ADMIN);
    const sc1 = plain.headers.getSetCookie()[0];
    assert.match(sc1, /^sid=/); assert.match(sc1, /HttpOnly/i); assert.match(sc1, /SameSite=Lax/i);

    t.config.cookieSecure = true;
    try {
      const r = await new Client(t.base).post("/api/auth/login", ADMIN);
      const sc = r.headers.getSetCookie()[0];
      assert.match(sc, /^__Host-sid=/); assert.match(sc, /; Secure/i); assert.match(sc, /HttpOnly/i);
      assert.match(sc, /SameSite=Lax/i); assert.match(sc, /Path=\//); assert.doesNotMatch(sc, /Domain=/i);
    } finally { t.config.cookieSecure = false; }
  });

  it("a new login does not reuse the old session token", async () => {
    const c = new Client(t.base);
    await c.post("/api/auth/login", ADMIN);
    const first = c.cookie;
    await c.post("/api/auth/login", ADMIN);
    assert.notEqual(c.cookie, first);
    assert.equal((await new Client(t.base).get("/api/auth/me")).status, 401);
  });

  it("expired sessions (absolute and idle) are rejected", async () => {
    const c = await adminClient();
    assert.equal((await c.get("/api/auth/me")).status, 200);
    await t.pool.query("UPDATE sessions SET last_seen_at = now() - interval '3 days'");
    assert.equal((await c.get("/api/auth/me")).status, 401);
    const c2 = await adminClient();
    await t.pool.query("UPDATE sessions SET expires_at = now() - interval '1 minute'");
    assert.equal((await c2.get("/api/auth/me")).status, 401);
  });
});

describe("account lifecycle", () => {
  it("deactivating a worker kills their existing session and blocks login", async () => {
    const admin = await adminClient();
    const w = await makeWorker(admin, "leaver");
    assert.equal((await w.client.get("/api/me/assignments")).status, 200);
    assert.equal((await admin.post(`/api/admin/users/${w.id}/deactivate`)).status, 200);
    assert.equal((await w.client.get("/api/me/assignments")).status, 401);
    assert.equal((await new Client(t.base).post("/api/auth/login", { username: "leaver", password: w.password })).status, 401);
    assert.equal((await admin.post(`/api/admin/users/${w.id}/activate`)).status, 200);
    assert.equal((await new Client(t.base).post("/api/auth/login", { username: "leaver", password: w.password })).status, 200);
  });

  it("a password reset kills old sessions, forces a change, and the old password stops working", async () => {
    const admin = await adminClient();
    const w = await makeWorker(admin, "resetme");
    const reset = await admin.post(`/api/admin/users/${w.id}/reset-password`);
    assert.equal(reset.status, 200);
    assert.equal((await w.client.get("/api/me/assignments")).status, 401);
    assert.equal((await new Client(t.base).post("/api/auth/login", { username: "resetme", password: w.password })).status, 401);

    const again = new Client(t.base);
    assert.equal((await again.post("/api/auth/login", { username: "resetme", password: reset.body.temporaryPassword })).status, 200);
    const blocked = await again.get("/api/me/assignments");
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error, "password_change_required");
    assert.equal((await again.get("/api/auth/me")).status, 200);
    assert.equal((await again.post("/api/auth/change-password", { currentPassword: reset.body.temporaryPassword, newPassword: "brand-new-password-9" })).status, 200);
    assert.equal((await again.get("/api/me/assignments")).status, 200);
  });

  it("changing your password signs out your other devices but keeps this one", async () => {
    const admin = await adminClient();
    const w = await makeWorker(admin, "twodevices");
    const other = new Client(t.base);
    assert.equal((await other.post("/api/auth/login", { username: "twodevices", password: w.password })).status, 200);
    assert.equal((await w.client.post("/api/auth/change-password", { currentPassword: w.password, newPassword: "yet-another-pass-3" })).status, 200);
    assert.equal((await w.client.get("/api/auth/me")).status, 200);
    assert.equal((await other.get("/api/auth/me")).status, 401);
  });

  it("admins manage workers only", async () => {
    const admin = await adminClient();
    const me = await admin.get("/api/auth/me");
    const list = await admin.get("/api/admin/users");
    assert.ok(list.body.every((u: any) => u.id !== me.body.user.id));
    assert.equal((await admin.post(`/api/admin/users/${me.body.user.id}/deactivate`)).status, 404);
    assert.equal((await admin.post(`/api/admin/users/${me.body.user.id}/reset-password`)).status, 404);
  });

  it("bootstrap run again does not change or recreate the admin", async () => {
    const before = await t.pool.query("SELECT id, password_hash FROM users WHERE username='testadmin'");
    t.config.adminPassword = "a-totally-different-password-2";
    await t.bootstrapAdmin();
    const after = await t.pool.query("SELECT id, password_hash FROM users WHERE username='testadmin'");
    t.config.adminPassword = "initial-admin-password-1";
    assert.equal(after.rows.length, 1);
    assert.equal(after.rows[0].password_hash, before.rows[0].password_hash);
    assert.equal((await new Client(t.base).post("/api/auth/login", ADMIN)).status, 200);
  });
});

describe("authorization", () => {
  const ADMIN_ENDPOINTS: [string, string][] = [
    ["GET", "/api/admin/users"], ["POST", "/api/admin/users"],
    ["PATCH", "/api/admin/users/00000000-0000-4000-8000-000000000000"],
    ["POST", "/api/admin/users/00000000-0000-4000-8000-000000000000/deactivate"],
    ["POST", "/api/admin/users/00000000-0000-4000-8000-000000000000/reset-password"],
    ["GET", "/api/admin/routes"], ["POST", "/api/admin/routes"],
    ["GET", "/api/admin/routes/00000000-0000-4000-8000-000000000000"],
    ["PUT", "/api/admin/route-versions/00000000-0000-4000-8000-000000000000"],
    ["POST", "/api/admin/route-versions/00000000-0000-4000-8000-000000000000/publish"],
    ["POST", "/api/admin/route-versions/00000000-0000-4000-8000-000000000000/archive"],
    ["DELETE", "/api/admin/route-versions/00000000-0000-4000-8000-000000000000"],
    ["POST", "/api/admin/routes/00000000-0000-4000-8000-000000000000/new-version"],
    ["GET", "/api/admin/assignments"], ["POST", "/api/admin/assignments"],
    ["GET", "/api/admin/assignments/00000000-0000-4000-8000-000000000000"],
    ["DELETE", "/api/admin/assignments/00000000-0000-4000-8000-000000000000"],
  ];

  it("every admin endpoint: 401 without login, 403 for a worker", async () => {
    const admin = await adminClient();
    const w = await makeWorker(admin, "nosy");
    for (const [m, p] of ADMIN_ENDPOINTS) {
      const anon = await new Client(t.base).req(m, p, m === "GET" ? undefined : {});
      assert.equal(anon.status, 401, `anon ${m} ${p}`);
      const wr = await w.client.req(m, p, m === "GET" ? undefined : {});
      assert.equal(wr.status, 403, `worker ${m} ${p}`);
    }
  });

  it("worker endpoints are closed to anonymous users and admins", async () => {
    const admin = await adminClient();
    assert.equal((await new Client(t.base).get("/api/me/assignments")).status, 401);
    assert.equal((await admin.get("/api/me/assignments")).status, 403);
  });

  it("worker A cannot see worker B's assignment (404, not 403) and lists only their own", async () => {
    const admin = await adminClient();
    const a = await makeWorker(admin, "alice");
    const b = await makeWorker(admin, "bob");
    const v = await publishedRoute(admin, "Shared");
    const forA = await admin.post("/api/admin/assignments", { routeVersionId: v.id, userId: a.id });
    const forB = await admin.post("/api/admin/assignments", { routeVersionId: v.id, userId: b.id });
    assert.equal(forA.status, 201); assert.equal(forB.status, 201);

    assert.equal((await a.client.get(`/api/me/assignments/${forA.body.id}`)).status, 200);
    assert.equal((await a.client.get(`/api/me/assignments/${forB.body.id}`)).status, 404);
    assert.equal((await b.client.get(`/api/me/assignments/${forA.body.id}`)).status, 404);
    const listA = await a.client.get("/api/me/assignments");
    assert.deepEqual(listA.body.map((x: any) => x.id), [forA.body.id]);
  });
});

describe("request safety", () => {
  it("rejects state-changing requests from another origin", async () => {
    const evil = new Client(t.base, "https://evil.example");
    const r = await evil.post("/api/auth/login", ADMIN);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "bad_origin");
  });
  it("rejects a form-style content type", async () => {
    const c = new Client(t.base);
    const r = await c.req("POST", "/api/auth/login", "username=testadmin&password=x", { "content-type": "application/x-www-form-urlencoded" });
    assert.equal(r.status, 415);
  });
  it("answers bad input with 400, not a crash", async () => {
    const c = new Client(t.base);
    assert.equal((await c.post("/api/auth/login", { username: 5 })).status, 400);
    assert.equal((await c.req("POST", "/api/auth/login", "{not json")).status, 400);
  });
});

describe("routes and versions", () => {
  it("editing a published version is rejected by the API and by the database", async () => {
    const admin = await adminClient();
    const v = await publishedRoute(admin, "Frozen");
    const put = await admin.put(`/api/admin/route-versions/${v.id}`, { segments: [{ required: true, coords: line(100.6, 13.7) }] });
    assert.equal(put.status, 409);
    assert.equal(put.body.error, "not_a_draft");
    assert.equal((await admin.del(`/api/admin/route-versions/${v.id}`)).status, 409);

    // straight SQL, bypassing the API: the triggers still refuse
    await assert.rejects(t.pool.query("UPDATE route_segments SET required = NOT required WHERE route_version_id = $1", [v.id]), /immutable/);
    await assert.rejects(t.pool.query("DELETE FROM route_segments WHERE route_version_id = $1", [v.id]), /immutable/);
    await assert.rejects(t.pool.query("INSERT INTO route_segments (route_version_id, ord, required, geom) VALUES ($1, 99, true, ST_GeomFromText('LINESTRING(100 13, 100.1 13)', 4326))", [v.id]), /immutable/);
    await assert.rejects(t.pool.query("UPDATE route_versions SET status = 'draft' WHERE id = $1", [v.id]), /cannot go back/);
    await assert.rejects(t.pool.query("DELETE FROM route_versions WHERE id = $1", [v.id]), /only draft/);
  });

  it("a new version is a copy; publishing it archives the previous one; only one is published", async () => {
    const admin = await adminClient();
    const v1 = await publishedRoute(admin, "Versioned");
    const nv = await admin.post(`/api/admin/routes/${v1.routeId}/new-version`);
    assert.equal(nv.status, 201);
    assert.equal(nv.body.version, 2);
    assert.equal(nv.body.status, "draft");
    assert.equal(nv.body.segments.length, 3);
    assert.equal((await admin.post(`/api/admin/routes/${v1.routeId}/new-version`)).status, 409); // one draft at a time

    assert.equal((await admin.post(`/api/admin/route-versions/${nv.body.id}/publish`)).status, 200);
    const detail = await admin.get(`/api/admin/routes/${v1.routeId}`);
    const states = Object.fromEntries(detail.body.versions.map((x: any) => [x.version, x.status]));
    assert.deepEqual(states, { 1: "archived", 2: "published" });
  });

  it("editing a route after assignment leaves the assignment's segments unchanged", async () => {
    const admin = await adminClient();
    const w = await makeWorker(admin, "snapshot");
    const v1 = await publishedRoute(admin, "Snap");
    const a = await admin.post("/api/admin/assignments", { routeVersionId: v1.id, userId: w.id });
    const before = await w.client.get(`/api/me/assignments/${a.body.id}`);

    const nv = await admin.post(`/api/admin/routes/${v1.routeId}/new-version`);
    const edit = await admin.put(`/api/admin/route-versions/${nv.body.id}`, {
      name: "Snap renamed",
      segments: [{ required: true, coords: line(101.0, 14.0, 900) }],
    });
    assert.equal(edit.status, 200);
    assert.equal((await admin.post(`/api/admin/route-versions/${nv.body.id}/publish`)).status, 200);

    const after = await w.client.get(`/api/me/assignments/${a.body.id}`);
    assert.equal(after.body.route.version, 1);
    assert.equal(after.body.segments.length, 3);
    assert.deepEqual(after.body.segments.map((s: any) => s.coords), before.body.segments.map((s: any) => s.coords));
    assert.deepEqual(after.body.segments.map((s: any) => s.required), [true, false, true]);
  });

  it("only published versions can be assigned, and only to active workers", async () => {
    const admin = await adminClient();
    const w = await makeWorker(admin, "picky");
    const draft = await admin.post("/api/admin/routes", { name: "Draft only", segments: [{ required: true, coords: line(100.5, 13.75) }] });
    assert.equal((await admin.post("/api/admin/assignments", { routeVersionId: draft.body.id, userId: w.id })).status, 409);

    const v1 = await publishedRoute(admin, "Retiring");
    const nv = await admin.post(`/api/admin/routes/${v1.routeId}/new-version`);
    await admin.post(`/api/admin/route-versions/${nv.body.id}/publish`); // v1 is archived now
    assert.equal((await admin.post("/api/admin/assignments", { routeVersionId: v1.id, userId: w.id })).status, 409);

    const me = await admin.get("/api/auth/me");
    assert.equal((await admin.post("/api/admin/assignments", { routeVersionId: nv.body.id, userId: me.body.user.id })).status, 404);
    await admin.post(`/api/admin/users/${w.id}/deactivate`);
    assert.equal((await admin.post("/api/admin/assignments", { routeVersionId: nv.body.id, userId: w.id })).status, 409);
  });

  it("publish checks: needs a segment, a required segment, and real lengths", async () => {
    const admin = await adminClient();
    const empty = await admin.post("/api/admin/routes", { name: "Empty", segments: [] });
    assert.equal((await admin.post(`/api/admin/route-versions/${empty.body.id}/publish`)).body.error, "empty_route");
    const optionalOnly = await admin.post("/api/admin/routes", { name: "Opt", segments: [{ required: false, coords: line(100.5, 13.75) }] });
    assert.equal((await admin.post(`/api/admin/route-versions/${optionalOnly.body.id}/publish`)).body.error, "no_required_segment");
    const tiny = await admin.post("/api/admin/routes", { name: "Tiny", segments: [{ required: true, coords: [[100.5, 13.75], [100.50001, 13.75]] }] });
    assert.equal((await admin.post(`/api/admin/route-versions/${tiny.body.id}/publish`)).body.error, "bad_segment");
    // coordinates must be real lng/lat
    const swapped = await admin.post("/api/admin/routes", { name: "Swapped", segments: [{ required: true, coords: [[13.75, 100.5], [13.76, 100.6]] }] });
    assert.equal(swapped.status, 400);
  });

  it("a required segment can never be skipped (database rule)", async () => {
    const admin = await adminClient();
    const w = await makeWorker(admin, "skipper");
    const v = await publishedRoute(admin, "Skippy");
    const a = await admin.post("/api/admin/assignments", { routeVersionId: v.id, userId: w.id });
    await assert.rejects(
      t.pool.query("UPDATE assignment_segments SET status='skipped' WHERE assignment_id=$1 AND required", [a.body.id]),
      /skipped_only_if_optional/,
    );
    const ok = await t.pool.query("UPDATE assignment_segments SET status='skipped' WHERE assignment_id=$1 AND NOT required", [a.body.id]);
    assert.equal(ok.rowCount, 1);
  });

  it("an assignment can be withdrawn only before work starts", async () => {
    const admin = await adminClient();
    const w = await makeWorker(admin, "withdrawn");
    const v = await publishedRoute(admin, "Wd");
    const a = await admin.post("/api/admin/assignments", { routeVersionId: v.id, userId: w.id });
    await t.pool.query("UPDATE assignments SET status='in_progress' WHERE id=$1", [a.body.id]);
    assert.equal((await admin.del(`/api/admin/assignments/${a.body.id}`)).status, 409);
    const b = await admin.post("/api/admin/assignments", { routeVersionId: v.id, userId: w.id });
    assert.equal((await admin.del(`/api/admin/assignments/${b.body.id}`)).status, 200);
  });

  it("writes an audit trail for sensitive actions", async () => {
    const { rows } = await t.pool.query("SELECT DISTINCT action FROM audit_log");
    const actions = rows.map((r) => r.action);
    for (const a of ["admin_bootstrapped", "login", "login_failed", "user_created", "user_deactivated", "password_reset", "password_changed", "route_published", "assignment_created"]) {
      assert.ok(actions.includes(a), `missing audit action ${a}`);
    }
  });
});
