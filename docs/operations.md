# Operations

Day-to-day running: health, logs, backups, recovery and fixes. Commands assume you are in the project folder, with `.env` present, and that you use the same `--profile` you started with.

- [Health and logs](#health-and-logs)
- [Backup and restore](#backup-and-restore)
- [Looking at the data](#looking-at-the-data)
- [Troubleshooting](#troubleshooting)
- [Recovering the admin account](#recovering-the-admin-account)
- [Resetting a development environment](#resetting-a-development-environment)
- [Known gaps](#known-gaps)

## Health and logs

```bash
docker compose ps                         # all services should be Up; db shows (healthy)
curl -s https://<host>/healthz            # {"ok":true} (also checks the database)
docker compose logs -f app                # application log
docker compose logs --tail 100 caddy-public   # or caddy-tailnet: TLS and proxy errors
```

The app log shows migrations, bucket creation and errors (`500`s are logged with the stack). There is no separate monitoring yet: see [known gaps](#known-gaps).

In the web app, an admin sees each assignment's audit trail on its review page, and a video that failed to build shows **video build failed** with a **Retry** button.

## Backup and restore

What to back up: the **database** (everything except video) and the **RustFS volume** (all video). The `.env` file and, for the tailnet profile, `certs/` are also needed to bring the stack back; keep them in a private place.

### Database

```bash
docker compose exec -T db pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" > db-$(date +%F).dump
```

(Load the variables first with `set -a; . ./.env; set +a`.) The custom format is compressed and includes the PostGIS data.

### Video

```bash
docker run --rm -v field-capture_rustfs-data:/data:ro -v "$PWD":/backup alpine \
  tar czf /backup/rustfs-$(date +%F).tgz -C /data .
```

For a copy that is consistent with the database, stop writes first: `docker compose stop app rustfs`, run the archive, then `docker compose start rustfs app`. A copy taken while uploads are running may miss the newest objects.

Copy both files off the server. A backup that lives only on the same disk is not a backup.

### Restore

Restore into an **empty** database. Stop the app first.

```bash
docker compose stop app
docker compose exec -T db psql -U "$POSTGRES_USER" -d postgres \
  -c "DROP DATABASE IF EXISTS \"$POSTGRES_DB\"" -c "CREATE DATABASE \"$POSTGRES_DB\""
docker compose exec -T db pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner < db-YYYY-MM-DD.dump
# video: put the archive back into an empty volume
docker compose stop rustfs
docker run --rm -v field-capture_rustfs-data:/data -v "$PWD":/backup alpine \
  sh -c "rm -rf /data/* /data/.[!.]* ; tar xzf /backup/rustfs-YYYY-MM-DD.tgz -C /data"
docker compose start rustfs app
```

What was checked: a dump of the running database restored into a scratch database with identical row counts (users, recordings, GPS points) and PostGIS working, and the RustFS archive extracted into a fresh volume with the same number of files as the source. A full restore into a replacement server, with the app reading the restored video, has **not** been rehearsed here: do a trial restore on a spare machine before you rely on it.

Run backups on a schedule (cron) and delete old ones on a rule you choose.

## Looking at the data

Run SQL with:

```bash
docker compose exec db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
```

Useful queries:

```sql
-- how much video is stored, per worker
SELECT u.username, count(*) AS recordings, pg_size_pretty(sum(r.file_bytes)) AS size
  FROM recordings r JOIN users u ON u.id = r.user_id
 WHERE r.assembly_state = 'done' GROUP BY u.username ORDER BY sum(r.file_bytes) DESC;

-- videos that failed to build
SELECT id, assembly_error, verified_at FROM recordings WHERE assembly_state = 'failed';

-- recordings registered but never finished (the phone may still hold them)
SELECT id, user_id, created_at FROM recordings
 WHERE status = 'open' AND created_at < now() - interval '1 day';

-- assignments waiting for an admin
SELECT a.id, u.username, a.review_reasons FROM assignments a JOIN users u ON u.id = a.user_id
 WHERE a.status = 'needs_review';

-- recent audit trail
SELECT at, action, target_type, details FROM audit_log ORDER BY id DESC LIMIT 50;
```

Do not edit rows of published versions or verified recordings by hand: database triggers refuse it on purpose.

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| Camera or GPS prompt never appears; "camera unavailable" | The page is not on HTTPS. Use the tailnet or public profile (or `localhost` on the same machine). |
| Every save answers `403 bad_origin` | `PUBLIC_ORIGINS` does not match the address in the browser (scheme, host and port). Fix `.env`, `docker compose up -d`. |
| You sign in but are immediately signed out | `COOKIE_SECURE=true` on a plain-http address (the `__Host-` cookie needs HTTPS), or `TRUST_PROXY` wrong behind a proxy. |
| `429 too many attempts` for a worker who is not an attacker | 5 wrong passwords in 15 minutes. Wait, or clear: `DELETE FROM login_attempts WHERE username = '<name>';` |
| Map shows "Access blocked" | The free tile server rejected the request or usage. Check the app's `Referrer-Policy` is unchanged; for real use, switch to a tile provider with an account. |
| A worker's page says "server unreachable, showing the saved copy" | They are offline or the app is down. Data on the phone is safe and uploads when the connection returns. |
| A recording shows **upload interrupted** on the phone | Network or server error; the phone retries every 3 seconds. The last error is shown. It is not lost. |
| Video in review says **preparing video** for a long time | The build job is working or stuck. Check `docker compose logs app`; a failure shows **video build failed** with a Retry button. |
| Video will not seek, or has no length | The ffmpeg remux did not run (`REMUX=false`, or it failed and the plain file was used). Check the logs for the build. |
| `docker compose up` fails with "port is already allocated" | Another process uses the port (8444 for the tailnet profile, 80/443 for public). Stop it or change `TAILNET_HTTPS_PORT`. |
| App exits at start with a missing `S3_*` or `DATABASE_URL` error | The variable is not in `.env`. Both S3 keys and the database URL are required. |
| Tailnet HTTPS stops working after ~3 months | The Tailscale certificate expired. Renew it ([deployment](deployment.md#first-start-tailnet)). |
| Browser on a worker's phone keeps old behaviour after an update | Reload the page; the app has no service worker caching it. |

## Recovering the admin account

Bootstrap never overwrites an existing admin, so a forgotten admin password is reset directly in the database. Make a hash with the app's own parameters, then store it:

```bash
docker compose exec -T app node -e "
import('argon2').then(async (a) => {
  console.log(await a.hash(process.argv[1], { type: a.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }));
});" 'a-new-long-password-here'
```

```sql
UPDATE users SET password_hash = '<paste the hash>', password_changed_at = now() WHERE username = 'admin';
DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = 'admin');
```

Choose at least 12 characters. A password typed on the command line is saved in your shell history: start the command with a space (most shells then skip it) or clear the history entry afterwards. The hash command was run exactly as written and its output verified by the app's own check.

## Resetting a development environment

```bash
docker compose down -v     # DELETES the database and all video in this project's volumes
docker compose up -d       # starts clean; the first admin is created again from .env
```

## Known gaps

- No automatic monitoring or alerts (failed builds, a full disk, uploads stuck for days). Look at the queries above, or see the [roadmap](roadmap.md).
- No Docker health check on the `app` service; `/healthz` exists for an external check.
- No automatic cleanup of unfinished recordings or orphan chunk objects (a rare race between two uploads of the same chunk can leave one unused object).
- No admin screen to delete a recording or an assignment, and no automatic retention. Videos are kept until deleted.
- No global audit screen, no storage usage page.
- Backups are manual until you schedule them.
