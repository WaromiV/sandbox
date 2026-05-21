#!/usr/bin/env bash
# Brings up openclaw + paperclip + code-server natively (no docker required
# for the services themselves), optionally fronted by Authentik (in docker).
# Logs to ./logs/, opens each URL via xdg-open.
#
# Auth model (transitional during the SSO migration):
#  - Authentik runs in deploy/authentik/ via docker compose. Provisioner
#    creates OIDC apps for paperclip, code-server, and openclaw on first run
#    and persists client configs to ~/.openclaw/oidc/. Skip with
#    USE_AUTHENTIK=0.
#  - code-server still runs with --auth bridge (HMAC token) until Phase C
#    migrates it to OIDC. Paperclip mints the token from the shared secret.
#  - Browser only ever talks to paperclip; code-server stays loopback-only.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p logs

OC_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
PC_PORT="${PAPERCLIP_PORT:-3110}"
CS_PORT="${CODE_SERVER_PORT:-8090}"
BIND_HOST="${PAPERCLIP_BIND_HOST:-127.0.0.1}"
USE_AUTHENTIK="${USE_AUTHENTIK:-1}"
AUTHENTIK_HTTP_PORT="${AUTHENTIK_HTTP_PORT:-9000}"

# --- Shared bridge secret -----------------------------------------------------
BRIDGE_DIR="${PAPERCLIP_BRIDGE_DIR:-$HOME/.openclaw}"
BRIDGE_SECRET_FILE="${PAPERCLIP_BRIDGE_SECRET_FILE:-$BRIDGE_DIR/bridge.secret}"
if [ ! -f "$BRIDGE_SECRET_FILE" ]; then
  mkdir -p "$BRIDGE_DIR"
  chmod 700 "$BRIDGE_DIR"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32 > "$BRIDGE_SECRET_FILE"
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$BRIDGE_SECRET_FILE"
  fi
  chmod 600 "$BRIDGE_SECRET_FILE"
  echo "Generated new bridge secret at $BRIDGE_SECRET_FILE"
fi
export PAPERCLIP_BRIDGE_SECRET_FILE="$BRIDGE_SECRET_FILE"
export CODE_SERVER_PORT="$CS_PORT"
export PAPERCLIP_EDITOR_UPSTREAM="http://127.0.0.1:$CS_PORT"
export PAPERCLIP_LISTEN_HOST="$BIND_HOST"
export PAPERCLIP_LISTEN_PORT="$PC_PORT"

# --- Authentik (Phase A — stack only, no service-side OIDC wiring yet) ---
if [ "$USE_AUTHENTIK" = "1" ]; then
  if [ -x deploy/authentik/provision.sh ]; then
    echo "=== Provisioning Authentik (deploy/authentik/) ==="
    AUTHENTIK_HTTP_PORT="$AUTHENTIK_HTTP_PORT" \
    PAPERCLIP_BASE_URL="http://127.0.0.1:$PC_PORT" \
    CODESERVER_BASE_URL="http://127.0.0.1:$CS_PORT" \
    OPENCLAW_BASE_URL="http://127.0.0.1:$OC_PORT" \
      deploy/authentik/provision.sh 2>&1 | tee logs/authentik-provision.log
  else
    echo "!! deploy/authentik/provision.sh missing or not executable — skipping Authentik"
  fi
else
  echo "=== USE_AUTHENTIK=0 — skipping Authentik stack ==="
fi

echo "=== Tool versions ==="
node -v 2>&1 || true
pnpm -v 2>&1 || true

# --- openclaw gateway (uses prebuilt dist/) ---
if [ -f openclaw/dist/index.js ]; then
  echo "=== Starting openclaw gateway on :$OC_PORT ==="
  (cd openclaw && nohup node dist/index.js gateway --bind lan --port "$OC_PORT" >../logs/openclaw.log 2>&1 & echo "openclaw pid=$!")
else
  echo "!! openclaw/dist/index.js not found — needs build (pnpm install && pnpm build inside openclaw/)"
fi

# --- code-server (patched code-server with auth=bridge or auth=oidc) ---
#
# Default: --auth bridge (HMAC token from paperclip's editor proxy).
# Opt-in: --auth oidc (validates Authentik id_token in Authorization: Bearer).
#   Enable by setting CODE_SERVER_AUTH=oidc. Requires the OIDC config at
#   ~/.openclaw/oidc/codeserver.json (created by deploy/authentik/provision.sh)
#   AND the paperclip editor proxy must be forwarding id_tokens (Phase E
#   follow-up; not on by default yet).
CODE_SERVER_ENTRY="./code-server/out/node/entry.js"
CODE_SERVER_AUTH="${CODE_SERVER_AUTH:-bridge}"
OIDC_CODESERVER_CONFIG="$HOME/.openclaw/oidc/codeserver.json"
if [ -f "$CODE_SERVER_ENTRY" ]; then
  if [ "$CODE_SERVER_AUTH" = "oidc" ] && [ -f "$OIDC_CODESERVER_CONFIG" ]; then
    echo "=== Starting patched code-server on 127.0.0.1:$CS_PORT (auth=oidc) ==="
    nohup node "$CODE_SERVER_ENTRY" \
      --auth oidc \
      --oidc-config-file "$OIDC_CODESERVER_CONFIG" \
      --bind-addr "127.0.0.1:$CS_PORT" \
      --disable-update-check \
      >logs/code-server.log 2>&1 &
    echo "code-server pid=$!"
  else
    if [ "$CODE_SERVER_AUTH" = "oidc" ]; then
      echo "!! CODE_SERVER_AUTH=oidc but $OIDC_CODESERVER_CONFIG missing — falling back to bridge"
    fi
    echo "=== Starting patched code-server on 127.0.0.1:$CS_PORT (auth=bridge) ==="
    nohup node "$CODE_SERVER_ENTRY" \
      --auth bridge \
      --bridge-secret-file "$BRIDGE_SECRET_FILE" \
      --bind-addr "127.0.0.1:$CS_PORT" \
      --disable-update-check \
      >logs/code-server.log 2>&1 &
    echo "code-server pid=$!"
  fi
