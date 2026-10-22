# Field flow

What happens from the moment a worker opens an assignment to the moment the server calls it complete, and what protects the data on the way. Numbers come from `shared/config.ts` and are starting values, not guarantees (see [configuration](configuration.md#tuning-constants)).

- [Worker steps](#worker-steps)
- [GPS check](#gps-check)
- [Camera and storage check](#camera-and-storage-check)
- [Recording](#recording)
- [What is stored on the phone](#what-is-stored-on-the-phone)
- [Recovery after a crash](#recovery-after-a-crash)
- [Upload protocol](#upload-protocol)
- [When the session ends mid-recording](#when-the-session-ends-mid-recording)
- [Video assembly on the server](#video-assembly-on-the-server)
- [How the server decides](#how-the-server-decides)
- [Coverage](#coverage)
- [Curved segments](#curved-segments)
- [The recording screen](#the-recording-screen)
- [Dev tools](#dev-tools)
- [Limits of a browser](#limits-of-a-browser)

## Worker steps

1. **Log in** and open an assignment (a published route version given to this worker).
2. **GPS check**: wait for stable, accurate GPS (or skip after a timeout; the skip is recorded).
3. **Camera and storage check**.
4. **Record**: walk the route; video and GPS are saved on the phone as they arrive and upload in the background.
5. **Skip** optional segments if needed. Required segments cannot be skipped.
6. **Finish**: the server checks everything and decides the assignment's status.

## GPS check

Browsers cannot calibrate GPS hardware; the check only tests whether the readings are good enough to start. It runs after a tap (so the permission prompt is allowed on iOS), using `watchPosition` with high accuracy and `maximumAge: 0`.

Twice a second it looks at the fixes of the last **12 seconds** (`shared/preflight.ts`). It passes only when **all** hold:

| Test | Value |
| --- | --- |
| enough fixes, each with its own timestamp | at least **5** |
| they cover most of the window | span at least 70% of 12 s (about 8.4 s) |
| accuracy of **every** fix in the window | at most **15 m** |
| they sit together | no fix farther than **8 m** from the window's average position |

One good reading is never enough, and a bad fix keeps blocking until it leaves the window. The worker should stand still: walking breaks the "sit together" test.

After **90 seconds** without a pass, a **Skip GPS check** button appears. The outcome (`passed` or `skipped`, duration, samples, best accuracy, last reason) is sent to the server and written to the audit log. A skipped check does not block recording, but the finished assignment goes to **review**.

## Camera and storage check

- `getUserMedia` asks for the rear camera (`facingMode: { ideal: "environment" }`), ideal 1920×1080, no audio. If the browser does not report the rear camera (normal on a laptop) the screen warns but allows it.
- It reads `navigator.storage.estimate()` and asks for persistent storage (`navigator.storage.persist()`). Neither is a guarantee: a browser can still evict data under pressure. The screen warns when less than **500 MB** is free; it does not block starting.

## Recording

Implemented in `web/src/worker/recorder.ts`.

- **One `MediaRecorder` per recording**, started with `start(2000)`: a chunk about every **2 seconds**. Video bitrate 4 Mbps, so roughly 1 MB per chunk and 30 MB per minute. Codec preference: WebM VP9, VP8, plain WebM, then MP4 (H.264). The real `mimeType` the browser chose is stored on the recording.
- **Chunk numbering is fixed at the moment the chunk arrives**, before any asynchronous work, so order can never change. Each chunk is hashed (SHA-256) and written to IndexedDB through a serial queue. A chunk counts as **committed only after its IndexedDB transaction completes**.
- **GPS** comes from `watchPosition` (high accuracy, `maximumAge: 0`) and is saved the same way: timestamp, latitude, longitude, reported accuracy. GPS has its own write queue so a large video write never delays it.
- **`startedAt` is set when the recorder's `start` event fires** (video t = 0), not when the button was tapped, so video time and GPS time line up for review.
- **Screen wake lock** is requested so the screen does not sleep during a long walk.
- **Recording stops when the page becomes hidden** (app switch, screen lock). Background recording is not supported by browsers; the stop reason is saved.
- **Storage guard**: every 10 s the free space is checked; below 100 MB the recording stops cleanly. A failed IndexedDB write also stops it (`storage error`) instead of silently losing data.
- While recording, the recording tab holds a **Web Lock** named `fc-rec-<id>`. It is released on stop, or by the browser if the page dies. Another tab's start-up scan uses it to tell a live recording from a dead one.
- A single continuous recording may cover several segments; there is no per-segment video file. Which part of the video belongs to which segment comes from GPS timestamps and is stored as [evidence](data-model.md#work).

## What is stored on the phone

`web/src/worker/localdb.ts`. **One IndexedDB database per signed-in user**, named `field-capture-<userId>`, so another worker on the same phone can never see, upload or delete it. Nothing is ever purged for another user.

| Store | Key | Holds |
| --- | --- | --- |
| `recordings` | `id` | metadata: assignment, mime, `simulated`, status, `startedAt`, `endedAt`, `stopReason`, `lastError`, `serverRegistered` |
| `chunks` | `[recordingId, seq]` | the video `Blob`, `size`, commit time, `sha256`, `uploaded` (confirmed by the server) |
| `gps` | `[recordingId, seq]` | `t`, `lat`, `lng`, `acc`, `uploaded` |
| `assignments` | `id` | the last copy of the assignment received, so the page still opens briefly offline |

"Locally committed" and "confirmed by the server" are separate flags, on purpose.

Phone recording status: `recording` → (`interrupted` if cut off) → `pending_upload` → `uploading` ⇄ `upload_interrupted` → `server_verified`.

Small UI preferences use `localStorage`. Application files are **not** cached for offline use (no service worker yet), so the app needs a connection to load.

## Recovery after a crash

A refresh, closed tab, browser restart or crash can kill a recording. The saved chunks survive; the `MediaRecorder` does not (a new one writes a new init segment, so it can never continue the old file).

1. At sign-in the app scans the user's database. Any recording still marked `recording` (and whose Web Lock is not held by another live tab) becomes `interrupted`, with `endedAt` set to its last saved chunk or GPS time.
2. The assignment page shows **Recovery needed** and **blocks Start recording** until each interrupted recording is finalized, so duplicate work cannot begin by accident.
3. **Finalize & upload** marks it `pending_upload`; the normal upload path sends it.

Data that had not been committed when the browser died is lost: at most the last few seconds. Recovery is limited to what was persisted.

## Upload protocol

`web/src/worker/uploader.ts` and `server/routes/recordings.ts`. The goals: never lose data, never trust one HTTP success as proof, resend only what the server lacks, and delete the phone's copy only after the server has verified it.

A tick runs every **3 seconds**, when the browser fires `online`, and after "Upload now". Per recording it does:

1. **Register** `POST /api/me/recordings` (idempotent; only for the worker's own assignment).
2. If the recording ended and has no chunks, drop it (`DELETE`), so an empty recording never blocks the assignment.
3. **Ask** `GET .../status`: the server answers with the chunk and GPS sequence numbers it already holds. The phone marks those as uploaded.
4. **Chunks**: `PUT .../chunks/:seq` for each missing one, body = the raw bytes, header `x-sha256`. The server hashes the body itself and answers `422` on a mismatch. The same bytes for the same `seq` are a harmless duplicate (`200`); different bytes for a stored `seq` are `409`.
5. **GPS** in batches of 200 points (`POST .../gps`, idempotent).
6. **Finalize** only when the recording has ended and everything is confirmed: `POST .../finalize` with a **manifest** (every `seq` and hash, and the GPS count). The server checks it against what it holds. On a mismatch it answers `409` listing missing and mismatched chunks; the phone forgets its "uploaded" flags for those and resends.
7. On success the recording is `server_verified` and the **phone deletes its local chunks and GPS**. Until then nothing is deleted.

Uploads happen while still recording (progressive). Failures are retried on the next tick; a recording that has ended and failed shows `upload_interrupted` with the last error. Chunks are content-addressed in storage (`rec/<id>/c/<seq>-<sha256>`), so retries and races cannot corrupt data.

## When the session ends mid-recording

If the session dies while recording (a password reset, a deactivation, expiry):

- A 401 only counts after `GET /api/auth/me` confirms the session is really gone (a stale in-flight request must not flip the screen after a fresh login).
- The recording **keeps going** and keeps saving locally. A banner asks the same worker to sign in again; uploads pause (`signed out: uploads paused`), nothing is lost.
- After signing in again as the **same user**, uploads resume. A different user is refused. When the recording ends with the session still gone, the login screen appears.
- **Sign out** with unsent data asks for confirmation: the data stays on that phone, under that user, and uploads when they sign in again. Signing out while recording is refused.

## Video assembly on the server

Finalize is cheap (it only checks the manifest). The playable file is built afterwards by a background job (`server/assemble.ts`):

1. The recording is marked `assembly_state = pending`. The job claims one at a time (`FOR UPDATE SKIP LOCKED`), so a retried finalize cannot start a second build. On start-up anything left `running` by a crash goes back to `pending`.
2. It reads every chunk from storage in order, **re-checks each against its recorded hash**, and writes one file in a temporary directory.
3. If ffmpeg is available and `REMUX` is on, it rewrites the file with `-c copy` (no re-encoding; `-movflags +faststart` for MP4). `MediaRecorder` files have no duration and no seek index; without this step browsers cannot seek and may not show the length. If ffmpeg fails, the plain concatenation is used.
4. It uploads the result as one object using multipart upload in **8 MiB** parts (parts must be at least 5 MiB, so 1 MB chunks cannot be copied directly), hashing as it goes, and stores the size and SHA-256.
5. **Only then** it deletes the chunk objects (so "keep forever" does not mean double storage) and sets `chunks_purged`.
6. On any error the state is `failed` with the message, an audit entry is written, and an admin can press **Retry** (`POST /api/admin/recordings/:id/reassemble`). The chunks are kept until a build succeeds.

Disk needs while building: about **two times the recording size** in the container's temporary directory (the raw file and the remuxed file). A 25-minute recording at 4 Mbps is roughly 750 MB.

## How the server decides

`server/evaluate.ts`. The phone never decides completion and nothing the phone says about coverage is trusted: the server recomputes everything from the GPS it holds for **verified** recordings, on each finalize, un-skip, finish and re-evaluate.

When the worker finishes (or an admin re-evaluates) the first matching row wins:

| Condition | Status | Reason shown |
| --- | --- | --- |
| no recordings at all | `in_progress` | no recordings uploaded yet |
| a recording is not yet verified | `pending_sync` | N recording(s) not yet verified by the server |
| a required segment is below its minimum coverage | `in_progress` | required segment N: covered X%, needs Y% |
| all required segments covered, **and** any flag below | `needs_review` | one reason per flag |
| all required segments covered, no flags | `completed` | none |

Review flags: the GPS check was skipped; more than 20% of GPS points have poor accuracy; more than 20% are off route; more than 3 gaps; the assignment includes simulated (test) data.

**Quality is tracked separately from coverage**: a completed route does not imply good GPS. Points are flagged, never discarded.

| Quality flag | Rule |
| --- | --- |
| poor accuracy | reported accuracy above 50 m |
| off route | more than 50 m from every segment |
| gap | more than 10 s between consecutive points in one recording |
| jump | implied speed above 15 m/s between consecutive points |

Jumps and gaps are measured inside one recording, never between two. An admin can **approve** or **send back** a `needs_review` assignment; a completed assignment accepts no new recordings.

## Coverage

`shared/geo.ts` (`coverageMask`, `segmentCoverage`). The same code runs on the phone (to draw progress) and on the server (to decide).

1. The segment's stored line is sampled into points about 5 m apart (a denser line, such as a curve, keeps its own denser points).
2. A sample is **covered** if a usable GPS point lies within **25 m** of it. Points with reported accuracy worse than 50 m are ignored for coverage (but stored and flagged).
3. **Coverage = covered samples ÷ all samples.** A segment is `completed` at its `minCoverageRatio` (default 0.9).

So 90% means the walked track covers at least 90% of the segment, not that the last GPS point reached the end. Timestamps correlate video and GPS but do not prove the route was followed; coverage comes from positions.

## Curved segments

Sidewalks bend, so a segment can be **curved**: the admin places points along the sidewalk and the server draws a smooth line through every one (centripetal Catmull-Rom, `shared/curve.ts`, one point about every 2 m). The editor preview and the server run the same function, so they agree. The server stores both the curve (`geom`, used for coverage and what the worker walks) and the original points (`control`, so it can be edited later).

This is smoothing only. It does not know where a sidewalk really is: a bad point gives a bad line. A coverage test confirms that walking the curve completes a segment while walking the straight chord between its ends does not.

## The recording screen

While recording, the page becomes a full-screen split: the **map** on top and the **live camera** below, with a draggable divider (position remembered; a swap button flips them). The map shows the worker's position and accuracy, their trail, and each segment coloured by progress. A hint bar shows an arrow and distance to the **nearest uncovered part of the first unfinished segment** and how many metres of it are left, plus warnings (off route, weak GPS). An optional segment can be skipped from the hint bar. Stop needs two taps within three seconds so a stray tap does not end the recording.

## Dev tools

Fake GPS (walks the route, starts inaccurate, can simulate an inaccurate start) and a canvas camera, so the whole flow can be tested on a laptop. They exist only when the server runs with `ENABLE_DEV_TOOLS=true` (set in `docker-compose.dev.yml` and `npm run dev`, never in the production compose file). Recordings made with them are stored with `simulated = true`, always go to review, and are labelled in the review page. A server with dev tools off rejects `simulated: true` (`400 dev_tools_off`).

## Limits of a browser

- No background recording: switching apps or locking the screen stops it.
- Local data is not a strong security boundary against someone who controls the device and knows how to read IndexedDB. A web app cannot guarantee a worker never extracts a video. The app keeps recordings in application storage, offers no download to workers, and never returns video bytes to them; for a strict guarantee, use managed devices or a native app. See [security](security.md#what-is-not-protected).
- Storage quota varies by browser and device and can be cleared by the user.
- Browsers differ (codec, how long a screen lock lets a page live, storage limits). The phone code was used by the owner on phones in normal use but is not covered by automated tests and has not been stress-tested; see the [roadmap](roadmap.md#known-limits).
