#!/usr/bin/env bash
# Stand up Authentik next to the openclaw cluster and create OIDC clients
# for paperclip, code-server, and openclaw.
#
# Idempotent:
#   - first run generates secrets, writes deploy/authentik/.env, brings the
#     stack up, then creates OIDC providers + applications.
#   - subsequent runs reuse the existing .env and skip provider/app creation
#     if the targets already exist.
#
# Writes per-client config files to ~/.openclaw/oidc/{paperclip,codeserver,gateway}.json
# (mode 0600) for downstream services to consume.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

OIDC_CONFIG_DIR="${OIDC_CONFIG_DIR:-$HOME/.openclaw/oidc}"
ENV_FILE="$HERE/.env"

# ---- ports / URLs --------------------------------------------------------
AUTHENTIK_HTTP_PORT="${AUTHENTIK_HTTP_PORT:-9000}"
AUTHENTIK_BASE_URL="http://127.0.0.1:${AUTHENTIK_HTTP_PORT}"
PAPERCLIP_BASE_URL="${PAPERCLIP_BASE_URL:-http://127.0.0.1:3110}"
CODESERVER_BASE_URL="${CODESERVER_BASE_URL:-http://127.0.0.1:8090}"
OPENCLAW_BASE_URL="${OPENCLAW_BASE_URL:-http://127.0.0.1:18789}"
PAPERCLIP_ROLE_AUTHORITY_URL="${PAPERCLIP_ROLE_AUTHORITY_URL:-${PAPERCLIP_BASE_URL}/api/access/role}"

# ---- prereqs -------------------------------------------------------------
need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1" >&2; exit 1; }; }
need docker
need curl
need jq
need openssl

DOCKER_COMPOSE="docker compose"
if ! docker compose version >/dev/null 2>&1; then
  if command -v docker-compose >/dev/null 2>&1; then
    DOCKER_COMPOSE="docker-compose"
  else
    echo "missing: docker compose plugin (or docker-compose binary)" >&2
    exit 1
  fi
fi

# ---- generate secrets on first run --------------------------------------
gen_hex() { openssl rand -hex "${1:-32}"; }

if [ ! -f "$ENV_FILE" ]; then
  echo ">> generating $ENV_FILE (first run)"
  umask 077
  cat > "$ENV_FILE" <<EOF
PG_DB=authentik
PG_USER=authentik
PG_PASS=$(gen_hex 24)
AUTHENTIK_SECRET_KEY=$(gen_hex 32)
AUTHENTIK_BOOTSTRAP_PASSWORD=$(gen_hex 16)
AUTHENTIK_BOOTSTRAP_TOKEN=$(gen_hex 32)
AUTHENTIK_BOOTSTRAP_EMAIL=akadmin@localhost
AUTHENTIK_IMAGE=ghcr.io/goauthentik/server
AUTHENTIK_TAG=2026.2.3
HOST_BIND_HTTP=127.0.0.1:${AUTHENTIK_HTTP_PORT}
HOST_BIND_HTTPS=127.0.0.1:9443
PG_HOST_PORT=5436
# Set to 1 to skip the bridge-network mode and run all three Authentik
# containers on the host's network namespace. Use this when the default
# bridge subnet (172.20.0.0/16) is being intercepted by a host-level
# nftables hook (sing-box, mullvad-cli, transparent proxies, ...).
# AUTHENTIK_HOST_NET=1
EOF
  chmod 600 "$ENV_FILE"
fi

# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

mkdir -p "$HERE/data/database" "$HERE/data/media" "$HERE/data/certs" "$HERE/data/custom-templates"
mkdir -p "$OIDC_CONFIG_DIR"
chmod 700 "$OIDC_CONFIG_DIR"

# ---- bring stack up ------------------------------------------------------
COMPOSE_FILES=( -f docker-compose.yml )
if [ "${AUTHENTIK_HOST_NET:-0}" = "1" ]; then
  echo ">> AUTHENTIK_HOST_NET=1 — layering docker-compose.host.yml override"
  COMPOSE_FILES+=( -f docker-compose.host.yml )
fi

