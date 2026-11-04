import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import pg from "pg";

export const HITS_DIR = path.resolve(import.meta.dirname, "../../.test-hits");

/** Fresh database per test file, on the compose Postgres (127.0.0.1:5433). */
export async function startTestServer() {
  const { POSTGRES_USER: u, POSTGRES_PASSWORD: p } = process.env;
  if (!u || !p) throw new Error("run via `npm test` (loads .env) and `docker compose ... up -d db`");
  const name = `fieldapp_test_${process.pid}`;
  const admin = new pg.Client({ connectionString: `postgres://${u}:${p}@127.0.0.1:5433/postgres` });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);

  process.env.DATABASE_URL = `postgres://${u}:${p}@127.0.0.1:5433/${name}`;
  process.env.COOKIE_SECURE = "false";
  process.env.PUBLIC_ORIGINS = "http://localhost:3100";
  process.env.ADMIN_USERNAME = "testadmin";
  process.env.ADMIN_PASSWORD = "initial-admin-password-1";
  // object storage: RustFS on 127.0.0.1:9000, with a bucket of its own for this run
  process.env.S3_ENDPOINT = "http://127.0.0.1:9000";
  process.env.S3_BUCKET = `test-${process.pid}-${Date.now()}`;
  process.env.ENABLE_DEV_TOOLS = "false";
  process.env.REMUX = "false";

  // import only now, after the environment is set (config is read at import)
  const { createApp } = await import("../../server/app.ts");
  const { migrate } = await import("../../server/migrate.ts");
  const { bootstrapAdmin } = await import("../../server/auth/bootstrap.ts");
  const { pool } = await import("../../server/db.ts");
  const { config } = await import("../../server/config.ts");
  const storage = await import("../../server/services/storage.ts");
  const { kickAssembler } = await import("../../server/services/assemble.ts");
  await migrate();
  await storage.ensureBucket();
  await bootstrapAdmin();
  fs.mkdirSync(HITS_DIR, { recursive: true });
  const hitsFile = path.join(HITS_DIR, `${process.pid}.log`);
  const server = createApp({ onHit: (endpoint, status) => fs.appendFileSync(hitsFile, `${endpoint} ${status}\n`) }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    base,
    pool,
    config,
    bootstrapAdmin,
    storage,
    kickAssembler,
    async stop() {
      server.close();
      await storage.dropBucket().catch(() => {});
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

export type Res = { status: number; body: any; headers: Headers; bytes: Buffer };

/** A tiny browser: keeps cookies, sends a trusted Origin and JSON. */
export class Client {
  cookie = "";
  constructor(
    private base: string,
    private origin = "http://localhost:3100",
  ) {}

  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    const h: Record<string, string> = { origin: this.origin, ...headers };
    if (body !== undefined && !h["content-type"]) h["content-type"] = "application/json";
    const raw = Buffer.isBuffer(body);
    if (this.cookie) h.cookie = this.cookie;
    const r = await fetch(this.base + path, {
      method,
      headers: h,
      redirect: "manual",
      body: body === undefined ? undefined : raw ? new Uint8Array(body as Buffer) : typeof body === "string" ? body : JSON.stringify(body),
    });
    const set = r.headers.getSetCookie?.() ?? [];
    for (const c of set) {
      const [pair] = c.split(";");
      const [k, v] = [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)];
      if (/Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c)) this.cookie = "";
      else this.cookie = `${k}=${v}`;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    const text = buf.toString("utf8");
    let json: any;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    return { status: r.status, body: json, headers: r.headers, bytes: buf };
  }
  get = (p: string, headers?: Record<string, string>) => this.req("GET", p, undefined, headers);
  putRaw = (p: string, data: Buffer, headers: Record<string, string>) =>
    this.req("PUT", p, data, { "content-type": "application/octet-stream", ...headers });
  post = (p: string, b?: unknown) => this.req("POST", p, b ?? {});
  put = (p: string, b?: unknown) => this.req("PUT", p, b ?? {});
  patch = (p: string, b?: unknown) => this.req("PATCH", p, b ?? {});
  del = (p: string) => this.req("DELETE", p);
}

export const line = (lng0: number, lat: number, meters = 300): [number, number][] => {
  const d = meters / (111_320 * Math.cos((lat * Math.PI) / 180));
  return [
    [lng0, lat],
    [lng0 + d / 2, lat + 0.0004],
    [lng0 + d, lat],
  ];
};

export const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

// ---- shared setup for the endpoint tests ----
export const ADMIN_LOGIN = { username: "testadmin", password: "initial-admin-password-1" };
export const WORKER_PW = "worker-password-1";

export async function adminLogin(base: string) {
  const c = new Client(base);
  const r = await c.post("/api/auth/login", ADMIN_LOGIN);
  if (r.status !== 200) throw new Error("admin login failed " + JSON.stringify(r.body));
  return c;
}
export async function createWorker(base: string, admin: Client, username: string) {
  const r = await admin.post("/api/admin/users", { username, displayName: username, password: WORKER_PW });
  if (r.status !== 201) throw new Error("create worker failed " + JSON.stringify(r.body));
  const client = new Client(base);
  await client.post("/api/auth/login", { username, password: WORKER_PW });
  return { client, id: r.body.user.id as string };
}
export async function publishRoute(admin: Client, name: string) {
  const r = await admin.post("/api/admin/routes", {
    name,
    segments: [
      {
        required: true,
        smooth: true,
        coords: [
          [100.5, 13.75],
          [100.5012, 13.7515],
          [100.5024, 13.75],
        ],
      },
      {
        required: false,
        coords: [
          [100.503, 13.75],
          [100.5045, 13.75],
        ],
      },
    ],
  });
  const p = await admin.post(`/api/admin/route-versions/${r.body.id}/publish`);
  if (p.status !== 200) throw new Error("publish failed " + JSON.stringify(p.body));
  return p.body as { id: string; routeId: string };
}
export async function assignTo(admin: Client, versionId: string, userId: string) {
  const r = await admin.post("/api/admin/assignments", { routeVersionId: versionId, userId });
  if (r.status !== 201) throw new Error("assign failed " + JSON.stringify(r.body));
  return r.body as { id: string; segments: { id: string; coords: number[][] }[] };
}
export const NIL = "00000000-0000-4000-8000-000000000000";
