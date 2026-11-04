# Deployment

Everything runs with Docker Compose. Pick an edge profile:

| Profile | For | Address | TLS certificate |
| --- | --- | --- | --- |
| `tailnet` | a laptop or server reachable over Tailscale | `https://<machine>.<tailnet>.ts.net` | files made by `tailscale cert` |
| `public` | a VPS with a public IP | `https://<your domain>` | automatic (Let's Encrypt, by Caddy) |

Browsers allow the camera and GPS only on **HTTPS** (or `localhost`), so a phone needs one of these.

## Requirements

- Docker Engine with the Compose plugin (v2).
- For `tailnet`: Tailscale on the machine, with MagicDNS and HTTPS certificates enabled for your tailnet, and on every phone that will connect.
- For `public`: a domain name pointing at the server, ports 80 and 443 reachable.
- Disk: the database is small; plan disk for **video**. At the default 4 Mbps a minute is about 30 MB, so a 25-minute walk is roughly 750 MB. While a recording is being built the server needs about the same again as temporary space inside the container. Add room for backups. (CPU and memory use was not measured; a small VM with 2 vCPU and 2 GB RAM is a reasonable starting point, to be checked against real use.)

## First start (tailnet)

```bash
git clone <repo> field-capture-app && cd field-capture-app
./scripts/init-env.sh     # creates .env and seeds the secrets; asks for a random or your own admin password
```

The script makes `POSTGRES_PASSWORD` (and the copy in `DATABASE_URL`), `S3_ACCESS_KEY`, `S3_SECRET_KEY` and `ADMIN_PASSWORD` long and random. In `.env`:

- `TAILNET_HOST`: your machine's Tailscale DNS name (`tailscale status` shows it; it ends in `.ts.net`). The certificate script below fills it in if it is still the example value.
- `PUBLIC_ORIGINS=https://<TAILNET_HOST>`: the same script adds it (with `:<port>` only if `TAILNET_HTTPS_PORT` is not 443; the origin must match the browser's address bar).
- Leave `COOKIE_SECURE=true` and `TRUST_PROXY=1`.
- `DATABASE_URL` in the example file is only for developing on the host; the containers build their own and ignore it.

Get the certificate (it must be named after the host, because the Caddyfile looks for `/certs/<TAILNET_HOST>.crt`):

```bash
./scripts/tailnet-cert.sh
```

The script runs `tailscale cert` for `TAILNET_HOST` (from `.env`; if unset it uses this machine's name from `tailscale status`) and writes the files into `certs/`. It also sets `TAILNET_HOST` in `.env` when it is missing or still the example value, and adds `https://<host>:<TAILNET_HTTPS_PORT>` to `PUBLIC_ORIGINS` (dropping the example entry and keeping any other origins). If `caddy-tailnet` is running it restarts it. It does nothing while the current certificate has more than 30 days left, and `--force` renews anyway. A failed request leaves the old files in place.

Start:

```bash
docker compose --profile tailnet up -d --build
docker compose logs -f app        # expect: migration applied, created bucket, app listening
```

Open `https://<TAILNET_HOST>` and sign in with `ADMIN_USERNAME` and the `ADMIN_PASSWORD` from `.env`. **Change that password** (click your username at the top). Then follow the [admin guide](../guides/admin.md).

Notes:

- Tailscale certificates are short-lived (about 90 days). Renew by running `./scripts/tailnet-cert.sh` again (it restarts Caddy for you), or run `./scripts/tailnet-cert.sh --install-cron` once to add a daily check to your crontab; it only renews when fewer than 30 days remain and logs to `certs/renew.log`.
- The port `443` is published on all interfaces of the machine. To limit it to your Tailscale address, change the `caddy-tailnet` `ports:` line to `"<tailscale-ip>:443:443"`.

## First start (public VPS)

1. Point your domain's DNS (`A` and, if you have it, `AAAA`) at the server.
2. Open only what is needed on the host firewall: SSH, 80, 443.
3. Install Docker, clone the repository, `./scripts/init-env.sh`, then edit `.env`:
   - the four secrets are already seeded;
   - `DOMAIN=<your domain>`;
   - `PUBLIC_ORIGINS=https://<your domain>` (**remove** any `localhost` entry);
   - `COOKIE_SECURE=true`, `TRUST_PROXY=1`.
4. Start **without** the dev override:

```bash
docker compose --profile public up -d --build
docker compose logs -f caddy-public     # watch it obtain the certificate
```

5. Open `https://<your domain>`, sign in as the admin, change the password.

**Important on a public server**

- Never use `docker-compose.dev.yml` there: it publishes the database and storage, and turns on dev tools.
- Docker-published ports bypass `ufw`. The main compose file publishes only Caddy's ports; keep it that way.
- Work through the [security checklist](../reference/security.md#before-going-public-checklist) before inviting workers.
- Replace the free map tile servers with a provider you have an account with ([roadmap](../development/roadmap.md)).

## Updating

```bash
git pull
docker compose --profile <tailnet|public> up -d --build
docker compose logs --tail 20 app      # migrations apply automatically; look for "migration applied"
```

Migrations only go forward. Before an update that adds one, make a [backup](runbook.md#backup-and-restore). To go back to an older version after a migration ran, restore the backup taken before it.

## What starts, and in what order

`db` (waits until healthy) → `rustfs` → `app` → the edge proxy. The app, on start: checks config, applies migrations, creates the first admin if none exists, creates the storage bucket if missing, starts the video assembler, then listens.

## Volumes

| Volume (project `field-capture`) | Holds |
| --- | --- |
| `field-capture_pgdata` | the database |
| `field-capture_rustfs-data` | all video |
| `field-capture_caddy-data-tailnet` / `-public` | Caddy's state (certificates for the public profile) |

`docker compose down` keeps them; `docker compose down -v` **deletes everything**.

## Development on a laptop

```bash
./scripts/init-env.sh     # the example already points the host app at 127.0.0.1:5433 and :9000
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d db rustfs
npm install
npm run dev              # http://localhost:3100, plain http, dev tools on
```

For a phone you need HTTPS: either use the `tailnet` profile against your laptop, or run the full stack in Docker with the dev override (`docker compose -f docker-compose.yml -f docker-compose.dev.yml --profile tailnet up -d --build`).
