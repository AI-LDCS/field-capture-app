# Field Capture (real build, milestone 2)

Login, admin, versioned routes, assignments, and now the field flow: GPS check, recording with crash recovery, resumable upload through the app into RustFS, server-side verification, the backend deciding completion, and admin review (video, map, downloads).

Stack: Node 22 + Express 5 + TypeScript, React + Vite + Leaflet, PostgreSQL + PostGIS, RustFS (S3-compatible, not used yet), Caddy at the edge, Docker Compose.

## Run it

```bash
cp .env.example .env        # then fill in real secrets (random, long)
# certs for the tailnet profile: tailscale cert <host>.<tailnet>.ts.net, put the .crt/.key in ./certs

# tailnet (HTTPS on :8444, reachable on your tailnet)
docker compose --profile tailnet up -d --build

# public VPS (Caddy gets a Let's Encrypt cert for $DOMAIN, ports 80/443)
docker compose --profile public up -d --build
```

The first admin is created from `ADMIN_USERNAME` / `ADMIN_PASSWORD` **only if no admin exists**. It is never overwritten or reset on restart. Change the password in the app after first login.

### Development on the host

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d db rustfs   # published on 127.0.0.1 only
npm run dev            # http://localhost:3100  (plain http, COOKIE_SECURE=false)
npm test               # API tests (throw-away database on that Postgres) + editor unit tests
```

## Field flow (worker)

1. **GPS check** (stable accuracy, 90 s timeout and skip, outcome logged) and **camera + storage check**.
2. **Record**: MediaRecorder in 2 s chunks, each saved to IndexedDB with its SHA-256 before it counts. GPS is saved alongside. Wake lock on; recording stops if the page is hidden. The screen becomes a map (with "go here next") over the live camera, with a draggable divider.
3. **Recovery**: a recording cut off by a refresh, crash or closed tab is marked interrupted on the next start. The worker finalizes it, and it uploads; a new recording is blocked until then.
4. **Upload** (continuous, resumable): the phone asks the server what it already has, sends only the rest, checks every chunk's hash, and deletes its local copy only after the server verifies the manifest. If the session ends mid-recording, recording continues and uploads wait for a new sign-in.
5. **Server decides**: coverage is recomputed from the GPS the server holds, on the stored (smoothed) line. A missing GPS check, poor accuracy, gaps, or simulated data sends it to review.

Local data is kept in one IndexedDB per user, so another worker on the same phone can never see or upload it.

## Storage and video

- Chunks go to RustFS as `rec/<id>/c/<seq>-<sha256>` (the hash is in the key, so racing uploads cannot overwrite each other). The app checks the hash before writing.
- Finalize only checks the manifest, so it is fast. A background job then builds the playable file (8 MiB multipart parts, hash re-checked), remuxes it with ffmpeg so it has a real duration and can be seeked, and only then deletes the chunk objects. It survives a restart.
- Videos leave the system only through `/api/admin/...` (range requests, downloads, zip), and every view or download is audited. No worker route returns video.
- Recordings are kept until an admin deletes them (no automatic deletion).

## Dev tools

`ENABLE_DEV_TOOLS=true` (set only in `docker-compose.dev.yml`) shows fake GPS and a canvas camera on the worker page, so the flow can be tested on a laptop. Recordings made that way are flagged `simulated`, always go to review, and are labelled in review. Never set it on the VPS.

## Route editor

Pick points on the map or type them. Everything is editable until a version is published.

- Drag a vertex on the map, or edit its latitude / longitude in the table. Click a `+` on the line to add a point; select a point and press Delete.
- **New segment** + **Draw**: click the map to add points to the selected segment. Esc stops drawing. Or type `lat, lng` and press Add. Or paste many points.
- The list order is the walking order. Drag the grip to reorder (arrows work too). Numbers, colours and direction arrows on the map follow the order.
- **Curved segments** (the default for hand-drawn ones): place points along the sidewalk and the line bends smoothly through every one (centripetal Catmull-Rom, `shared/curve.ts`). The server draws the curve itself and stores both the smooth line (used for coverage and what the worker walks) and your points (so you can keep editing). It does not know where sidewalks are: it only smooths what you place.
- Split a segment at a point (scissors), join with the next, reverse direction, per-segment required/optional, name and minimum coverage.
- Undo / redo (Ctrl or Cmd + Z, add Shift to redo). Unsaved edits warn before you leave. Pure edit logic is unit-tested in `test/editor.test.ts`.

## Tests

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d db rustfs   # tests use the real Postgres and RustFS
npm test               # everything, then the endpoint check
npm run test:unit      # pure logic only, no database or storage needed
npm run test:coverage  # same tests with a line/branch coverage table (server, shared, editor logic)
```

