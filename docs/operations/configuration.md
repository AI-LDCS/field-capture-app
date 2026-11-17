# Configuration

Two kinds: **environment variables** (set per deployment) and **tuning constants** (in code, changed with a rebuild).

## Environment variables

Copy `.env.example` to `.env` and fill it in. Docker Compose reads `.env` for substitution; the host dev server (`npm run dev`) reads it with `--env-file`. Variables already present in your shell win over the file.

### Read by the app

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | required | Postgres connection string. Compose builds it for the container; for host development use the `127.0.0.1:5433` URL from `.env.example`. |
| `PORT` | `3100` | Port the app listens on. |
| `HOST` | `0.0.0.0` | Address the app binds to. |
| `PUBLIC_ORIGINS` | none | Comma-separated browser origins (for example `https://host.tailnet.ts.net`) allowed to make state-changing requests. **Must match what the browser's address bar shows**, or every POST answers `403 bad_origin`. |
| `COOKIE_SECURE` | `true` | `true` uses the `Secure` `__Host-sid` cookie (HTTPS). `false` only for plain-http local development. |
| `TRUST_PROXY` | `1` | Number of proxy hops in front of the app (Caddy = 1). |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | none | The first admin, created only if no admin exists yet. Password at least 12 characters. |
| `S3_ENDPOINT` | `http://127.0.0.1:9000` | Object storage endpoint. In compose the app uses `http://rustfs:9000`. |
| `S3_REGION` | `us-east-1` | Region sent to the S3 client (RustFS does not care). |
| `S3_ACCESS_KEY`, `S3_SECRET_KEY` | required | Storage credentials. The same values configure RustFS. |
| `S3_BUCKET` | `recordings` | Bucket name; created at start-up if missing. |
| `ENABLE_DEV_TOOLS` | `false` | Fake GPS and canvas camera on the worker page. Development only. |
| `ASSEMBLY_CONCURRENCY` | `3` | How many finished videos the server builds at the same time. Each build needs about twice its recording's size in temporary disk space. |
| `REMUX` | `true` | Rewrite finished videos with ffmpeg for duration and seeking. Falls back to the plain file if ffmpeg is missing or fails. |
| `ANONYMIZER_TOKEN` | empty | The password the anonymizer worker (the GPU machine) sends as `Authorization: Bearer ...`. At least 32 characters or the app refuses to start. **Empty switches `/api/anonymizer` off** (it answers `404`); recordings are still queued and wait. `npm run init:env` generates one. See [anonymizer](anonymizer.md). |
| `ANON_LEASE_MINUTES` | `15` | How long a claimed recording stays reserved for a worker that has gone quiet. The worker's heartbeat keeps extending it, so this is "how long until a crashed worker's job is given to someone else", not the length of a job. |
| `SESSION_ABSOLUTE_HOURS` | `336` | Maximum session age (14 days). |
| `SESSION_IDLE_HOURS` | `24` | Sign out after this long without a request. |

### Read by Docker Compose only

| Variable | Meaning |
| --- | --- |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | The database the `db` container creates. |
| `TAILNET_HOST` | The machine's Tailscale DNS name (`tailscale status` shows it); used for the certificate file names and the Caddy site. |
| `TAILNET_HTTPS_PORT` | Host port for the tailnet profile (default `443`; if you change it, `PUBLIC_ORIGINS` must include the port). |
| `IMAGE_TAG` | Which published images to pull: `latest` (default), or `sha-<commit>` to pin or go back. See [Deployment](deployment.md#updating). |
| `DOMAIN` | Public hostname for the `public` profile; Caddy gets a Let's Encrypt certificate for it. |

### Compose profiles

| Profile | Starts | Use |
| --- | --- | --- |
| *(none)* | `db`, `rustfs`, `app` | nothing is reachable from outside; add an edge profile |
| `tailnet` | + `caddy-tailnet` | HTTPS on your tailnet using certificate files in `./certs` |
| `public` | + `caddy-public` | HTTPS on a public hostname with automatic certificates, ports 80/443 |

`docker-compose.dev.yml` is an override for laptops: it publishes the database (`5433`), storage (`9000`) and app (`3100`) on `127.0.0.1` only and turns dev tools on. Never use it on a server.

## Tuning constants

In `shared/config.ts` (shared by the phone and the server, so they cannot disagree). Starting values, not guarantees; change them, rebuild, and re-test.

| Group | Constant | Value | Effect |
| --- | --- | --- | --- |
| `preflight` | `maxDurationMs` | 90 000 | when the **Skip GPS check** button appears |
| | `targetAccuracyM` | 15 | every fix in the window must be at least this accurate |
| | `windowMs` | 12 000 | length of the stability window |
| | `minSamples` | 5 | fewest distinct fixes in the window |
| | `maxSpreadM` | 8 | largest allowed distance from the window's average position |
| `coverage` | `bufferM` | 25 | how far beside a segment a GPS point may be and still count as on it |
| | `reachM` | 5 | how far along the segment, either side, a single GPS point covers |
| | `stepM` | 5 | spacing of the samples along a segment |
| | `defaultMinRatio` | 0.9 | default share of a segment that must be covered |
| | `maxAccuracyM` | 50 | fixes worse than this are kept and flagged but not counted |
| `quality` | `gapMs` | 10 000 | silence between fixes that counts as a gap |
| | `jumpSpeedMps` | 15 | implied speed that counts as a jump |
| | `offRouteM` | 50 | distance from every segment that counts as off route |
| | `reviewBadRatio` | 0.2 | share of poor or off-route points that sends it to review |
| | `reviewMaxGaps` | 3 | more gaps than this sends it to review |
| `recording` | `timesliceMs` | 2000 | chunk length |
| | `videoBitsPerSecond` | 4 000 000 | video bitrate |
| | `idealWidth`, `idealHeight` | 1920, 1080 | requested resolution |
| | `minFreeBytes` | 500 MB | needed to start a recording (the button stays off below it); the recording screen warns below it |
| | `stopFreeBytes` | 200 MB | below this a recording stops cleanly |
| `upload` | `retryIntervalMs` | 3000 | how often the phone tries to upload |
| | `gpsBatchSize` | 200 | GPS points per request |

Other fixed limits, in `server/config.ts` and the route files: login lockout (5 per username, 20 per IP, 15 minutes), password lengths (worker 8, admin 12, maximum 128), chunk size (32 MiB), chunks per recording (100 000), GPS batch (1000), assembly part size (8 MiB), anonymizer claims per recording (3, then it is `failed`), the lease sweep (every 60 s), and the part size of the anonymized upload (8 MiB).

### Choosing values

- **Video size**: 4 Mbps is about 30 MB per minute. A 25-minute walk is roughly 750 MB on the phone until uploaded, then the same on the server. Lower `videoBitsPerSecond` and the resolution to save space and bandwidth.
- **Chunk length**: shorter chunks lose less in a crash (up to one chunk) but mean more, smaller requests.
- **GPS thresholds**: real phones settle at 2 to 5 m outdoors with a clear sky; 15 m is lenient. Drop `maxSpreadM` only after watching real data.
