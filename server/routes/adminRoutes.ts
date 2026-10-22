import { Router } from "express";
import { z } from "zod";
import type { PoolClient } from "pg";
import { audit } from "../audit.ts";
import { pool, q, q1, tx, type Db } from "../db.ts";
import { HttpError, notFound, uuidParam } from "../http.ts";

export const adminRoutesRouter = Router();

// ---------- input ----------
const Coord = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
const SegmentIn = z.object({
  name: z.string().trim().max(80).default(""),
  required: z.boolean(),
  coords: z.array(Coord).min(2).max(5000),
  minCoverageRatio: z.number().min(0.5).max(1).default(0.9),
});
const DraftIn = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  segments: z.array(SegmentIn).max(200),
});

// ---------- output ----------
const SEG_SQL = `SELECT id, ord, name, required, ST_AsGeoJSON(geom)::json AS g, min_coverage_ratio, ST_Length(geom::geography) AS length_m
                   FROM route_segments WHERE route_version_id = $1 ORDER BY ord`;

export async function loadVersion(db: Db, versionId: string) {
  const v = await q1(
    `SELECT v.*, v.name AS route_name FROM route_versions v WHERE v.id = $1`,
    [versionId], db,
  );
  if (!v) return undefined;
  const segs = await q(SEG_SQL, [versionId], db);
  return {
    id: v.id, routeId: v.route_id, routeName: v.route_name, version: v.version, status: v.status,
    createdAt: v.created_at, publishedAt: v.published_at,
    segments: segs.map((s) => ({
      id: s.id, order: s.ord, name: s.name, required: s.required, coords: s.g.coordinates,
      minCoverageRatio: s.min_coverage_ratio, lengthM: Math.round(s.length_m * 10) / 10,
    })),
  };
}

async function writeSegments(c: PoolClient, versionId: string, segs: z.infer<typeof SegmentIn>[]) {
  await q("DELETE FROM route_segments WHERE route_version_id = $1", [versionId], c);
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    await q(
      `INSERT INTO route_segments (route_version_id, ord, name, required, geom, min_coverage_ratio)
       VALUES ($1,$2,$3,$4, ST_SetSRID(ST_GeomFromGeoJSON($5), 4326), $6)`,
      [versionId, i, s.name, s.required, JSON.stringify({ type: "LineString", coordinates: s.coords }), s.minCoverageRatio], c,
    );
  }
}

async function draftOrThrow(db: Db, versionId: string) {
  const v = await q1("SELECT * FROM route_versions WHERE id = $1", [versionId], db);
  if (!v) throw notFound("route version not found");
  if (v.status !== "draft") throw new HttpError(409, "not_a_draft", `version ${v.version} is ${v.status} and cannot be changed; create a new version`);
  return v;
}

// ---------- list / read ----------
adminRoutesRouter.get("/routes", async (_req, res) => {
  const routes = await q("SELECT * FROM routes ORDER BY created_at DESC");
  const versions = await q(
    `SELECT v.id, v.route_id, v.version, v.name, v.status, v.published_at, v.created_at,
            count(s.id)::int AS segment_count, COALESCE(sum(ST_Length(s.geom::geography)), 0) AS length_m,
            (SELECT count(*)::int FROM assignments a WHERE a.route_version_id = v.id) AS assignment_count
       FROM route_versions v LEFT JOIN route_segments s ON s.route_version_id = v.id
      GROUP BY v.id ORDER BY v.version DESC`,
  );
  res.json(routes.map((r) => ({
    id: r.id, name: r.name, createdAt: r.created_at,
    versions: versions.filter((v) => v.route_id === r.id).map((v) => ({
      id: v.id, version: v.version, name: v.name, status: v.status, publishedAt: v.published_at, createdAt: v.created_at,
      segmentCount: v.segment_count, lengthM: Math.round(v.length_m), assignmentCount: v.assignment_count,
    })),
  })));
});

adminRoutesRouter.get("/routes/:id", async (req, res) => {
  const id = uuidParam(req, "id");
  const r = await q1("SELECT * FROM routes WHERE id = $1", [id]);
  if (!r) throw notFound("route not found");
  const ids = await q("SELECT id FROM route_versions WHERE route_id = $1 ORDER BY version DESC", [id]);
  res.json({ id: r.id, name: r.name, versions: await Promise.all(ids.map((x) => loadVersion(pool, x.id))) });
});

adminRoutesRouter.get("/route-versions/:vid", async (req, res) => {
  const v = await loadVersion(pool, uuidParam(req, "vid"));
  if (!v) throw notFound("route version not found");
  res.json(v);
});

// ---------- create / edit draft ----------
adminRoutesRouter.post("/routes", async (req, res) => {
  const body = DraftIn.extend({ name: z.string().trim().min(1).max(120) }).parse(req.body);
  const out = await tx(async (c) => {
    const [r] = await q("INSERT INTO routes (name, created_by) VALUES ($1,$2) RETURNING id", [body.name, req.user!.id], c);
    const [v] = await q("INSERT INTO route_versions (route_id, version, name, status, created_by) VALUES ($1,1,$2,'draft',$3) RETURNING id", [r.id, body.name, req.user!.id], c);
    await writeSegments(c, v.id, body.segments);
    await audit(req.user!.id, "route_created", { type: "route", id: r.id }, { name: body.name }, req.ip, c);
    return loadVersion(c, v.id);
  });
  res.status(201).json(out);
});

