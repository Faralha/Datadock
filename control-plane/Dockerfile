# DataDock control plane. Target:
#   dev     → Bun + tool klien database + devDependencies (dipakai compose.yml lokal)
#   test    → dev + source, dipakai job test di CI
#   runtime → image produksi: server + web UI hasil build, tanpa devDependencies, user non-root
#
# Engine database adalah instance bare-metal yang sudah ada di server, jadi backup dijalankan dari image ini
# dengan tool klien yang versinya disamakan dengan server: PostgreSQL 18, MariaDB 12.2, MongoDB Database Tools.
ARG BUN_VERSION=1.3.14

# ─── Tool klien database (dipakai dev, test, dan runtime) ─────────────────────
FROM oven/bun:${BUN_VERSION}-slim AS tools
ARG PG_MAJOR=18
ARG MARIADB_SERIES=12.2
ARG MONGO_TOOLS_VERSION=100.14.0
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
    . /etc/os-release; \
    install -d /usr/share/keyrings; \
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/keyrings/pgdg.asc; \
    echo "deb [signed-by=/usr/share/keyrings/pgdg.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" > /etc/apt/sources.list.d/pgdg.list; \
    curl -fsSL https://supplychain.mariadb.com/mariadb-keyring-2019.gpg -o /usr/share/keyrings/mariadb.gpg; \
    echo "deb [signed-by=/usr/share/keyrings/mariadb.gpg] https://dlm.mariadb.com/repo/mariadb-server/${MARIADB_SERIES}/repo/debian ${VERSION_CODENAME} main" > /etc/apt/sources.list.d/mariadb.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends "postgresql-client-${PG_MAJOR}" mariadb-client; \
    curl -fsSL "https://fastdl.mongodb.org/tools/db/mongodb-database-tools-debian12-x86_64-${MONGO_TOOLS_VERSION}.deb" -o /tmp/mongo-tools.deb; \
    apt-get install -y --no-install-recommends /tmp/mongo-tools.deb; \
    rm -f /tmp/mongo-tools.deb; \
    apt-get purge -y --auto-remove curl; \
    rm -rf /var/lib/apt/lists/*; \
    pg_dump --version; mariadb-dump --version; mongodump --version | head -1

FROM tools AS dev
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM dev AS test
COPY . .
CMD ["bun", "test", "--timeout", "60000", "test/"]

FROM test AS web
RUN bun run build:web

FROM oven/bun:${BUN_VERSION}-slim AS prod-deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM tools AS runtime
ARG ENV=prod
ARG BUILD_DATE
ARG VCS_REF
LABEL org.opencontainers.image.title="datadock-control-plane" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      id.iimlab.environment="${ENV}"
WORKDIR /app
ENV NODE_ENV=production PORT=3000 SQLITE_PATH=/data/datadock.sqlite BACKUP_DIR=/backups
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY --from=web /app/web/dist ./web/dist
# Izin file mengikuti checkout runner (bisa umask 077): buka baca supaya user bun bisa memuat source.
# /data: metadata SQLite, /backups: file dump. Keduanya di-mount dari host saat deploy.
RUN chmod -R a+rX package.json src web/dist \
 && mkdir -p /data /backups && chown bun:bun /data /backups
USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:3000/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["bun", "src/index.ts"]
