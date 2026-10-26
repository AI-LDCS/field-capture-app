# Security

What the system protects, how, and what it deliberately does **not** protect. Written for someone deciding whether it is safe to put on a public server.

- [Summary](#summary)
- [Authentication](#authentication)
- [Sessions](#sessions)
- [Authorization](#authorization)
- [Request safety](#request-safety)
- [Data protection](#data-protection)
- [Network exposure](#network-exposure)
- [Audit](#audit)
- [What is not protected](#what-is-not-protected)
- [Before going public: checklist](#before-going-public-checklist)

## Summary

| Area | Control |
| --- | --- |
| Passwords | Argon2id (19 MiB memory, 2 iterations, 1 lane). Worker passwords are set only by an admin. |
| Sessions | server-side, random 256-bit token in an `HttpOnly`, `Secure`, `SameSite=Lax` `__Host-` cookie; only the token's SHA-256 is stored |
| Brute force | lockout: 5 failures per username or 20 per IP in 15 minutes; same hashing work for unknown users |
| Roles | enforced on the server for every endpoint; worker data scoped by owner (`404` for others) |
| CSRF | `Origin` allow-list + JSON-only bodies + `SameSite=Lax` |
| Browser hardening | CSP, HSTS, `frame-ancestors 'none'`, `Referrer-Policy`, `nosniff` |
| Immutability | published route versions and verified recordings are frozen by database triggers |
| Video access | only admins, only through audited endpoints |
| Exposure | only Caddy publishes ports; database and storage are private |

## Authentication

- Username and password only. No OAuth, SSO or external identity provider.
- Passwords are hashed with **Argon2id** (`server/auth/password.ts`). A wrong username costs the same time as a wrong password (a dummy hash is verified), so response time does not reveal which usernames exist. The error text is identical for a wrong password, an unknown user and a deactivated user.
- **Admin bootstrap**: the first admin is created from `ADMIN_USERNAME` / `ADMIN_PASSWORD` in the environment **only if no admin exists**. It never overwrites or resets an existing account, so restarts and re-seeding are safe. The password must be at least 12 characters. Nothing is hardcoded, and `.env` is gitignored. Change it in the app after the first login.
- **Workers**: username, display name, password. An admin creates the account and sets (or generates) the password. The worker cannot change it. Minimum 8 characters, because workers type it on a phone; admin accounts need 12.
- **Lockout**: after 5 failed logins for one username, or 20 for one IP, within 15 minutes, logins are refused with `429` (and `Retry-After`) even with the right password. A successful login clears the username's failures. Each failure and each lockout is audited.

## Sessions

- A new random token on every login (no session fixation); the old one is deleted.
- The cookie is `__Host-sid` (needs `Secure`, `Path=/`, no `Domain`) over HTTPS, `HttpOnly`, `SameSite=Lax`. On plain-http local development (`COOKIE_SECURE=false`) it is `sid`.
- The database stores only `SHA-256(token)`; a database leak does not leak usable sessions.
- Limits: **14 days** absolute, **24 hours** idle (`SESSION_ABSOLUTE_HOURS`, `SESSION_IDLE_HOURS`). `last_seen_at` is refreshed at most once a minute.
- **Sessions are killed when they should be**: deactivating or deleting a worker, an admin setting a worker's password, and a password change all delete the user's sessions immediately. A password change keeps only the current session.
- If a session dies while a worker is recording, the recording continues and uploads pause until they sign in again (see [field flow](field-flow.md#when-the-session-ends-mid-recording)).

## Authorization

- Every `/api/admin` route requires an admin; every `/api/me` route requires a worker. Checks run on the server; the web app hiding a button is not a control.
- **Ownership**: every worker query is scoped to the signed-in worker (`assignments.user_id`, `recordings.user_id`). Another worker's assignment or recording answers `404`, identical to a missing one, and registering a recording id that belongs to someone else also answers `404` (never "existing"), so ids cannot be probed.
- **Admins manage workers only.** There is no admin-creates-admin feature.
- **Workers never receive video bytes.** No `/api/me` route returns a recording. The worker interface has no download or export. Video, downloads and exports exist only under `/api/admin` and are audited.

## Request safety

- **CSRF** (in addition to `SameSite=Lax`): a state-changing request must carry an `Origin` in `PUBLIC_ORIGINS` (or `Sec-Fetch-Site: same-origin`/`none` if there is no `Origin`), and its body must be `application/json`. The one exception is the chunk upload, which takes `application/octet-stream` on that route only; a cross-site HTML form cannot send either type.
- **Validation**: every body is validated with zod. Ids that are not UUIDs are not found. JSON is limited to 2 MB, chunks to 32 MiB.
- **Headers** (`helmet`): `Content-Security-Policy` allows scripts and connections only from the app itself, images from the app plus the three map tile hosts, `frame-ancestors 'none'`; `Strict-Transport-Security` when `COOKIE_SECURE`; `Referrer-Policy: strict-origin-when-cross-origin` (tile servers reject requests with no referrer); `X-Content-Type-Options: nosniff`.
- **SQL** uses parameters everywhere; no string-built queries from input.
- **Proxy trust**: `TRUST_PROXY=1` means one proxy hop (Caddy). Without it, `Secure` cookies are never set behind the proxy and client IPs are wrong for the lockout.

## Data protection

- **Upload integrity**: every chunk is hashed on the phone and again by the server; a mismatch is refused (`422`). Chunk objects are named with their hash, so concurrent uploads cannot overwrite one another. Finalize verifies the full manifest. Video assembly re-checks every chunk against its recorded hash before building the file.
- **Frozen evidence**: a verified recording's counts, start time, GPS and chunk rows cannot change (database triggers). A published route version and its segments cannot change; an assignment keeps the segments it was given.
- **Local data on the phone** is deleted only after the server has verified the recording, and is kept per user.
- **Retention**: recordings are kept until an admin deletes them; there is no automatic deletion yet (an admin delete is on the [roadmap](roadmap.md)).
- **Backups** protect against loss, not against disclosure: store them somewhere private. See [operations](operations.md#backup-and-restore).

## Network exposure

- In the main compose file **only Caddy publishes ports** (`8444` for the tailnet profile; `80` and `443` for the public profile). The app, Postgres and RustFS have no `ports:`.
- **Docker-published ports bypass `ufw`.** Do not add `ports:` to the database or storage on a public server, and do not trust a host firewall to hide one. `docker-compose.dev.yml` publishes them on `127.0.0.1` only and must not be used on a server.
- The tailnet profile binds `8444` on all interfaces of the machine. To limit it to your Tailscale address, edit the `ports:` line of `caddy-tailnet` to `<tailscale-ip>:8444:443`.
- The app runs as a non-root user in its container.

## Audit

`audit_log` records logins, failures and lockouts, account changes, route and version actions, assignments, GPS-check outcomes, skips, every step of a recording (registered, verified, verification failed, assembled, viewed, downloaded), exports and review decisions, with the actor and IP. An admin sees an assignment's trail on its review page. There is no global audit screen yet.

## What is not protected

- **A determined user with their own device can extract local data.** Browser storage is not a security boundary. The app omits download features and keeps data in application-managed storage, but if preventing extraction is a strict requirement, use managed devices or a native app. UI restrictions alone are not enough.
- **Hosted map tiles** (OpenStreetMap, OpenTopoMap) see the map area being viewed and the visitor's IP. Use a tile provider you have an agreement with, or self-host tiles, for production.
- **No two-factor login, no password reset by email** (an admin resets worker passwords).
- **No automatic protection against an admin account being phished.** Use a long unique password.
- **Dev tools** (`ENABLE_DEV_TOOLS`) must never be on a production server: they add fake-data features. Recordings made with them are flagged `simulated`, but the switch itself is a risk.
- **Rate limiting** exists for login only. Other endpoints rely on authentication and size limits.

## Before going public: checklist

- [ ] `.env` has long random values for `POSTGRES_PASSWORD`, `ADMIN_PASSWORD`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`; the file is not in git.
- [ ] `COOKIE_SECURE=true`, `TRUST_PROXY=1`, `PUBLIC_ORIGINS` is exactly your HTTPS origin(s).
- [ ] `ENABLE_DEV_TOOLS` is not set (the production compose file sets it to `false`). Do not start with the dev override.
- [ ] Only ports 80/443 are open; `docker compose ps` shows no published port for `app`, `db` or `rustfs`.
- [ ] You changed the admin password in the app after first login.
- [ ] Test or seed accounts were removed or had their passwords reset.
- [ ] Backups run and a restore has been tried ([operations](operations.md#backup-and-restore)).
- [ ] A production map tile provider is configured.