echo ">> $DOCKER_COMPOSE ${COMPOSE_FILES[*]} up -d"
if ! $DOCKER_COMPOSE "${COMPOSE_FILES[@]}" up -d 2>&1 | tee /tmp/authentik-compose-up.log; then
  if grep -q "Pool overlaps" /tmp/authentik-compose-up.log; then
    echo ">> bridge subnet collision — retrying with host-net override"
    COMPOSE_FILES+=( -f docker-compose.host.yml )
    $DOCKER_COMPOSE "${COMPOSE_FILES[@]}" up -d
  else
    echo "!! docker compose up failed; see /tmp/authentik-compose-up.log" >&2
    exit 1
  fi
fi

# ---- wait for health -----------------------------------------------------
echo ">> waiting for Authentik to come up at $AUTHENTIK_BASE_URL"
deadline=$(( $(date +%s) + 180 ))
while :; do
  status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "$AUTHENTIK_BASE_URL/-/health/ready/" || echo "000")
  if [ "$status" = "204" ] || [ "$status" = "200" ]; then
    echo "   ready (HTTP $status)"
    break
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "!! Authentik did not become healthy within 180s (last status: $status)" >&2
    $DOCKER_COMPOSE logs --tail=80 server || true
    exit 1
  fi
  sleep 3
done

# ---- API helpers ---------------------------------------------------------
AK_CURL=(curl -sS -H "Authorization: Bearer ${AUTHENTIK_BOOTSTRAP_TOKEN}" -H "Content-Type: application/json")

ak_get() {
  "${AK_CURL[@]}" "${AUTHENTIK_BASE_URL}$1"
}
ak_post() {
  "${AK_CURL[@]}" -X POST "${AUTHENTIK_BASE_URL}$1" --data "$2"
}
ak_patch() {
  "${AK_CURL[@]}" -X PATCH "${AUTHENTIK_BASE_URL}$1" --data "$2"
}

# Verify the bootstrap token actually works (akadmin user).
me_resp="$(ak_get '/api/v3/core/users/me/' || true)"
if ! echo "$me_resp" | jq -e '.user.username' >/dev/null 2>&1; then
  echo "!! bootstrap token rejected; cannot continue. Response:" >&2
  echo "$me_resp" >&2
  exit 1
fi

# ---- find the default authorization flow + signing key -------------------
AUTH_FLOW_UUID="$(ak_get '/api/v3/flows/instances/?slug=default-provider-authorization-implicit-consent' | jq -r '.results[0].pk')"
if [ -z "$AUTH_FLOW_UUID" ] || [ "$AUTH_FLOW_UUID" = "null" ]; then
  echo "!! could not find default-provider-authorization-implicit-consent flow" >&2
  exit 1
fi

INVALIDATION_FLOW_UUID="$(ak_get '/api/v3/flows/instances/?slug=default-provider-invalidation-flow' | jq -r '.results[0].pk // empty')"

SIGNING_KEY_UUID="$(ak_get '/api/v3/crypto/certificatekeypairs/?name=authentik+Self-signed+Certificate' | jq -r '.results[0].pk // empty')"
if [ -z "$SIGNING_KEY_UUID" ]; then
  # Fall back to the first signing-capable cert.
  SIGNING_KEY_UUID="$(ak_get '/api/v3/crypto/certificatekeypairs/?has_key=true' | jq -r '.results[0].pk // empty')"
fi
if [ -z "$SIGNING_KEY_UUID" ]; then
  echo "!! no signing-capable certificate found in Authentik" >&2
  exit 1
fi

# ---- collect default OpenID scope mappings (openid/email/profile) -------
# Authentik does NOT bind these to a new OAuth2 provider by default — without
# them id_tokens come back without email/name and downstream auth flows
# (like better-auth) reject the user as missing required identity fields.
SCOPE_MAPPING_UUIDS="$(
  ak_get '/api/v3/propertymappings/provider/scope/?page_size=100' \
  | jq -c '[.results[] | select(.scope_name=="openid" or .scope_name=="email" or .scope_name=="profile") | .pk]'
)"
if [ "$(echo "$SCOPE_MAPPING_UUIDS" | jq 'length')" -lt 3 ]; then
  echo "!! could not find OpenID scope mappings (openid/email/profile) in Authentik" >&2
  exit 1
fi

