# Testing

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d db rustfs   # API tests use the real database and object storage
npm test               # all tests, then the endpoint check
npm run test:unit      # pure logic only: no database or storage needed
npm run test:coverage  # all tests with a line/branch coverage table
npm run typecheck      # TypeScript, no emit
npm run check          # Biome: lint and formatting, changes nothing
npm run format         # Biome: apply the formatting
```

The tool is Node's built-in test runner (`node:test`) run through `tsx`; there is no separate framework. `.env` supplies the database and storage credentials (loaded with `--env-file`).

## What the tests are

| File | Kind | Covers |
| --- | --- | --- |
| `test/integration/api.test.ts` | API, real Postgres | login, lockout, cookies, sessions, worker lifecycle, roles, ownership, CSRF, route versions and immutability, assignments, curved segments, audit |
| `test/integration/recordings.test.ts` | API, real Postgres + RustFS | ownership of recordings, chunk upload rules, finalize and assembly, range playback, completion decisions, review, export |
| `test/integration/endpoints.test.ts` | API, real Postgres + RustFS | every endpoint's success and refusal cases, a bad-input sweep over all bodies, a no-login/wrong-role sweep over all routes |
| `test/unit/geo.test.ts` | unit | distances, coverage, bearings, direction arrows, GPS quality flags and review thresholds |
| `test/unit/preflight.test.ts` | unit | the GPS-check rules |
| `test/unit/curve.test.ts` | unit | curve smoothing |
| `test/unit/editor.test.ts` | unit | the route editor's edit model: reorder, split, join, snap, parse coordinates, undo/redo |
| `test/repo/docs.test.ts` | repo | the docs list every endpoint and environment variable, and their links and file paths resolve |
| `test/repo/structure.test.ts` | repo | the layout rules in [architecture](architecture.md#layout-rules) hold |
| `test/integration/check-endpoints.ts` | check (runs after the tests) | every endpoint answered with a 2xx in some test |

### Isolation

Each API test file starts its own server in-process against a **new database** (`fieldapp_test_<pid>`, created and dropped per file) and a **new bucket** (`test-<pid>-<time>`), both removed at the end. The tests never touch your development data. Files run one at a time (`--test-concurrency=1`). Shared setup is in `test/integration/helpers.ts` (a tiny cookie-keeping HTTP client, worker/route/assignment builders).

## The endpoint check

"Every API endpoint is tested" is enforced, not claimed:

1. `server/app.ts` keeps one table of routers and mount paths (`MOUNTS`); `listEndpoints()` turns it into the full list (including `/healthz`).
2. While tests run, the test server records which route answered each request and its status (`createApp({ onHit })`), one file per test process in `.test-hits/`.
3. After the tests, `test/integration/check-endpoints.ts` compares the two. **Any endpoint that never answered with a 2xx fails the whole run.** It also lists endpoints that were never exercised with a refusal (read-only routes such as lists, where the only possible refusal is a login failure that is checked separately by the sweeps).

So adding a route without a test makes `npm test` fail and names the route. CI runs it on every push.

## CI

`.github/workflows/ci.yml` runs on every push to any branch, on GitHub Actions:

| Job | Runs |
| --- | --- |
| Static checks | Biome lint and formatting, TypeScript, ShellCheck on `scripts/`, `npm audit` (fails on high or critical, production dependencies only), `npm run build`, and the unit tests |
| Full tests | `npm test` against the real Postgres and RustFS from `docker-compose.yml`, with `.env.example` as its settings |
| Docker images | builds the app and database images for `linux/amd64` and `linux/arm64`, after the tests pass. On `main` it also pushes them to GHCR |
| Published images | on `main` only: logs in, pulls the pushed images by commit on `amd64`, as a server would, and starts them |

### Lint rules

`biome.json` uses Biome's recommended rules, and any error fails CI. These are the exceptions:

- **Warnings, so they stay visible without failing CI:** React hook dependency lists (some are deliberate, and adding a dependency can restart the camera or GPS), list keys that use an index, and five accessibility rules. They are worth working through, but each one changes behaviour and needs testing on its own.
- **Off:** `useButtonType` (forms here rely on the default submit button), `useIterableCallbackReturn` (`list.forEach((f) => f())` is harmless) and `noNonNullAssertion` (`req.user!` after `requireAuth` is safe).

## Coverage

`npm run test:coverage` prints a table for `server/`, `shared/` and `web/src/admin/editor/` using Node's built-in coverage. At the time of writing: about **97% of lines and 90% of branches**. Files that no test loads never appear in such a table, so read it together with the list below.

## Not covered by automated tests

- The **phone-side code** (`web/src/worker/*`: recorder, uploader, local database, recovery, camera and GPS wrappers). Only the write-retry and error-text helper (`retry.ts`) has automated tests. The rest was exercised by hand in a desktop browser with the dev tools (fake GPS and camera), including crash recovery, offline resume, a lost session mid-recording and two users on one browser. The owner has also used it on phones in normal use; long walks, low storage and a poor network have not been tried.
- The **React screens** (login, editor, review, worker pages).
- `server/index.ts` (start-up wiring) beyond what the tests import.

The next most valuable addition is tests for the uploader and recovery logic against a fake IndexedDB, because the two bugs found while hand-testing the phone code were in that area.

## Writing and trusting tests

- Put a new API test next to its area; use the helpers in `test/integration/helpers.ts`. Assert the **refusal** as well as the success (wrong user, wrong state, bad input).
- Prefer testing a rule at the lowest level that enforces it. The immutability rules, for example, are tested with raw SQL against the triggers, not only through the API.
- **Check that a test can fail.** The practice used in this project: after writing tests, break the code on purpose (remove an ownership filter, skip a hash check, drop a session delete) and confirm a test fails, then put the code back. Tests that stay green when the rule is broken prove nothing. This found real gaps more than once (for example a deactivation test that passed even if sessions were not deleted, because the user was also checked as inactive).
- Test passwords in the test files are throw-away values for throw-away databases.