- **Every endpoint has a test, enforced.** The app records which route answered each test request. After the tests, `test/check-endpoints.ts` compares that with the full route table (`listEndpoints()` in `server/app.ts`) and fails the run if any endpoint never answered with a 2xx. Adding a route without a test makes `npm test` fail. It also lists routes never tested with a refusal.
- API tests run against a throw-away database and bucket. Unit tests cover the curve, the editor model, the geometry and coverage maths, the GPS check and the quality flags.
- Not covered by tests yet: the phone code (`web/src/worker/*`: recorder, uploader, local database), the React screens, and `server/index.ts` start-up. Those were checked by hand in a browser.

## What is enforced where

| Rule | Where |
| --- | --- |
| Argon2id passwords | `server/auth/password.ts` |
| Server-side sessions, `__Host-sid` cookie: HttpOnly, Secure, SameSite=Lax; only a SHA-256 of the token is stored | `server/auth/sessions.ts` |
| New token on every login; deactivate / reset-password / change-password delete sessions | `server/routes/*` |
| Only admins set worker passwords; a worker cannot change their own | `routes/adminUsers.ts`, `routes/auth.ts` |
| Admin vs worker, worker sees only own assignments (404 for others) | `server/app.ts`, `routes/assignments.ts` |
| CSRF: Origin allow-list + JSON-only + SameSite | `server/http.ts` |
| Login lockout: 5 failures per username, 20 per IP, per 15 min | `routes/auth.ts` |
| Published/archived route versions are immutable | DB triggers in `db/migrations/001_init.sql` (and the API) |
| One draft and one published version per route | partial unique indexes |
| Only published versions can be assigned, only to workers | DB trigger + API |
| Required segments can never be skipped | CHECK constraint |
| Assignment keeps its version and its own segment snapshot | `assignments`, `assignment_segments` |

## Decisions made without asking

- Plain SQL migrations + `pg`, no ORM (PostGIS geometry columns).
- Admins manage workers only. There is no admin-creates-admin.
- A worker is a username, a display name and a password. Only an admin sets the password (typed, or generated and shown once), from the Workers page. It never expires and the worker cannot change it. Setting a new one signs the worker out everywhere. Worker passwords: 8+ characters. Only the admin account can change its own password (12+).
- Assignments have no notes or schedule: an admin gives a route version to a worker, that is all.
- Publishing a new version archives the previous published one. Archived versions cannot be newly assigned; existing assignments keep working.
- A route needs at least one required segment and every segment at least 5 m to be published.
- Session: 14 days absolute, 24 h idle (env-tunable).
- Hash routing in the web app (no server-side route fallback needed).

## Map tiles

The street map uses the public OpenStreetMap tile server and the terrain layer uses OpenTopoMap. Both are free community servers with usage policies (they block apps with no `Referer`, and heavy or commercial use). Fine for development and small teams. For a real deployment use a tile provider you have an account with (MapTiler, Stadia, Thunderforest) or self-host tiles, and change the URLs in `web/src/ui.tsx` and the `img-src` list in `server/app.ts`.

## VPS notes

- Only Caddy publishes ports (80/443). Postgres, RustFS and the app have no `ports:` in the main compose file. Do not add any: Docker-published ports bypass `ufw`.
- Set `PUBLIC_ORIGINS=https://your.domain`, `COOKIE_SECURE=true`, `TRUST_PROXY=1`.
- Back up the `pgdata` and `rustfs-data` volumes.

## Not done yet

- Not yet tried on a real phone (iPhone Safari, Android Chrome): camera, GPS, screen lock, and whether Safari's mp4 chunks play back joined. This is the first thing to check.
- Skipping an optional segment needs a connection (recording and upload do not).
- No admin delete for recordings, no automatic retention, no service worker (the app needs a connection to load).
- Orphan chunk objects from two racing uploads of the same chunk are not cleaned up.