else
  echo "!! patched code-server build missing. Run: (cd code-server && npm install && npx tsc && ./ci/build/build-code-server.sh)"
fi

# --- paperclip (pnpm dev — bound to loopback) ---
if [ -d paperclip ]; then
  echo "=== Starting paperclip dev on $BIND_HOST:$PC_PORT ==="
  if [ ! -d paperclip/node_modules ]; then
    (cd paperclip && pnpm install >../logs/paperclip-install.log 2>&1) || echo "!! paperclip install failed (see logs/paperclip-install.log)"
  fi
  # DATABASE_URL resolution order:
  #   1. Explicit DATABASE_URL from the calling shell wins
  #   2. ~/.openclaw/oidc/paperclip-db.env (written by the Authentik
  #      provisioner — uses the same PG cluster Authentik runs on)
  #   3. Fall through unset; paperclip then tries its embedded-postgres
  #      dep, which fails on some hosts. The provisioner-managed PG path
  #      is the supported default.
  paperclip_db_env="$HOME/.openclaw/oidc/paperclip-db.env"
  paperclip_env=(
    "PORT=$PC_PORT"
    "PAPERCLIP_BRIDGE_SECRET_FILE=$BRIDGE_SECRET_FILE"
    "PAPERCLIP_EDITOR_UPSTREAM=$PAPERCLIP_EDITOR_UPSTREAM"
    "PAPERCLIP_LISTEN_HOST=$BIND_HOST"
    "PAPERCLIP_LISTEN_PORT=$PC_PORT"
    "CODE_SERVER_PORT=$CS_PORT"
    "BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET:-paperclip-dev-secret}"
  )
  if [ -n "${DATABASE_URL:-}" ]; then
    paperclip_env+=("DATABASE_URL=$DATABASE_URL")
  elif [ -f "$paperclip_db_env" ]; then
    # shellcheck disable=SC1090
    db_url=$(. "$paperclip_db_env"; printf '%s' "$DATABASE_URL")
    if [ -n "$db_url" ]; then
      paperclip_env+=("DATABASE_URL=$db_url")
    fi
  fi
  # When the OIDC config is present, run paperclip in authenticated/private
  # so the OIDC plugin actually mounts (dev-runner deletes the deployment
  # mode env otherwise). Without OIDC config, default to local_trusted.
  pnpm_flags=()
  if [ -f "$HOME/.openclaw/oidc/paperclip.json" ]; then
    pnpm_flags+=( --authenticated-private --bind loopback )
    paperclip_env+=(
      "PAPERCLIP_PUBLIC_URL=http://${BIND_HOST}:${PC_PORT}"
      "PAPERCLIP_ALLOWED_HOSTNAMES=${BIND_HOST},localhost,127.0.0.1"
    )
    echo "    (OIDC config present — paperclip will start in authenticated mode)"
  fi
  (cd paperclip && env "${paperclip_env[@]}" nohup pnpm dev "${pnpm_flags[@]}" >../logs/paperclip.log 2>&1 & echo "paperclip pid=$!")
fi

sleep 4
echo "=== Status ==="
status_urls=(
  "http://127.0.0.1:$OC_PORT/healthz"
  "http://127.0.0.1:$PC_PORT/api/health"
  "http://127.0.0.1:$CS_PORT/"
  "http://127.0.0.1:$PC_PORT/editor/"
)
if [ "$USE_AUTHENTIK" = "1" ]; then
  status_urls+=("http://127.0.0.1:$AUTHENTIK_HTTP_PORT/-/health/ready/")
fi
for u in "${status_urls[@]}"; do
  printf "%-50s -> " "$u"
  curl -s -o /dev/null -w "HTTP %{http_code}\n" --max-time 3 "$u" || echo "no response"
done

if [ "${OPEN_BROWSER:-1}" = "1" ] && command -v xdg-open >/dev/null 2>&1; then
  echo "=== Opening paperclip in browser ==="
  (xdg-open "http://127.0.0.1:$PC_PORT" >/dev/null 2>&1 &)
fi

echo "Done. Logs in ./logs/. To stop: pkill -f 'openclaw|paperclip|code-server'"
echo "Bridge secret: $BRIDGE_SECRET_FILE  (keep this private and shared between paperclip + code-server)"
if [ "$USE_AUTHENTIK" = "1" ]; then
  echo "Authentik admin: http://127.0.0.1:$AUTHENTIK_HTTP_PORT/if/admin/  (akadmin / see deploy/authentik/.env)"
  echo "OIDC configs:   $HOME/.openclaw/oidc/{paperclip,codeserver,gateway}.json"
  if [ -f "$HOME/.openclaw/oidc/codeserver.json" ] && [ "${CODE_SERVER_AUTH:-bridge}" = "bridge" ]; then
    echo "Hint:           code-server OIDC ready — re-run with CODE_SERVER_AUTH=oidc to opt in"
  fi
fi
