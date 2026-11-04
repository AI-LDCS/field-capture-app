# Database migration plan

Follow this for any change to the database: a new schema file, a Postgres upgrade, moving to another server, or restoring a backup. The commands for taking and restoring backups are in [operations](runbook.md#backup-and-restore).

| You want to | Go to |
| --- | --- |
| Change tables, columns or triggers | [Schema change](#schema-change) |
| Move to a new major Postgres version | [Major version upgrade](#major-version-upgrade) |
| Move to another server, or recover from a loss | [Restore or move](#restore-or-move) |

## Rules

1. **Back up first, and copy it off the machine.** A backup is the database dump, the RustFS volume archive, `.env` and, on the tailnet profile, `certs/`.
2. **Never run `docker compose down -v` on data you want to keep.** `-v` permanently deletes the database and every video, with no prompt. Use `docker compose down`. Check `docker volume ls` for a copy before removing any volume.
3. **Rehearse on a copy** when the change is more than adding something new.
4. **Pick a quiet time.** Check that no worker is recording, and that phones have finished uploading if you can. The app is down during a major upgrade or restore. Phones keep recordings and retry their uploads afterwards.
5. **Know how you would go back** before you start.

## Before you start

```bash
set -a; . ./.env; set +a
docker compose ps                     # db healthy, app up
docker compose logs --tail=50 app     # no errors already happening
```

Write down the row counts so you can compare afterwards:

```bash
docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
  SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM routes) AS routes,
         (SELECT count(*) FROM assignments) AS assignments, (SELECT count(*) FROM recordings) AS recordings,
         (SELECT count(*) FROM gps_points) AS gps_points, (SELECT count(*) FROM audit_log) AS audit_log"
```

## Schema change

Schema changes are SQL files in `db/migrations`. The app applies new ones in name order when it starts, each in its own transaction, and records them in `schema_migrations`. If one fails, it rolls back and the app does not start.

1. **Add a new numbered file**, for example `008_add_something.sql`. Never edit a file that has already been applied: it will not run again, and databases will differ.
2. **Prefer changes that keep old data valid.** To replace a column, add the new one and copy the data in one release, then drop the old one in a later release. Remove a table or column only when nothing reads it.
3. **Keep the guard triggers in mind.** Published route versions, verified recordings and GPS points are frozen on purpose. Loosening a guard is a decision: record it in [decisions](../development/decisions.md) and update the [data model](../reference/data-model.md).
4. **Update the docs and tests.** Add the file to the table in the [data model](../reference/data-model.md), and run `npm test`, which applies every migration to a new database.
5. **Rehearse if it changes or removes existing data.** Restore a dump into a scratch database and apply the file there.
6. **Deploy:** back up, then run `docker compose --profile tailnet up -d --build` (or your profile).
7. **Check:** the log shows `migration applied: <file>`, the counts are right, and the app works.

**Going back:** migrations only go forward. If a migration fails it has already rolled back, so fix the file or redeploy the previous code. If it applied but was wrong, write a new migration that corrects it. Restore the backup only if data was damaged, because that also loses anything recorded since the backup.

## Major version upgrade

A new major version cannot open the old version's data folder. It stops with `database files are incompatible with server`, and the app stays down until the data is moved. Video in RustFS is not affected.

Do this **while the old image is still running**, before any `docker compose up --build` or `up` after a `pull`. A `pull` alone is safe; it does not restart anything. If you have already rebuilt, go back to the previous `db/Dockerfile` and rebuild the `db` service first, so you can take the dump.

1. Update `db/Dockerfile` to the new version, including the PostGIS package names. Run `npm test` against it.
2. Rehearse with a copy of real data: restore a dump into a temporary stack on the new version, and compare the counts.
3. Follow [Before you start](#before-you-start) and take the full backup.
4. Move the data:

```bash
set -a; . ./.env; set +a
docker compose stop app
docker compose exec -T db pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" > db-before-upgrade.dump
docker compose stop db
# keep the old data folder, so you can go back
docker volume create field-capture_pgdata-old
docker run --rm -v field-capture_pgdata:/from:ro -v field-capture_pgdata-old:/to alpine cp -a /from/. /to/
docker compose rm -f db
docker volume rm field-capture_pgdata
docker compose up -d --build --wait db
docker compose exec -T db pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner < db-before-upgrade.dump
docker compose --profile tailnet up -d --build   # or your profile
```

5. Compare the counts, sign in, open an old recording and try a short new one.
6. After a few days of normal use, remove the old copy with `docker volume rm field-capture_pgdata-old`. Keep the dump somewhere private; it holds password hashes.

**Going back:** anything recorded after the upgrade is lost from the database if you go back, so decide quickly.

```bash
docker compose stop app
docker compose rm -sf db
docker volume rm field-capture_pgdata
docker volume create field-capture_pgdata
docker run --rm -v field-capture_pgdata-old:/from:ro -v field-capture_pgdata:/to alpine cp -a /from/. /to/
git checkout <previous-commit> -- db/Dockerfile
docker compose --profile tailnet up -d --build
```

## Restore or move

Use this after a loss, or to move to another server.

1. Install Docker and clone the repository at the version the backup came from.
2. Put back `.env` and `certs/`. Keep the same `POSTGRES_PASSWORD`, `S3_ACCESS_KEY` and `S3_SECRET_KEY`: the RustFS volume is tied to them.
3. Follow [Restore](runbook.md#restore) for the database and the video.
4. Compare the counts, sign in, and play an old recording.
5. A restored database and video archive should come from the same time. Recordings in the database whose video is missing cannot be played, and video with no recording is simply unused.

The [RustFS export](runbook.md#video) is for reading or handing over the files, and cannot be restored directly. Use the volume archive for restoring.

## After any change

- Say what was done and when, and note anything unexpected here or in [operations](runbook.md).
- Check that the backup schedule still works.
- Rehearse a full restore on a spare machine from time to time. A backup that has never been restored is only a hope.
