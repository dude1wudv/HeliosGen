#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE=${HELIOS_COMPOSE_FILE:-/opt/heliosgen/docker-compose.yml}
ENV_FILE=${HELIOS_ENV_FILE:-/opt/heliosgen-deploy/helios.env}
DATA_DIR=${HELIOS_DATA_DIR:-/opt/heliosgen-deploy/data}
NETWORK=sub2api_sub2api-network

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
[[ -f "$COMPOSE_FILE" ]] || { echo "missing compose: $COMPOSE_FILE" >&2; exit 1; }
[[ -f "$ENV_FILE" ]] || { echo "missing secret env file: $ENV_FILE" >&2; exit 1; }
chmod 600 "$ENV_FILE"

# Refuse unsafe automatic degradation when the host cannot satisfy the plan.
mem_kib=$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)
(( mem_kib >= 3 * 1024 * 1024 )) || { echo "less than 3 GiB available memory; refusing deployment" >&2; exit 1; }
disk_kib=$(df -Pk / | awk 'NR==2 {print $4}')
(( disk_kib >= 20 * 1024 * 1024 )) || { echo "less than 20 GiB available disk; refusing deployment" >&2; exit 1; }

mkdir -p "$DATA_DIR"
docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create "$NETWORK"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --build --no-deps heliosgen