# ---- groups: openclaw-admins / openclaw-users ---------------------------
ensure_group() {
  local name="$1"
  local existing
  existing="$(ak_get "/api/v3/core/groups/?name=$(printf '%s' "$name" | jq -sRr @uri)" | jq -r '.results[0].pk // empty')"
  if [ -n "$existing" ]; then echo "$existing"; return 0; fi
  ak_post '/api/v3/core/groups/' "$(jq -nc --arg n "$name" '{name:$n, is_superuser:false}')" \
    | jq -r '.pk'
}
ADMIN_GROUP_PK="$(ensure_group openclaw-admins)"
USER_GROUP_PK="$(ensure_group openclaw-users)"
echo ">> groups: openclaw-admins=$ADMIN_GROUP_PK openclaw-users=$USER_GROUP_PK"

# ---- provider + app + config-file per client ----------------------------
provision_client() {
  local slug="$1"          # e.g. openclaw-paperclip
  local name="$2"          # human-readable
  local redirect_url="$3"  # callback URL
  local out_file="$4"      # JSON file path
  local extra_redirects="${5:-}"  # comma-separated additional URLs
  local logout_url="${6:-}"      # optional back-channel logout URL

  # Look up existing provider by name.
  local provider_pk
  provider_pk="$(ak_get "/api/v3/providers/oauth2/?name=$(printf '%s' "$slug" | jq -sRr @uri)" | jq -r '.results[0].pk // empty')"

  local redirect_array
  redirect_array="$(jq -nc --arg u "$redirect_url" --arg e "$extra_redirects" '
    ($e | split(",") | map(select(length>0))) as $extras
    | [{matching_mode:"strict", url:$u}] + ($extras | map({matching_mode:"strict", url:.}))
  ')"

  local body
  body="$(jq -nc \
    --arg name "$slug" \
    --arg flow "$AUTH_FLOW_UUID" \
    --arg invflow "$INVALIDATION_FLOW_UUID" \
    --arg key "$SIGNING_KEY_UUID" \
    --arg logout_url "$logout_url" \
    --argjson redirects "$redirect_array" \
    --argjson mappings "$SCOPE_MAPPING_UUIDS" \
    '{
      name: $name,
      client_type: "confidential",
      authorization_flow: $flow,
      invalidation_flow: (if $invflow=="" then null else $invflow end),
      signing_key: $key,
      access_code_validity: "minutes=1",
      access_token_validity: "minutes=5",
      refresh_token_validity: "days=30",
      include_claims_in_id_token: true,
      sub_mode: "user_id",
      issuer_mode: "per_provider",
      redirect_uris: $redirects,
      property_mappings: $mappings,
      logout_uri: (if $logout_url=="" then null else $logout_url end),
      logout_method: (if $logout_url=="" then null else "backchannel" end)
    } | with_entries(select(.value != null))')"

  if [ -z "$provider_pk" ]; then
    echo ">> creating OIDC provider: $slug"
    provider_pk="$(ak_post '/api/v3/providers/oauth2/' "$body" | jq -r '.pk')"
  else
    echo ">> updating OIDC provider: $slug (pk=$provider_pk)"
    ak_patch "/api/v3/providers/oauth2/$provider_pk/" "$body" >/dev/null
  fi

  # Application
  local app_pk
  app_pk="$(ak_get "/api/v3/core/applications/?slug=$slug" | jq -r '.results[0].pk // empty')"
  if [ -z "$app_pk" ]; then
    echo ">> creating application: $slug"
    ak_post '/api/v3/core/applications/' "$(jq -nc \
      --arg name "$name" --arg slug "$slug" --argjson provider "$provider_pk" \
      '{name:$name, slug:$slug, provider:$provider, policy_engine_mode:"any", group:""}')" >/dev/null
  fi

  # Read back client_id + client_secret
  local creds
  creds="$(ak_get "/api/v3/providers/oauth2/$provider_pk/")"
  local client_id client_secret issuer
  client_id="$(echo "$creds" | jq -r '.client_id')"
  client_secret="$(echo "$creds" | jq -r '.client_secret')"
  issuer="${AUTHENTIK_BASE_URL}/application/o/${slug}/"

  umask 077
  jq -nc \
    --arg issuer "$issuer" \
    --arg client_id "$client_id" \
    --arg client_secret "$client_secret" \
    --arg redirect "$redirect_url" \
    --arg role_url "$PAPERCLIP_ROLE_AUTHORITY_URL" \
    '{
      issuer: $issuer,
      client_id: $client_id,
      client_secret: $client_secret,
      redirect_uri: $redirect,
      scopes: ["openid","profile","email"],
      role_authority_url: $role_url
    }' > "$out_file"
  chmod 600 "$out_file"
  echo "   wrote $out_file"
}