adminRoutesRouter.put("/route-versions/:vid", async (req, res) => {
  const vid = uuidParam(req, "vid");
  const body = DraftIn.parse(req.body);
  const out = await tx(async (c) => {
    const v = await draftOrThrow(c, vid);
    if (body.name) await q("UPDATE route_versions SET name = $1 WHERE id = $2", [body.name, vid], c); // the draft only
    await writeSegments(c, vid, body.segments);
    await audit(req.user!.id, "route_draft_saved", { type: "route_version", id: vid }, { segments: body.segments.length }, req.ip, c);
    return loadVersion(c, vid);
  });
  res.json(out);
});

adminRoutesRouter.delete("/route-versions/:vid", async (req, res) => {
  const vid = uuidParam(req, "vid");
  await tx(async (c) => {
    const v = await draftOrThrow(c, vid);
    await q("DELETE FROM route_versions WHERE id = $1", [vid], c);
    const left = await q1("SELECT count(*)::int AS n FROM route_versions WHERE route_id = $1", [v.route_id], c);
    if (left.n === 0) await q("DELETE FROM routes WHERE id = $1", [v.route_id], c);
    await audit(req.user!.id, "route_draft_deleted", { type: "route_version", id: vid }, undefined, req.ip, c);
  });
  res.json({ ok: true });
});

// ---------- versioning ----------
/** "Edit" on a published route: copy it into a new draft. The published version stays as it is. */
adminRoutesRouter.post("/routes/:id/new-version", async (req, res) => {
  const id = uuidParam(req, "id");
  const out = await tx(async (c) => {
    const r = await q1("SELECT id FROM routes WHERE id = $1 FOR UPDATE", [id], c);
    if (!r) throw notFound("route not found");
    const draft = await q1("SELECT id FROM route_versions WHERE route_id = $1 AND status = 'draft'", [id], c);
    if (draft) throw new HttpError(409, "draft_exists", "this route already has a draft", { draftId: draft.id });
    const src = await q1("SELECT id, version, name FROM route_versions WHERE route_id = $1 ORDER BY version DESC LIMIT 1", [id], c);
    const [v] = await q(
      "INSERT INTO route_versions (route_id, version, name, status, created_by) VALUES ($1,$2,$3,'draft',$4) RETURNING id",
      [id, src.version + 1, src.name, req.user!.id], c,
    );
    await q(
      `INSERT INTO route_segments (route_version_id, ord, name, required, geom, min_coverage_ratio)
       SELECT $1, ord, name, required, geom, min_coverage_ratio FROM route_segments WHERE route_version_id = $2`,
      [v.id, src.id], c,
    );
    await audit(req.user!.id, "route_version_created", { type: "route_version", id: v.id }, { from: src.version }, req.ip, c);
    return loadVersion(c, v.id);
  });
  res.status(201).json(out);
});

adminRoutesRouter.post("/route-versions/:vid/publish", async (req, res) => {
  const vid = uuidParam(req, "vid");
  const out = await tx(async (c) => {
    const v0 = await q1("SELECT route_id FROM route_versions WHERE id = $1", [vid], c);
    if (!v0) throw notFound("route version not found");
    await q("SELECT id FROM routes WHERE id = $1 FOR UPDATE", [v0.route_id], c);
    const v = await draftOrThrow(c, vid);

    const stats = await q1(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE required)::int AS required_n,
              count(*) FILTER (WHERE ST_Length(geom::geography) < 5 OR NOT ST_IsValid(geom))::int AS bad_n
         FROM route_segments WHERE route_version_id = $1`, [vid], c,
    );
    if (stats.n === 0) throw new HttpError(400, "empty_route", "add at least one segment before publishing");
    if (stats.required_n === 0) throw new HttpError(400, "no_required_segment", "at least one segment must be required");
    if (stats.bad_n > 0) throw new HttpError(400, "bad_segment", `${stats.bad_n} segment(s) are shorter than 5 m or invalid`);

    await q("UPDATE route_versions SET status='archived' WHERE route_id = $1 AND status='published'", [v.route_id], c);
    await q("UPDATE route_versions SET status='published', published_at=now() WHERE id = $1", [vid], c);
    await q("UPDATE routes SET name = $1 WHERE id = $2", [v.name, v.route_id], c); // routes.name = name of the latest published version
    await audit(req.user!.id, "route_published", { type: "route_version", id: vid }, { version: v.version }, req.ip, c);
    return loadVersion(c, vid);
  });
  res.json(out);
});

/** Stops new assignments. Existing assignments keep working on this version. */
adminRoutesRouter.post("/route-versions/:vid/archive", async (req, res) => {
  const vid = uuidParam(req, "vid");
  const v = await q1("SELECT * FROM route_versions WHERE id = $1", [vid]);
  if (!v) throw notFound("route version not found");
  if (v.status !== "published") throw new HttpError(409, "not_published", "only a published version can be archived");
  await q("UPDATE route_versions SET status='archived' WHERE id = $1", [vid]);
  await audit(req.user!.id, "route_archived", { type: "route_version", id: vid }, { version: v.version }, req.ip);
  res.json(await loadVersion(pool, vid));
});
