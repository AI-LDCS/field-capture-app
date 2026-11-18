# API reference

All endpoints are JSON over HTTPS, served by the same Node process as the web app. This page lists every endpoint. A test (`test/repo/docs.test.ts`) fails if an endpoint exists that is not listed here, and `npm test` fails if an endpoint has no test (see [testing](../development/testing.md)).

- [Conventions](#conventions)
- [Health](#health) · [Auth](#auth) · [Admin: workers](#admin-workers) · [Admin: routes](#admin-routes-and-versions) · [Admin: assignments](#admin-assignments) · [Admin: recordings](#admin-recordings) · [Worker: assignments](#worker-assignments) · [Worker: recordings](#worker-recordings) · [Anonymizer worker](#anonymizer-worker) · [Still images](#still-images)
- [Error codes](#error-codes)

Shapes named in **bold** (for example **AssignmentDetail**) are the TypeScript types in `shared/types.ts`.

## Conventions

**Authentication.** A session cookie (`__Host-sid` over HTTPS, `sid` on plain-http development) set by `POST /api/auth/login`. It is `HttpOnly`, `Secure`, `SameSite=Lax`. There are no API keys. The one exception is the anonymizer worker (see [Anonymizer worker](#anonymizer-worker)), which is a machine, not a person, and sends a bearer token instead.

**Roles.** `admin` and `worker`. Routes under `/api/admin` need an admin; routes under `/api/me` need a worker. A wrong role answers `403 forbidden`, no login answers `401 unauthenticated`. A worker asking for another worker's assignment or recording gets `404 not_found`, never `403`, so ids cannot be probed.

**State-changing requests** (`POST`, `PUT`, `PATCH`, `DELETE`) must pass the CSRF guard:
- the `Origin` header must be one of `PUBLIC_ORIGINS` (a request with no `Origin` is accepted only if `Sec-Fetch-Site` is `same-origin` or `none`), otherwise `403 bad_origin`;
- a request body must be `application/json`, otherwise `415 json_required`. The exceptions are `PUT /api/me/recordings/:id/chunks/:seq`, which takes `application/octet-stream`, and everything under `/api/anonymizer`, which is not a browser: it is called with a bearer token, no cookie, and the CSRF checks are skipped for it (a cookie can never authenticate those routes).

**Errors** are always JSON: `{ "error": "<code>", "message": "<human text>", ...extra }`. Validation failures are `400 invalid_input` with the offending fields in `message`. Database rules that refuse a change (immutable versions, unique names, check constraints) answer `409`. Codes are listed [at the end](#error-codes).

**Caching.** Every `/api` response carries `Cache-Control: no-store`.

**IDs** are UUIDs. A malformed id answers `404`, not `400`.

**Times** are ISO strings, except GPS and recording times, which are milliseconds since the epoch (`t`, `startedAt`, `endedAt`, `*Ms`).

**Coordinates** are GeoJSON order: `[longitude, latitude]`.

## Health

### GET /healthz
No login. Runs `SELECT 1`. `200 { "ok": true }`, or `500` if the database is down.

## Auth

### POST /api/auth/login
Body `{ username, password }`. `200 { user: { id, username, displayName, role }, devTools }` and sets the cookie. A new session token is made on every login.
Errors: `401 invalid_credentials` (same text for a wrong password, an unknown user and a deactivated user), `429 too_many_attempts` (with `Retry-After: 900`). After 5 failed logins for one username, or 20 for one IP, within 15 minutes, logins are refused even with the right password.

### POST /api/auth/logout
Deletes the session and clears the cookie. `200 { ok: true }`. Harmless without a session.

### GET /api/auth/me
`200 { user, devTools }`. `devTools` is `true` only when the server runs with `ENABLE_DEV_TOOLS` (fake GPS and camera on the worker page).

### POST /api/auth/change-password
**Admin only.** Body `{ currentPassword, newPassword }` (new: 12 to 128 characters). `200 { ok: true }`. Signs out every other session of the admin; the current one stays.
Errors: `403 forbidden` for a worker (workers cannot change their password; an admin sets it), `400 wrong_password`, `400 same_password`, `400 invalid_input`.

## Admin: workers

A worker is a username, a display name and a password that only an admin can set. Admin accounts cannot be managed here.

### GET /api/admin/users
`200 WorkerRow[]` where `WorkerRow = { id, username, displayName, active, createdAt }`. Active workers first, then by username.

### POST /api/admin/users
Body `{ username, displayName?, password? }`. Username: 3 to 32 characters of `a-z 0-9 . _ -`, lowercased by the server. Password: 8 to 128 characters; leave it out and the server generates one.
`201 { user: WorkerRow, generatedPassword? }`. `generatedPassword` is returned **once**, and only when the server generated it. A password the admin typed is never sent back. Passwords are stored hashed (Argon2id) and cannot be shown again.
Errors: `409 conflict` (name taken, in any letter case), `400 invalid_input`.

### PATCH /api/admin/users/:id
Body `{ displayName }` (up to 80 characters). `200 WorkerRow`. `404` for an unknown id or an admin account.

### POST /api/admin/users/:id/deactivate
`200 WorkerRow`. The worker is signed out everywhere at once and cannot log in.

### DELETE /api/admin/users/:id
`200 { ok: true }`. Removes the worker's login: they are signed out at once and can never log in again, and they no longer appear in the worker list. Their assignments and recordings stay, and an assignment's `worker` then has `deleted: true`. The username can be used for a new worker. Cannot be undone; use deactivate for a reversible block. `404` for an unknown id, an admin account, or a worker that is already deleted.

### POST /api/admin/users/:id/activate
`200 WorkerRow`. Old sessions are not revived.

### POST /api/admin/users/:id/password
Body `{ password? }` (8 to 128 characters, or empty to generate). `200 { generatedPassword }` when generated, else `200 { ok: true }`. Deletes every session of that worker.

## Admin: routes and versions

A route is a name plus numbered **versions** (`draft`, `published`, `archived`). Only a draft can be edited; a rename applies to every version. A route has at most one draft and one published version. See [data model](data-model.md#route-versions).

**Segment input** (used by create and save):

| Field | Rules |
| --- | --- |
| `name` | optional, up to 80 characters |
| `required` | boolean |
| `smooth` | optional boolean (default `false`). `true`: `coords` are control points and the server draws a smooth curve through them |
| `coords` | 2 to 5000 points `[lng, lat]`, longitude within ±180, latitude within ±90 |
| `minCoverageRatio` | optional, 0.5 to 1 (default 0.9) |

**RouteVersion** returned by the endpoints below: `{ id, routeId, routeName, version, status, createdAt, publishedAt, segments: [{ id, order, name, required, smooth, coords, minCoverageRatio, lengthM }] }`. For a smooth segment `coords` are the control points; `lengthM` is the length of the stored curve.

### GET /api/admin/routes
`200` list of `{ id, name, createdAt, versions: [{ id, version, name, status, publishedAt, createdAt, segmentCount, lengthM, assignmentCount }] }`, newest route first, newest version first. The route `name` follows the latest published version (the creation name until something is published); each version also carries its own `name`.

### GET /api/admin/routes/:id
`200 { id, name, versions: RouteVersion[] }`. `404` if unknown.

### GET /api/admin/route-versions/:vid
`200 RouteVersion`. `404` if unknown.

### POST /api/admin/routes
Body `{ name (1 to 120 characters), segments: SegmentInput[] }` (0 to 200 segments). Creates the route and a **draft v1**. `201 RouteVersion`.

### PUT /api/admin/route-versions/:vid
Body `{ name?, segments }`. Replaces the draft's segments (and renames the draft). `200 RouteVersion`. The editor autosaves through this, so `route_draft_saved` is written at most once per 10 minutes per draft and admin.
Errors: `409 not_a_draft` (published and archived versions cannot be edited; only their name can change, through a route rename).

### PATCH /api/admin/routes/:id
Body `{ name (1 to 120 characters) }`. Renames the route and all its versions, including published and archived ones, so existing assignments show the new name too. Segments do not change. `200 { id, name }`. `404` for an unknown or deleted route.

### DELETE /api/admin/routes/:id
`200 { ok: true }`. Hides the whole route from the list. Its drafts are deleted and its published version is archived (no new assignments); its published and archived versions are kept, so existing assignments and recordings continue to work and their `route` has `deleted: true`. A route that was never published is removed completely. Cannot be undone. `404` for an unknown or already-deleted route.

### DELETE /api/admin/route-versions/:vid
Deletes a **draft**. If it was the route's last version, the route goes too. `200 { ok: true }`. `409 not_a_draft` for any other status.

### POST /api/admin/routes/:id/new-version
Copies the latest version (segments, curve control points and name) into a new draft with the next number. `201 RouteVersion`. `409 draft_exists` (with `draftId`) if a draft is already open.

### POST /api/admin/route-versions/:vid/publish
Publishes a draft and archives the previously published version, in one transaction. `200 RouteVersion`.
Errors: `400 empty_route` (no segments), `400 no_required_segment`, `400 bad_segment` (a segment shorter than 5 m or invalid), `409 not_a_draft`.

### POST /api/admin/route-versions/:vid/archive
Retires a published version: it can no longer be assigned, existing assignments carry on. `200 RouteVersion`. `409 not_published`.

## Admin: assignments

**AssignmentSummary** = `{ id, status, createdAt, updatedAt, worker: { id, username, displayName }, route: { id, name, versionId, version }, progress: { segmentsDone, segmentsTotal, requiredDone, requiredTotal } }`.

**AssignmentDetail** = AssignmentSummary plus `{ reasons[], preflight, quality, completedAt, recordings: RecordingSummary[], segments: [{ id, routeSegmentId, order, name, required, status, skipReason, completedAt, coords, minCoverageRatio, lengthM, coverage, evidence: [{ recordingId, coverage, firstTMs, lastTMs }] }] }`. Segment `coords` are the stored (smoothed) line the worker must walk.

**RecordingSummary** = `{ id, status ("uploading" | "server_verified"), startedAtMs, endedAtMs, chunkCount, bytes, gpsCount, simulated, stopReason, assembly ("none" | "pending" | "running" | "done" | "failed"), fileBytes, anonymization (the same five values, for the copy with faces and plates hidden), anonymizedBytes }`.

### GET /api/admin/assignments
Query `status` and `userId` (both optional). `200 AssignmentSummary[]`, newest first, at most 500. A malformed `userId` answers `404`.

### GET /api/admin/assignments/:id
`200 AssignmentDetail`. `404` if unknown.

### POST /api/admin/assignments
Body `{ routeVersionId, userId, purpose? }`. `purpose` is `training` (the worker may download the still images, to label them) or `inference` (admins only; GPS and IDs are written into the images). It defaults to `inference` and cannot be changed afterwards. Copies the version's segment list into the assignment. `201 AssignmentDetail`.
Errors: `409 not_published` (only published versions), `409 worker_inactive`, `404` (unknown version, or the user is not a worker).

### DELETE /api/admin/assignments/:id
Withdraws an assignment nobody has started. `200 { ok: true }`. `409 already_started` once it has left `assigned`.

### GET /api/admin/assignments/:id/audit
`200` list of `{ id, at, action, details, actor }` for the assignment and its recordings, newest first, at most 200.

### POST /api/admin/assignments/:id/review
Body `{ decision: "approve" | "reject" }`. Only for an assignment in `needs_review`. Approve gives `completed`; reject gives `in_progress` (the worker can record more). `200 AssignmentDetail`. `409 not_in_review`.

### POST /api/admin/assignments/:id/re-evaluate
Runs the server's completion check again (see [field flow](field-flow.md#how-the-server-decides)). `200 AssignmentDetail`.

### GET /api/admin/assignments/:id/export.json
Download (`Content-Disposition: attachment`): assignment, worker, route as GeoJSON, every verified recording with its GPS points and video-relative times, and the audit trail. Audited as `assignment_exported`.

### GET /api/admin/assignments/:id/export.zip
Download: `assignment.json`, one `gps-N-<id>.json` per verified recording, and the videos that are ready. Videos are streamed from storage one at a time, never held in memory. `409 nothing_to_export` if no recording is verified. Audited.

## Admin: recordings

Video leaves the system only through these routes, and each view or download is written to the audit log.

### GET /api/admin/recordings
`200` list of every **verified** recording, newest first (at most 1000): `{ id, assignmentId, verifiedAt, startedAtMs, endedAtMs, gpsCount, fileBytes, assembly, anonymization, anonymizedBytes, simulated, worker: { id, username, displayName, deleted }, route: { name, version, deleted } }`. It lists what can be downloaded; the bytes come from the routes below. Used by the Downloads page.

### GET /api/admin/recordings/:id/gps
`200` list of `{ seq, t, lat, lng, acc }`.

### GET /api/admin/recordings/:id/video
Streams the assembled video: the original, or with `?variant=anonymized` the anonymized copy (`400 bad_variant` for any other value; `409 not_anonymized` until that copy exists, and it never falls back to the original). Supports `Range` and answers `206` with `Content-Range` and `Accept-Ranges: bytes` (needed for seeking and for iOS Safari). `416` for a range past the end. `409 not_verified`, or `409 not_ready` while the file is still being built. Audited as `recording_viewed` with `details.variant` (once per play, not per range request).

### GET /api/admin/recordings/:id/download
The same file as an attachment. The original by default (`recording-<id>.webm`); `?variant=anonymized` gives the anonymized copy (`recording-<id>-anonymized.webm`), with the same errors as `/video`. Audited as `recording_downloaded` with `details.variant`.

### GET /api/admin/recordings/:id/gps.json
GPS as an attachment: `{ recordingId, assignmentId, mime, simulated, videoStartedAt, videoStartedAtMs, note, recorderWindowS, videoDurationS, timeMismatchS, timeWarning, points: [{ seq, timestamp, timestampMs, latitude, longitude, accuracyM, videoTimeS }] }`. `videoTimeS` is seconds from the start of the video, so points line up with the footage. It comes from the phone's clock and does not look at the video. `recorderWindowS` is how long the recorder ran, `videoDurationS` the real length of the finished file, and `timeMismatchS` the first minus the second (positive = the video is shorter). When they differ by more than 2 s, `timeWarning` explains that GPS may not line up with the footage; the times are not changed. Each of these is `null` when unknown (`videoDurationS` is `null` for recordings built before migration 009). The same fields are in the full export. Audited as `gps_downloaded`.

### POST /api/admin/recordings/:id/reassemble
Starts the video build again for a recording whose build `failed` and whose chunks are still stored. `200 { ok: true }`. `409 cannot_reassemble` if the recording is not verified or its chunks were already cleaned up after a good build.

### POST /api/admin/recordings/:id/reanonymize
Queues the anonymized copy again, with its attempts reset, for a built recording whose anonymization `failed` (or was never queued). `200 { ok: true }`. `409 cannot_reanonymize` for anything else. Audited as `recording_anonymize_requeued`.

## Worker: assignments

Every route below is scoped to the signed-in worker's own assignments; anything else is `404`.

### GET /api/me/assignments
`200 AssignmentSummary[]`, newest first.

### GET /api/me/assignments/:id
`200 AssignmentDetail` (this worker's recordings only).

### POST /api/me/assignments/:id/preflight
Body `{ result: "passed" | "skipped", durationMs, samples, bestAccuracyM | null, note? }`. Stores the GPS-check outcome. A `skipped` check sends the assignment to review. `200 { ok: true }`.

### POST /api/me/assignments/:id/segments/:segId/skip
Body `{ reason? }` (up to 200 characters). `:segId` is the assignment segment's `id`. **Optional segments only**: `400 required_segment` for a required one (the database refuses it too). `200 AssignmentDetail`.

### POST /api/me/assignments/:id/segments/:segId/unskip
Puts a skipped segment back to pending and recomputes. `200 AssignmentDetail`.

### POST /api/me/assignments/:id/finish
"I am done": the server checks uploads, GPS and coverage and decides the status. `200 AssignmentDetail` with `status` and `reasons`. `409 completed` once the assignment is completed. All the worker actions above also answer `409 completed` after completion.

## Worker: recordings

The upload protocol is described in [field flow](field-flow.md#upload-protocol).

### POST /api/me/recordings
Registers a recording. Body `{ id (UUID made on the phone), assignmentId, mime (video/*), startedAt (ms), simulated? }`. Idempotent: registering the same id again for the same assignment answers `200 { ok, existing: true }`. `201 { ok: true }` when new. Moves the assignment to `in_progress`.
Errors: `404` if the assignment is not the caller's **or** the id already belongs to someone else's recording (same answer, so ids cannot be probed), `409 completed`, `400 dev_tools_off` (`simulated: true` is accepted only while dev tools are on).

### GET /api/me/recordings/:id/status
`200 { verified, chunkSeqs[], gpsSeqs[] }`: what the server already holds, so a phone resends only the rest.

### GET /api/me/recordings/:id/gps
`200` list of `{ seq, t, lat, lng, acc }`: the worker's own track (used to draw what is already covered). Not a download; see `gps.json` below.

### GET /api/me/recordings/:id/download
The worker's own video as an attachment, only once the server holds it. By default it is the **anonymized** copy; `?variant=original` gives the video as the phone recorded it (`400 bad_variant` for any other value). `409 not_verified` before verification; `409 not_ready` while the original is still being built; `409 not_anonymized` while the anonymized copy is not ready (the default never falls back to the original). Another worker's recording is `404`, the same as a missing one. Audited as `recording_downloaded` with `details.by = "worker"` and `details.variant`. There is no playback route for workers.

### GET /api/me/recordings/:id/gps.json
The worker's own GPS as an attachment (the same file the admin gets: points with `videoTimeS`). `409 not_verified` before verification, `404` for someone else's recording. Audited as `gps_downloaded` with `details.by = "worker"`.

### PUT /api/me/recordings/:id/chunks/:seq
Body: the raw chunk bytes, `Content-Type: application/octet-stream`, header `x-sha256: <hex digest of the body>`. Limits: 1 byte to 32 MiB, `seq` 0 to 99,999.
- `200 { ok: true }` stored; `200 { ok, duplicate: true }` the same bytes were already stored for this `seq` (safe to retry);
- `422 checksum_mismatch` the body does not match its digest (nothing stored);
- `409 seq_conflict` this `seq` is stored with different bytes; `409 already_verified`;
- `400 bad_seq`, `400 empty_chunk`.

### POST /api/me/recordings/:id/gps
Body `{ points: [{ seq, t, lat, lng, acc }] }`, 1 to 1000 points per call. Idempotent (an existing `seq` is left alone). `200 { ok: true }`.

### POST /api/me/recordings/:id/finalize
Body `{ startedAt?, endedAt?, stopReason?, chunks: [{ seq, sha256 }], gpsCount }`. The manifest must list chunks `0..n-1`. The server checks it against what it holds: every chunk present with a matching hash, nothing extra, and GPS `seq` values exactly `0..gpsCount-1`. On success the recording becomes `server_verified` (frozen), segment coverage is recomputed and the video build is queued. Safe to repeat.
`409 manifest_mismatch` with `{ missingChunks[], mismatched[], extra[], gpsOk, gpsHave }`.

### DELETE /api/me/recordings/:id
Drops a recording that never received a chunk. `200 { ok: true }`. `409 has_chunks`, `409 already_verified`.

## Anonymizer worker

The machine that hides faces and plates (`worker.py` next to `anonymize.py`, run on the GPU computer; see [anonymizer](../operations/anonymizer.md)). Every route needs `Authorization: Bearer <ANONYMIZER_TOKEN>`; a session cookie does not work. Until `ANONYMIZER_TOKEN` is set the whole prefix answers `404 not_found`; without a bearer header it is `401 unauthenticated`, and a wrong token is `401 bad_token`.

A claim is a **lease**. `POST /claim` returns a `leaseId`; every later call for that recording sends it as the `x-lease-id` header (`400 bad_lease` if it is missing or malformed). A lease runs out after `ANON_LEASE_MINUTES` of silence, and then another claim can take the job, so the old worker's calls answer `409 lease_lost` and cannot finish it.

### POST /api/anonymizer/claim
Takes the oldest built recording that is waiting. `200 { id, leaseId, leaseSeconds, attempt, ext, mime, bytes, sha256 }` (`bytes` and `sha256` describe the original, so the worker can check its download), or `204` with no body when nothing is waiting. Claims that ran out are first given back, or failed once they have used their 3 attempts. Audited as `recording_anonymize_started`.

### GET /api/anonymizer/:id/source
Streams the original video to the worker that holds the claim. `409 not_claimed` if nobody does, `409 lease_lost` for a lease that is stale or someone else's.

### POST /api/anonymizer/:id/heartbeat
"Still working": pushes the lease out by `leaseSeconds`. `200 { ok: true, leaseSeconds }`. The same `409` errors as `/source`.

### PUT /api/anonymizer/:id/result
Body: the anonymized video, raw bytes, `Content-Type: application/octet-stream`. Headers: `x-lease-id`, `x-sha256` (hex SHA-256 of the body), `Content-Length` (required, `411 length_required` without it), and optionally `x-anon-mode` (a lowercase word such as `solid`). The body streams into storage and is never held in memory. Checks, in this order: `400 bad_checksum` (missing or malformed `x-sha256`), `400 bad_mode`, then after the bytes have arrived `422 size_mismatch` (length differs from `Content-Length`) and `422 checksum_mismatch`. A failed check stores nothing and leaves the claim as it was. If the lease ran out during the upload, `409 lease_lost` and the file is deleted. `200 { ok: true }` records the copy next to the original (`rec/<id>/anon-<lease>.<ext>`) and marks the job `done`. Audited as `recording_anonymized`.

### POST /api/anonymizer/:id/fail
Body `{ error }` (up to 500 characters). Gives the claim up. The job goes back in the queue while it has attempts left, otherwise it is `failed` until an admin queues it again. `200 { ok: true, retry: boolean }`. Audited as `recording_anonymize_failed`.

## Still images

Besides the anonymized video, the GPU worker cuts each finished video into still images: the sharpest frame in every `SAMPLE_STEP_M` metres walked, anonymized, and for an *inference* assignment tagged with GPS and IDs. See [anonymizer](../operations/anonymizer.md#still-images). Each image has a `frame` number that counts across the whole assignment in walking order; `recordingIndex` says which recording it came from.

### POST /api/anonymizer/frames/claim
Same bearer token and rules as the video routes. Takes the oldest built recording whose images are waiting and whose earlier recordings (same assignment) are finished, or `204`. `200 { id, leaseId, leaseSeconds, attempt, ext, mime, bytes, sha256, stepM, gapMaxM, purpose, embed, assignmentId, routeId, routeVersionId, recordingId, recordingIndex, carry, timeUncertain, gps }`. `embed` is true for inference: the worker writes GPS and IDs into the images. `carry` is the counter state at the end of the recording before (`{ cumM, nextFrame, lastLat, lastLng }`), or `null`. `timeUncertain` is true when the video and the recorder's clock disagree by more than 2 s. `gps` is the points as in `gps.json`. Any images left by an earlier, abandoned attempt are deleted first. Audited as `recording_frames_started`.

### GET /api/anonymizer/frames/:id/source
Streams the original video to the worker that holds the claim. `409 not_claimed` / `409 lease_lost` as for the video routes.

### POST /api/anonymizer/frames/:id/heartbeat
"Still working": pushes the lease out. `200 { ok: true, leaseSeconds }`.

### PUT /api/anonymizer/frames/:id/image/:frame
Body: one anonymized PNG, raw bytes. Headers: `x-lease-id`, `x-sha256`, `Content-Length` (required), and `x-frame`: the image's metadata as URL-encoded JSON (`frame`, `bin`, `file`, `timestamp`, `videoTimeS`, `walkedStartM`, `walkedEndM`, `latitude`, `longitude`, `accuracyM`, `headingDeg` or `null`, `sharpness`, `lowSharpness`, `timeUncertain`, `afterGap`, `gapM` or `null`). Checked like a video result: `400 bad_checksum`, `400 bad_frame`, then `422 size_mismatch` / `422 checksum_mismatch`. Sending the same frame again replaces it. If the lease ran out meanwhile, `409 lease_lost` and the file is deleted. `200 { ok: true }`.

### POST /api/anonymizer/frames/:id/complete
Body `{ count, stepM, mode, carry }`. The job is done only if the server holds exactly `count` images (`422 incomplete` otherwise). Stores the step, the anonymization mode and the counter for the next recording. `200 { ok: true }`. Audited as `recording_frames_done`.

### POST /api/anonymizer/frames/:id/fail
Body `{ error }`. Gives the claim up; the job goes back in the queue while it has attempts left, otherwise it is `failed`. `200 { ok: true, retry }`. Audited as `recording_frames_failed`.

### GET /api/admin/recordings/:id/frames
`{ state, error, routeId, routeVersionId, assignmentId, recordingId, recordingIndex, purpose, stepM, anonymization, timeWarning, frames: [{ frame, bin, file, timestamp, videoTimeS, walkedStartM, walkedEndM, latitude, longitude, accuracyM, headingDeg, sharpness, lowSharpness, timeUncertain, afterGap, gapM, bytes, sha256 }] }`. `frames` is empty until `state` is `done`. This is the shape a scoring engine reads. `409 not_verified`.

### GET /api/admin/recordings/:id/frames/:frame
One image (`image/png`). `404` for an unknown frame. Not audited: a page of thumbnails would write one row per image.

### GET /api/admin/recordings/:id/frames.zip
A folder with `frames.json`, `manifest.csv` and `images/`. `409 no_frames` until the images are done. Audited as `frames_downloaded`.

### GET /api/admin/assignments/:id/frames.zip
`route.json` (the route version's geometry) and `assignment-<id>/` with `assignment.json` (every recording: start, stop reason, state, image count, step, time warning) and one `recording-<n>-<id>/` folder per recording that has images. `409 no_frames`. Audited as `frames_downloaded`.

### POST /api/admin/assignments/:id/frames/rerun
Deletes the images of every built recording of the assignment and queues them again, in order, with the current `SAMPLE_STEP_M`. `200 { ok: true, queued, stepM }`. `409 nothing_to_queue` / `409 frames_disabled`. Audited per recording as `recording_frames_requeued`.

### GET /api/admin/routes/:id/frames.zip
Every assignment of the route that has images, grouped by route version: `index.json`, then `v<version>/route.json` and `v<version>/assignment-<id>/…`. `409 no_frames`. Audited as `frames_downloaded`.

### GET /api/me/recordings/:id/frames
For a worker's own recording in a **training** assignment: `{ state, count, stepM, frames: [{ frame, file, bytes }] }`. No GPS. For an inference assignment, or anyone else's recording: `404`.

### GET /api/me/recordings/:id/frames.zip
The images only, in one folder: no GPS, no IDs, no metadata files. Same rules as above; `409 no_frames` until they are done. Audited as `frames_downloaded` (`by: worker`).

### GET /api/me/assignments/:id/frames.zip
All images of a worker's own **training** assignment in one folder, named `01-…`, `02-…` by recording so they sort in walking order. `404` for an inference assignment or someone else's; `409 no_frames`.

## Error codes

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `invalid_input` | body or query failed validation (`message` lists the fields) |
| 400 | `invalid_json` | body is not valid JSON |
| 400 | `bad_seq`, `empty_chunk` | chunk upload problems |
| 400 | `bad_segment`, `empty_route`, `no_required_segment` | route cannot be published, or a segment is bad |
| 400 | `required_segment` | tried to skip a required segment |
| 400 | `wrong_password`, `same_password` | admin password change |
| 400 | `dev_tools_off` | simulated recording sent while dev tools are off |
| 400 | `bad_variant` | `?variant=` is neither `original` nor `anonymized` |
| 400 | `bad_frame` | the anonymizer worker's image metadata (`x-frame`) is not valid, or does not match the frame number in the path |
| 400 | `bad_lease`, `bad_checksum`, `bad_mode` | the anonymizer worker sent a missing or malformed lease, `x-sha256` or `x-anon-mode` |
| 401 | `unauthenticated`, `invalid_credentials` | no or bad login |
| 401 | `bad_token` | the anonymizer worker's bearer token is wrong |
| 403 | `forbidden` | wrong role |
| 403 | `bad_origin` | CSRF origin check failed |
| 404 | `not_found` | unknown id, or not yours |
| 409 | `conflict`, `rule_violation` | a database rule refused the change (unique, immutable, check) |
| 409 | `not_a_draft`, `draft_exists`, `not_published` | route version state |
| 409 | `already_started`, `completed`, `not_in_review` | assignment state |
| 409 | `worker_inactive` | assigning to a deactivated worker |
| 409 | `seq_conflict`, `already_verified`, `has_chunks`, `manifest_mismatch` | recording upload state |
| 409 | `not_verified`, `not_ready`, `cannot_reassemble`, `nothing_to_export` | video or export not available |
| 409 | `no_frames`, `nothing_to_queue`, `frames_disabled` | there are no still images to download yet; no built recording to make them from; or `FRAMES_ENABLED` is off |
| 409 | `not_anonymized`, `cannot_reanonymize` | the anonymized copy is not ready; or it cannot be queued again |
| 409 | `not_claimed`, `lease_lost` | the anonymizer worker does not hold the claim (nobody does, or it ran out or belongs to another worker) |
| 411 | `length_required` | the anonymizer result was sent without a `Content-Length` |
| 413 | `too_large` | body over the size limit (JSON 2 MB, chunk 32 MiB) |
| 415 | `json_required` | wrong content type |
| 422 | `incomplete` | the anonymizer worker says it sent N images but the server holds a different number |
| 422 | `checksum_mismatch`, `size_mismatch` | chunk or anonymized-result bytes do not match `x-sha256` or `Content-Length` |
| 429 | `too_many_attempts` | login lockout |
| 500 | `server_error` | a bug; check the app log |
