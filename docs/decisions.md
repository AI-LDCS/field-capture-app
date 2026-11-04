# Decisions

The choices that shaped the system, with the reason and what was rejected. Each is a decision about this project's needs (a few workers, video-heavy, public server later), not a general rule.

## Upload goes through the app, not straight to storage

**Decided.** The phone sends each chunk to the app, which checks login, ownership and the SHA-256, then stores it in RustFS.
**Why.** Storage stays private; no new public endpoint, CORS or presigned-URL lifetime to get wrong; the app can verify every chunk before it is stored; auth and audit are in one place.
**Rejected.** Presigned URLs straight to RustFS: less load on the app, but RustFS would need to be reachable from phones (an extra proxy route and CORS on the public server) and integrity checks get weaker.
**Cost.** The app carries the upload bandwidth. Fine at this scale.

## Chunks are content-addressed; assembly happens afterwards

**Decided.** Chunk object key = `rec/<id>/c/<seq>-<sha256>`. Finalize only checks the manifest; a background job builds the playable file, then deletes the chunks.
**Why.** Two racing uploads of the same chunk can never overwrite each other. Finalize stays fast, so the phone can delete its copy quickly. The build can fail and be retried without losing data.
**Rejected.** Assembling inside the finalize request (slow, can time out); copying chunks server-side with multipart copy (S3 parts must be at least 5 MiB; chunks are about 1 MB).

## A remux step makes the video seekable

**Decided.** After concatenation, ffmpeg rewrites the file with `-c copy` (no re-encoding).
**Why.** `MediaRecorder` output has no duration and no seek index, so browsers cannot jump around or show the length. Review needs "jump to this segment".
**Cost.** About 100 MB more in the app image; temporary disk space while building. If ffmpeg fails the plain file is kept.

## The server decides; the phone only shows progress

**Decided.** Coverage, segment status and assignment status are computed on the server from GPS it holds for **verified** recordings. The phone computes the same numbers to draw progress, with the same shared code.
**Why.** The phone is the least trusted part. "Completed" must not depend on anything a client claims.

## Quality is tracked separately from coverage

**Decided.** Poor accuracy, gaps, jumps and off-route points are counted and flagged, never discarded; flags send a fully covered assignment to **review** instead of `completed`.
**Why.** Covering a route does not mean the GPS was good; reviewers need the imperfect data.

## Route versions are immutable, and enforced in the database

**Decided.** A route is a container with numbered versions. Published and archived versions cannot change. "Edit" copies the latest version into a draft. Assignments point at a version and keep their own segment list. The rules live in database triggers as well as in the API.
**Why.** "Editing a route must not silently change an existing assignment." A trigger holds even for code that bypasses the API.
**Found by review.** The route *name* used to live on the route, so renaming a draft changed existing assignments. It now lives on the version.
**Changed later.** Admins needed to fix a route's name without making a new version, so a route rename now changes the name on every version, on purpose, and is audited. Saving a draft with a new name still leaves earlier versions alone. Segments stay frozen.

## Smooth curves are drawn on the server

**Decided.** The admin places control points; the server draws the curve (centripetal Catmull-Rom) and stores both the curve and the points.
**Why.** The stored line is what coverage uses and what the worker walks, so it must not depend on what a client claims. Storing the control points keeps curves editable.
**Rejected.** Routing onto OpenStreetMap footpaths (a self-hosted routing engine or a hosted API). The owner chose plain smoothing: no extra service, no third party seeing the routes, but it does not know where sidewalks are.

## Workers are simple: username, display name, a password only an admin sets

**Decided.** No notes, no schedule, no worker password change, no forced change at first login. An admin types a password or lets the server generate one (shown once). Setting one signs the worker out everywhere.
**Why.** Requested: workers are people with a phone, not account managers. Passwords are stored hashed, so they cannot be shown again; that trade was chosen over reversible encryption.

## Sessions are server-side, with hashed tokens

**Decided.** Random token in a `__Host-` cookie; only its SHA-256 is stored; deleting a user's rows signs them out immediately.
**Why.** Instant revocation (deactivate, reset), and a database leak does not leak live sessions. A signed stateless token cannot be revoked that way.

## Login is protected by a lockout, not a captcha

**Decided.** 5 failures per username or 20 per IP in 15 minutes.
**Cost.** Someone can lock a known username out for 15 minutes; accepted for the few accounts here.

## Local data is per user, and recording is never interrupted by a lost session

**Decided.** One IndexedDB per user. A 401 during recording shows a banner and pauses uploads; it never replaces the screen. Sign-out with unsent data asks first.
**Why.** Two workers can share a phone; an expired session must not destroy a walk in progress.

## Cut-off recordings are found at start-up, with a lock to protect live ones

**Decided.** At sign-in, recordings still marked `recording` become `interrupted`, unless another tab holds a Web Lock for them.
**Found by testing.** The scan was initially forgotten and recovery silently did nothing. Two tabs open at once would otherwise mark each other's live recordings as dead.

## Workers download only what the server holds; playback and exports stay with admins

**Decided.** A worker can download their own video and GPS from `/api/me/recordings/:id/download` and `/gps.json`, but only after the server has verified the recording (and built the video). Playback and whole-assignment exports remain admin-only. Every download is audited and marked as made by a worker.
**Why.** The original requirement was to stop workers exporting data before it is uploaded. Workers also need their own files back, so the rule became: nothing leaves the phone's storage, and what leaves the server is the worker's own, verified copy.
**Changed.** Earlier, no `/api/me` route returned recording bytes at all. That was relaxed on request; the ownership and verification checks keep the original goal.

## Plain SQL migrations, no ORM

**Decided.** SQL files applied in order; `pg` with parameterised queries.
**Why.** PostGIS geometry columns and trigger-based rules fit SQL better than an ORM; the schema is small and easy to read.

## One image, one process

**Decided.** API, static web app and the video job in one Node process; Postgres, RustFS and Caddy as separate containers; no queue, no orchestrator.
**Why.** The workload is small. Avoids Kubernetes, an external identity platform and distributed infrastructure until real requirements justify them.

## TLS at the edge, plain HTTP inside

**Decided.** Caddy terminates TLS (Tailscale certificate files or Let's Encrypt); the app speaks HTTP on the private network and trusts one proxy hop.
**Why.** Keeps certificate handling out of the app, and the same app image works under both profiles.

## Dev tools exist only behind a server flag, and mark their data

**Decided.** Fake GPS and a canvas camera need `ENABLE_DEV_TOOLS=true`, which only the dev override sets. Recordings made with them are `simulated`, always go to review, and are labelled.
**Why.** Lets the full flow be tested without walking, and keeps fake data from ever passing as real.

## Tests prove themselves

**Decided.** Every endpoint must have a passing test (enforced after the run); rules are tested at the database level where they live; new tests are checked by deliberately breaking the code.
**Why.** An unenforced "everything is tested" claim drifts; a test that cannot fail is noise. See [testing](testing.md).
