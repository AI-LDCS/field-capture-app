# Field Capture (real build, milestone 1)

Login, admin, versioned routes, assignments. Recording and upload come in milestone 2.

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

## Route editor

Pick points on the map or type them. Everything is editable until a version is published.

- Drag a vertex on the map, or edit its latitude / longitude in the table. Click a `+` on the line to add a point; select a point and press Delete.
- **New segment** + **Draw**: click the map to add points to the selected segment. Esc stops drawing. Or type `lat, lng` and press Add. Or paste many points.
- The list order is the walking order. Drag the grip to reorder (arrows work too). Numbers, colours and direction arrows on the map follow the order.
- **Curved segments** (the default for hand-drawn ones): place points along the sidewalk and the line bends smoothly through every one (centripetal Catmull-Rom, `shared/curve.ts`). The server draws the curve itself and stores both the smooth line (used for coverage and what the worker walks) and your points (so you can keep editing). It does not know where sidewalks are: it only smooths what you place.
- Split a segment at a point (scissors), join with the next, reverse direction, per-segment required/optional, name and minimum coverage.
- Undo / redo (Ctrl or Cmd + Z, add Shift to redo). Unsaved edits warn before you leave. Pure edit logic is unit-tested in `test/editor.test.ts`.

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

## Not done yet (milestone 2+)

Recording, IndexedDB recovery, resumable upload to RustFS, server verification, completion rules, audit screens, service worker.
