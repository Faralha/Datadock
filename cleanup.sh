#!/bin/bash
set -e

# ==========================================
# CLEANUP SCRIPT (DEV ONLY)
# Diadaptasi dari template Standard CI/CD (template Standard CI/CD lab).
# Tambahan DataDock: database tenant milik instance branch ini dihapus dari instance database bersama
# (lewat purge.ts, yang menolak jalan tanpa TENANT_PREFIX), lalu metadata, backup, env file, dan blok compose-nya.
# Instance database sendiri TIDAK disentuh.
# ==========================================

# Load environment variables
if [ -f deploy.env ]; then source deploy.env; fi

# ==========================================
# 🔒 SAFETY LOCK
# ==========================================
# Hanya boleh jalan di ENV 'dev'
if [ "$DEPLOY_ENV" != "dev" ]; then
    echo "⛔ SAFETY LOCK ACTIVATED!"
    echo "❌ Cleanup is NOT allowed for '$DEPLOY_ENV' environment."
    exit 0
fi

# ==========================================
# Configuration Matches deploy.sh
# ==========================================

ENV_BASE_DIR="${ENV_BASE_DIR:-/opt/environments}"
PROJECT_NAME="${CI_PROJECT_NAME:-datadock}"
ROOT_DOMAIN="iimlab.id"

# Config Dev Only
TUNNEL_SERVICE_NAME="dev_tunnel"
ENV_DIR="${ENV_BASE_DIR}/dev"
CLOUDFLARED_CONFIG="${ENV_DIR}/cloudflared/config.yml"
DOCKER_COMPOSE_FILE="${ENV_DIR}/docker-compose.yml"

# Logic Nama Container & CNAME (Khusus Dev)
CLEAN_BRANCH=$(echo "$CI_COMMIT_BRANCH" | tr '[:upper:]' '[:lower:]')
SUBDOMAIN="${CLEAN_BRANCH}_${PROJECT_NAME}"
FULL_HOSTNAME="${SUBDOMAIN}.${ROOT_DOMAIN}"
CONTAINER_NAME="${CLEAN_BRANCH}_${PROJECT_NAME}"
DATA_DIR="${ENV_DIR}/data/${CONTAINER_NAME}"

# ==========================================
# Logging
# ==========================================
log_info() { echo -e "\n🧹 [CLEANUP] $1" >&2; }
log_warn() { echo -e "\n⚠️  [WARN] $1" >&2; }
log_success() { echo -e "\n✅ [SUCCESS] $1" >&2; }

# ==========================================
# Execution
# ==========================================

log_info "Target to destroy: $CONTAINER_NAME"
log_info "Target Hostname  : $FULL_HOSTNAME"

# 1. Hapus database tenant milik instance ini dari engine dev (sebelum container dihapus)
if docker ps --format '{{.Names}}' | grep -qx "${CONTAINER_NAME}"; then
    log_info "Purging tenant databases created by this instance..."
    docker exec ${CONTAINER_NAME} bun src/purge.ts || log_warn "Purge gagal sebagian; cek log di atas"
else
    log_warn "Container tidak berjalan; database tenant milik instance ini (jika ada) tidak di-purge."
fi

# 2. Hapus Container App
if docker ps -a --format '{{.Names}}' | grep -qx "${CONTAINER_NAME}"; then
    IMAGE_NAME=$(docker inspect -f '{{.Config.Image}}' ${CONTAINER_NAME})
    log_info "Stopping & Removing Container..."
    docker stop ${CONTAINER_NAME} 2>/dev/null || true
    docker rm ${CONTAINER_NAME} 2>/dev/null || true
    log_success "Container removed successfully"
else
    log_warn "Container not found (already deleted?)."
fi

# 3. Hapus metadata & backup (milik uid 1000, dihapus lewat container), env file, dan blok compose
log_info "Cleaning up data, backups, config, and compose entry..."
APP_ENV_FILE="${ENV_DIR}/configs/.env.${CONTAINER_NAME}"
BACKUP_ROOT=""
if [ -f "${APP_ENV_FILE}" ]; then
    BACKUP_ROOT=$(grep -E '^BACKUP_HOST_DIR=' "${APP_ENV_FILE}" | tail -n 1 | cut -d= -f2- || true)
fi
BACKUP_ROOT="${BACKUP_ROOT:-${ENV_DIR}/backups}"
for parent in "${ENV_DIR}/data" "${BACKUP_ROOT}"; do
    if [ -d "${parent}/${CONTAINER_NAME}" ]; then
        docker run --rm --user 0 --entrypoint sh -v "${parent}:/parent" ${IMAGE_NAME:-oven/bun:1.3.14-slim} \
            -c "rm -rf '/parent/${CONTAINER_NAME}'" || log_warn "Gagal menghapus ${parent}/${CONTAINER_NAME}"
    fi
done
rm -f "${APP_ENV_FILE}"
if [ -f "${DOCKER_COMPOSE_FILE}" ]; then
    python3 -c "
lines = open('${DOCKER_COMPOSE_FILE}').readlines()
out, skip = [], False
for line in lines:
    if line.startswith('  ${CONTAINER_NAME}:'):
        skip = True
        continue
    if skip and line.strip() and (line[0] != ' ' or (line.startswith('  ') and not line.startswith('    '))):
        skip = False
    if not skip:
        out.append(line)
open('${DOCKER_COMPOSE_FILE}', 'w').writelines(out)
"
fi
log_success "Data, backups, config, and compose entry cleaned"

# 4. Hapus DNS CNAME Record dari Cloudflare
if [ -n "$DEV_TUNNEL_ID" ]; then
    log_info "Removing DNS CNAME record for ${FULL_HOSTNAME}..."
    docker run --rm \
        -v ${ENV_DIR}/cloudflared:/home/nonroot/.cloudflared \
        cloudflare/cloudflared:latest \
        tunnel route dns delete ${DEV_TUNNEL_ID} ${FULL_HOSTNAME} 2>&1 || log_warn "Failed to delete DNS record (might already be deleted or doesn't exist)"
    log_success "DNS CNAME record cleanup attempted"
else
    log_warn "DEV_TUNNEL_ID not found! Skipping DNS cleanup."
fi

# 5. Bersihkan Config Cloudflare (Delete Ingress)
if [ -f "$CLOUDFLARED_CONFIG" ]; then
    log_info "Removing Ingress Rule from config.yml..."
    sed -i "/hostname: ${FULL_HOSTNAME}/,+1d" ${CLOUDFLARED_CONFIG}
    log_success "Ingress rule removed from config"
else
    log_warn "Config file not found!"
fi

# 6. Restart Tunnel (Agar perubahan config aktif)
log_info "Reloading Tunnel..."
cd ${ENV_DIR}
docker compose restart ${TUNNEL_SERVICE_NAME}
log_success "Tunnel restarted successfully"

log_success "✅ Cleanup Complete! Dev environment destroyed."
log_info "Summary:"
log_info "  - Tenant databases (prefix branch ini): ✓"
log_info "  - Container: ${CONTAINER_NAME} ✓"
log_info "  - DNS Record: ${FULL_HOSTNAME} ✓"
log_info "  - Ingress Config: ✓"
log_info "  - Data, backups, config & compose entry: ✓"
