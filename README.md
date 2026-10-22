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
npm test               # 25 API tests against a throw-away database on that Postgres
```

## What is enforced where

| Rule | Where |
| --- | --- |
| Argon2id passwords | `server/auth/password.ts` |
| Server-side sessions, `__Host-sid` cookie: HttpOnly, Secure, SameSite=Lax; only a SHA-256 of the token is stored | `server/auth/sessions.ts` |
| New token on every login; deactivate / reset-password / change-password delete sessions | `server/routes/*` |
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
- Admin-set and reset passwords are temporary: the worker must change them at first login.
- Publishing a new version archives the previous published one. Archived versions cannot be newly assigned; existing assignments keep working.
- A route needs at least one required segment and every segment at least 5 m to be published.
- Session: 14 days absolute, 24 h idle (env-tunable).
- Hash routing in the web app (no server-side route fallback needed).

## VPS notes

- Only Caddy publishes ports (80/443). Postgres, RustFS and the app have no `ports:` in the main compose file. Do not add any: Docker-published ports bypass `ufw`.
- Set `PUBLIC_ORIGINS=https://your.domain`, `COOKIE_SECURE=true`, `TRUST_PROXY=1`.
- Back up the `pgdata` and `rustfs-data` volumes.

## Not done yet (milestone 2+)

Recording, IndexedDB recovery, resumable upload to RustFS, server verification, completion rules, audit screens, service worker.
