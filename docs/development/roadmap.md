# Roadmap and known limits

What is built, what is known to be missing, and what is planned next. Nothing here is a promise of a date.

## Built

- **Milestone 1**: login, admin and worker accounts, versioned routes with required and optional segments, assignments, the route editor (map, typed coordinates, drag to reorder, curves, undo), Docker Compose with Postgres/PostGIS, RustFS and Caddy.
- **Milestone 2**: the field flow (GPS check, camera check, recording with crash recovery, resumable upload through the app, server verification), the server deciding completion, video assembly, and admin review (video with map sync, jump to segment, downloads, approve/send back, audit).
- **Tests**: every endpoint has a passing test, enforced; unit tests for the GPS check, geometry, curves and the editor model; a docs test.

## Known limits

**Phone testing is light so far.** The owner has used the app on phones in normal use; the results (which phones, what worked, what did not) are not recorded here yet. Still to do: long walks, low storage, a poor network, and more phone models and browsers. The automated tests do not cover the phone code; it was also exercised in a desktop browser with fake GPS and camera.

**Browser limits** (cannot be fixed in a web app): no background recording; local data is not a strong security boundary; storage quota and eviction vary by device. See [field flow](../reference/field-flow.md#limits-of-a-browser) and [security](../reference/security.md#what-is-not-protected).

**Product gaps**

- Skipping an optional segment needs a connection (recording and upload do not).
- No service worker: the app needs a connection to load.
- No admin delete for recordings or assignments, no automatic retention or cleanup of unfinished recordings and orphan chunk objects.
- No global audit screen, no storage usage page, no dashboard of assignments needing attention.
- No password reset by email and no two-factor login (an admin resets worker passwords).
- Login is rate-limited; the rest of the API relies on authentication and size limits.
- Free OpenStreetMap, OpenTopoMap and Esri World Imagery (satellite) tile servers are used; they are not meant for production.
- Several recordings of one assignment are reviewed separately; there is no merged video.
- The route editor edits geometry only; there is no import of GPX or GeoJSON files (pasting `lat, lng` lines works).

**Operations gaps**: no automatic monitoring or alerts, no Docker health check on the app service, backups are manual. See [operations](../operations/runbook.md#known-gaps).

## Next: milestone 3 (proposed order)

1. **Record and fix what phone testing shows.** First, always. Write down the phones and browsers used and any problems found.
2. **Data lifecycle**: admin delete of a recording or assignment (audited, removes the video from storage); a storage page (space per worker and route); a cleanup job for stale unfinished recordings and orphan objects.
3. **Ready for a public server**: scheduled backups and a rehearsed restore; a production tile provider; alerts for failed builds, stuck uploads and low disk.
4. **Offline**: a service worker so the app loads without a connection; skip and un-skip queued on the phone and synced later.
5. **Admin dashboard**: assignments needing review, failed video builds, stale in-progress work; a global audit page.
6. **Hardening**: rate limits for the whole API, per-recording upload limits, a dependency audit, and one real long test (a 25-minute recording with low storage and a poor network).
7. **Tests for the phone code**: the uploader and recovery against a fake IndexedDB.

## Ideas, not planned

- Snap curves to walkable paths with a routing engine (self-hosted Valhalla with a Thailand extract was considered and set aside in favour of plain smoothing).
- Merge several recordings into one reviewable video.
- A native app, if strict control over local extraction becomes a requirement.
- Per-segment video clips cut from the continuous recording.
