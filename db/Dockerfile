# Official Postgres + PostGIS from the Debian/PGDG packages (the postgis/postgis image has no ARM build).
FROM postgres:17-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-17-postgis-3 postgresql-17-postgis-3-scripts \
 && rm -rf /var/lib/apt/lists/*
