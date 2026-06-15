#!/usr/bin/env bash
# Brings up openclaw + paperclip + code-server natively (no docker required
# for the services themselves), optionally fronted by Authentik (in docker).
# Logs to ./logs/, opens each URL via xdg-open.
#
# Auth model:
#  - openclaw and code-server have NO built-in auth. openclaw runs with
#    `--auth none` and code-server with `--auth none`, both bound to loopback.
#    They are gated SOLELY by Authentik forward-auth at the reverse proxy.
#  - paperclip is the role authority + its own Authentik OIDC client (it owns
#    the users table and the browser session). It is NOT stripped of auth.
#  - Authentik runs in deploy/authentik/ via docker compose. The provisioner
#    creates the paperclip OIDC client plus an Authentik forward-auth proxy
#    provider (embedded outpost) used to guard /editor and /openclaw. Skip the
#    whole Authentik stack with USE_AUTHENTIK=0.
#  - DEV NOTE: this script runs the services on loopback but does NOT stand up
#    nginx. Because openclaw + code-server have no auth, /editor and /openclaw
#    are UNGATED unless you put a reverse proxy with Authentik forward-auth in
#    front of them. See AGENTS.md ("Auth model") for a ready-to-use manual
#    nginx config. Production (deploy/install-openclaw-cluster.sh) wires this
#    nginx + forward-auth automatically.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p logs

OC_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
PC_PORT="${PAPERCLIP_PORT:-3110}"
CS_PORT="${CODE_SERVER_PORT:-8090}"
BIND_HOST="${PAPERCLIP_BIND_HOST:-127.0.0.1}"
USE_AUTHENTIK="${USE_AUTHENTIK:-1}"
AUTHENTIK_HTTP_PORT="${AUTHENTIK_HTTP_PORT:-9000}"

export CODE_SERVER_PORT="$CS_PORT"
export PAPERCLIP_LISTEN_HOST="$BIND_HOST"
export PAPERCLIP_LISTEN_PORT="$PC_PORT"

# --- Authentik (provisions paperclip OIDC client + forward-auth provider) ---
# Note: in dev there is no nginx in front, so the forward-auth provider isn't
# exercised here — see AGENTS.md ("Auth model") for the manual nginx config
# that turns it on. CLUSTER_DOMAIN stays localhost in dev.
if [ "$USE_AUTHENTIK" = "1" ]; then
  if [ -x deploy/authentik/provision.sh ]; then
    echo "=== Provisioning Authentik (deploy/authentik/) ==="
    AUTHENTIK_HTTP_PORT="$AUTHENTIK_HTTP_PORT" \
    PAPERCLIP_BASE_URL="http://127.0.0.1:$PC_PORT" \
    CLUSTER_DOMAIN="${CLUSTER_DOMAIN:-localhost}" \
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
# No built-in auth (--auth none) bound to loopback. Authentik forward-auth at
# the reverse proxy is the only gate for browser access; paperclip reaches it
# server-to-server on loopback.
if [ -f openclaw/dist/index.js ]; then
  echo "=== Starting openclaw gateway on 127.0.0.1:$OC_PORT (auth=none) ==="
  (cd openclaw && nohup node dist/index.js gateway --bind loopback --auth none --port "$OC_PORT" >../logs/openclaw.log 2>&1 & echo "openclaw pid=$!")
else
  echo "!! openclaw/dist/index.js not found — needs build (pnpm install && pnpm build inside openclaw/)"
fi

# --- code-server (patched code-server, no built-in auth) ---
# code-server runs with --auth none bound to loopback. It is gated SOLELY by
# Authentik forward-auth at the reverse proxy (see AGENTS.md). No bridge/OIDC
# tokens are involved any more.
CODE_SERVER_ENTRY="./code-server/out/node/entry.js"
if [ -f "$CODE_SERVER_ENTRY" ]; then
  echo "=== Starting patched code-server on 127.0.0.1:$CS_PORT (auth=none) ==="
  nohup node "$CODE_SERVER_ENTRY" \
    --auth none \
    --bind-addr "127.0.0.1:$CS_PORT" \
    --disable-update-check \
    >logs/code-server.log 2>&1 &
  echo "code-server pid=$!"
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
  # Wire the openclaw-bridge so paperclip mirrors openclaw agents and stages
  # per-agent paperclip API keys + the paperclip skill into their workspaces.
  # The gateway runs with --auth none, so no gateway token is needed — only
  # the URL. (Per-agent paperclip API keys are minted by the bridge itself and
  # are unrelated to gateway auth.)
  paperclip_env+=("OPENCLAW_GATEWAY_URL=ws://127.0.0.1:${OC_PORT}")
  echo "    (openclaw-bridge enabled: ws://127.0.0.1:${OC_PORT}, gateway auth=none)"

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
echo "Auth model: openclaw + code-server run with NO auth on loopback."
echo "            They are ungated unless you front them with nginx + Authentik"
echo "            forward-auth (see AGENTS.md, \"Auth model\")."
if [ "$USE_AUTHENTIK" = "1" ]; then
  echo "Authentik admin: http://127.0.0.1:$AUTHENTIK_HTTP_PORT/if/admin/  (akadmin / see deploy/authentik/.env)"
  echo "OIDC config:    $HOME/.openclaw/oidc/paperclip.json  (paperclip is the only OIDC client)"
fi