# Paperclip uses better-auth's genericOAuth plugin which mounts the OAuth
# callback at /api/auth/oauth2/callback/<providerId> — providerId is the
# constant "authentik" (see paperclip/server/src/auth/oidc-config.ts).
provision_client \
  "openclaw-paperclip" "openclaw paperclip" \
  "${PAPERCLIP_BASE_URL}/api/auth/oauth2/callback/authentik" \
  "${OIDC_CONFIG_DIR}/paperclip.json" \
  "" \
  "${PAPERCLIP_BASE_URL}/api/auth/oidc/back-channel-logout"

provision_client \
  "openclaw-codeserver" "openclaw code-server" \
  "${CODESERVER_BASE_URL}/oidc/callback" \
  "${OIDC_CONFIG_DIR}/codeserver.json" \
  "${PAPERCLIP_BASE_URL}/editor/oidc/callback"

provision_client \
  "openclaw-gateway" "openclaw gateway" \
  "${OPENCLAW_BASE_URL}/oidc/callback" \
  "${OIDC_CONFIG_DIR}/gateway.json"

# ---- ensure a "paperclip" database exists in the same PG cluster -------
# paperclip's embedded-postgres dep fails on some hosts (binary not found /
# wrong arch), so reuse the Authentik PG. Idempotent — runs on every
# provision.
echo ">> ensuring paperclip database exists in Authentik PG"
PG_HOST_PORT_LOCAL="${PG_HOST_PORT:-5436}"
PAPERCLIP_DB_NAME="${PAPERCLIP_DB_NAME:-paperclip}"
# In host-net mode postgres listens on the host's PG_HOST_PORT (default 5436);
# in bridge mode the container listens on 5432 internally. docker exec runs
# in the container's network namespace, so use the matching port.
if [ "${AUTHENTIK_HOST_NET:-0}" = "1" ]; then
  PG_EXEC_PORT="$PG_HOST_PORT_LOCAL"
else
  PG_EXEC_PORT="5432"
fi
exists_count=$(PGPASSWORD="$PG_PASS" docker exec -e PGPASSWORD="$PG_PASS" \
  openclaw-authentik-postgres psql \
  -h 127.0.0.1 -p "$PG_EXEC_PORT" -U "$PG_USER" -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname='${PAPERCLIP_DB_NAME}'" \
  2>/dev/null | tr -d '[:space:]')
if [ "$exists_count" = "1" ]; then
  echo "   paperclip DB already exists"
else
  PGPASSWORD="$PG_PASS" docker exec -e PGPASSWORD="$PG_PASS" \
    openclaw-authentik-postgres psql \
    -h 127.0.0.1 -p "$PG_EXEC_PORT" -U "$PG_USER" -d postgres -c \
    "CREATE DATABASE \"${PAPERCLIP_DB_NAME}\"" >/dev/null
  echo "   created paperclip DB"
fi

# Write a connection string paperclip can pick up via DATABASE_URL.
# Lives next to the OIDC configs (mode 0600).
PAPERCLIP_DB_FILE="${OIDC_CONFIG_DIR}/paperclip-db.env"
umask 077
cat > "$PAPERCLIP_DB_FILE" <<EOF
DATABASE_URL=postgres://${PG_USER}:${PG_PASS}@127.0.0.1:${PG_HOST_PORT_LOCAL}/${PAPERCLIP_DB_NAME}
EOF
echo "   wrote $PAPERCLIP_DB_FILE"

echo ">> Authentik admin UI: ${AUTHENTIK_BASE_URL}/if/admin/"
echo "   username: akadmin"
echo "   password: see AUTHENTIK_BOOTSTRAP_PASSWORD in $ENV_FILE"
echo ">> OIDC client configs written to $OIDC_CONFIG_DIR/"
