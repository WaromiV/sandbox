#!/usr/bin/env bash
# Create a test user in Authentik for the OIDC e2e smoke test.
#
#   ./create-sample-user.sh [username] [password] [email]
#
# Idempotent: if the user already exists, just resets the password.
# Uses the bootstrap token from deploy/authentik/.env. Authentik must be up.
set -euo pipefail

USERNAME="${1:-claudetest}"
PASSWORD="${2:-Sandbox-Smoke-2026!}"
EMAIL="${3:-claudetest@local.test}"

HERE="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="$HERE/deploy/authentik/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "!! $ENV_FILE missing — run bring-up.sh first" >&2
  exit 1
fi
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

BASE="http://127.0.0.1:9000"
H_AUTH="Authorization: Bearer ${AUTHENTIK_BOOTSTRAP_TOKEN}"
H_TYPE="Content-Type: application/json"

# 1. Look up existing user
pk="$(curl -sS -H "$H_AUTH" "$BASE/api/v3/core/users/?username=$(printf '%s' "$USERNAME" | jq -sRr @uri)" \
  | jq -r '.results[0].pk // empty')"

if [ -z "$pk" ]; then
  echo ">> creating user $USERNAME"
  pk="$(curl -sS -H "$H_AUTH" -H "$H_TYPE" -X POST "$BASE/api/v3/core/users/" \
    --data "$(jq -nc --arg u "$USERNAME" --arg e "$EMAIL" --arg n "$USERNAME" \
      '{username:$u, name:$n, email:$e, is_active:true, path:"users", groups:[]}')" \
    | jq -r '.pk')"
  if [ -z "$pk" ] || [ "$pk" = "null" ]; then
    echo "!! failed to create user" >&2
    exit 1
  fi
else
  echo ">> user $USERNAME exists (pk=$pk) — resetting password"
fi

# 2. Set password
curl -sS -H "$H_AUTH" -H "$H_TYPE" -X POST "$BASE/api/v3/core/users/$pk/set_password/" \
  --data "$(jq -nc --arg p "$PASSWORD" '{password:$p}')" \
  | jq -r '.detail // "password set"'

echo ""
echo ">> sample user ready:"
echo "   username: $USERNAME"
echo "   password: $PASSWORD"
echo "   email:    $EMAIL"
echo "   admin UI: $BASE/if/admin/"
