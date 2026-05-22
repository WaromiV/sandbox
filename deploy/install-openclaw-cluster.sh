#!/usr/bin/env bash
# ============================================================================
#  OpenClaw Cluster Installer
#  Sudo-bound, single-file deployment script.
#
#  Brings up:
#    - Authentik (docker compose)               https://<domain>/
#    - paperclip + better-auth (systemd)        https://<domain>/issues
#    - patched code-server (systemd)            https://<domain>/editor
#    - openclaw gateway (systemd)               https://<domain>/openclaw
#    - Meridian (Claude Code SDK proxy)         127.0.0.1:3456 (local)
#    - nginx + Let's Encrypt TLS for <domain>
#
#  Notable contract:
#    - Deploy without a domain is UNSUPPORTED. The script refuses.
#    - Original openclaw source/binaries are NEVER touched. Only the
#      systemd unit for openclaw is replaced (existing unit is backed up).
#
#  Usage:
#    sudo bash deploy/install-openclaw-cluster.sh
#
#  Re-runs are safe — every step is idempotent.
# ============================================================================
set -Eeuo pipefail

# ---------------------------------------------------------------------------
#  Colors + section helpers
# ---------------------------------------------------------------------------
if [ -t 1 ]; then
  C_RESET=$'\033[0m';   C_BOLD=$'\033[1m';   C_DIM=$'\033[2m'
  C_RED=$'\033[31m';    C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m';   C_MAGENTA=$'\033[35m'; C_CYAN=$'\033[36m'
else
  C_RESET=""; C_BOLD=""; C_DIM=""
  C_RED=""; C_GREEN=""; C_YELLOW=""
  C_BLUE=""; C_MAGENTA=""; C_CYAN=""
fi

term_cols() {
  local c=0
  if [ -n "${COLUMNS:-}" ]; then c="$COLUMNS"; fi
  if [ "$c" -lt 10 ] && command -v tput >/dev/null 2>&1; then
    c="$(tput cols 2>/dev/null || echo 0)"
  fi
  [ "$c" -lt 10 ] && c=80
  printf '%d' "$c"
}
repeat_char() {
  local ch="$1" n="$2"
  [ "$n" -le 0 ] && return 0
  printf '%*s' "$n" "" | tr ' ' "$ch"
}

# Section banner — stretches a ━ rule across the terminal width.
banner() {
  local title="$*"
  local cols pad used
  cols="$(term_cols)"
  used=$(( ${#title} + 5 ))  # "━━━ " + title + " "
  pad=$(( cols - used ))
  [ "$pad" -lt 3 ] && pad=3
  printf "\n%b━━━ %s %s%b\n" \
    "${C_BOLD}${C_CYAN}" "$title" "$(repeat_char '━' "$pad")" "${C_RESET}"
}

# Boxed banner that auto-scales:
#   - cols >= 40 → drawn box, padded to min(cols, 76)
#   - cols <  40 → plain title + rule + indented body (no box, no truncation)
# Usage: draw_box "Title" "line one" "line two" ...
draw_box() {
  local title="$1"; shift
  local cols width inner
  cols="$(term_cols)"
  if [ "$cols" -lt 40 ]; then
    printf "\n%b%s%b\n" "${C_BOLD}${C_MAGENTA}" "$title" "${C_RESET}"
    printf '%s\n' "$(repeat_char '-' "$cols")"
    local line
    for line in "$@"; do
      printf '  %s\n' "$line"
    done
    printf '%s\n' "$(repeat_char '-' "$cols")"
    return
  fi
  width=$cols
  [ "$width" -gt 76 ] && width=76
  inner=$((width - 4))

  printf "%b" "${C_BOLD}${C_MAGENTA}"
  printf '╔%s╗\n' "$(repeat_char '═' $((width - 2)))"
  # centered title
  local tlen=${#title} lpad rpad
  if [ "$tlen" -gt "$inner" ]; then
    tlen=$inner
    title="${title:0:$inner}"
  fi
  lpad=$(( (inner - tlen) / 2 ))
  rpad=$(( inner - tlen - lpad ))
  printf '║ %s%s%s ║\n' "$(repeat_char ' ' "$lpad")" "$title" "$(repeat_char ' ' "$rpad")"
  printf '╠%s╣\n' "$(repeat_char '═' $((width - 2)))"

  local line
  for line in "$@"; do
    if [ -z "$line" ]; then
      printf '║ %s ║\n' "$(repeat_char ' ' "$inner")"
      continue
    fi
    if [ "${#line}" -le "$inner" ]; then
      printf '║ %s%s ║\n' "$line" "$(repeat_char ' ' $((inner - ${#line})))"
    else
      # word-wrap on whitespace; long unbreakable tokens get hard-cut at the edge
      local words cur w trial
      read -r -a words <<<"$line"
      cur=""
      for w in "${words[@]}"; do
        if [ -z "$cur" ]; then trial="$w"; else trial="$cur $w"; fi
        if [ "${#trial}" -le "$inner" ]; then
          cur="$trial"
        else
          if [ -n "$cur" ]; then
            printf '║ %s%s ║\n' "$cur" "$(repeat_char ' ' $((inner - ${#cur})))"
          fi
          # if a single word is wider than the box, hard-cut
          while [ "${#w}" -gt "$inner" ]; do
            printf '║ %s ║\n' "${w:0:$inner}"
            w="${w:$inner}"
          done
          cur="$w"
        fi
      done
      if [ -n "$cur" ]; then
        printf '║ %s%s ║\n' "$cur" "$(repeat_char ' ' $((inner - ${#cur})))"
      fi
    fi
  done
  printf '╚%s╝\n' "$(repeat_char '═' $((width - 2)))"
  printf "%b" "${C_RESET}"
}

sub()  { printf "%b ▸ %s%b\n" "${C_DIM}" "$*" "${C_RESET}"; }
step() { printf "%b➜%b %s\n" "${C_BLUE}" "${C_RESET}" "$*"; }
ok()   { printf "%b✓%b %s\n" "${C_GREEN}" "${C_RESET}" "$*"; }
warn() { printf "%b⚠ %s%b\n" "${C_YELLOW}" "$*" "${C_RESET}" >&2; }
err()  { printf "%b✗ %s%b\n" "${C_RED}${C_BOLD}" "$*" "${C_RESET}" >&2; }
die()  { err "$@"; exit 1; }

trap 'err "Install aborted at line $LINENO (exit $?)."' ERR

# ---------------------------------------------------------------------------
#  Sudo guard
# ---------------------------------------------------------------------------
if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  err "This installer must run as root via sudo."
  printf "  Run: %bsudo bash %s%b\n" "${C_BOLD}" "$0" "${C_RESET}"
  exit 1
fi

TARGET_USER="${SUDO_USER:-}"
if [ -z "$TARGET_USER" ] || [ "$TARGET_USER" = "root" ]; then
  die "Run via 'sudo' from your regular shell account so the script can attribute services to your user."
fi
TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
[ -d "$TARGET_HOME" ] || die "Cannot resolve home directory for $TARGET_USER"
TARGET_UID="$(id -u "$TARGET_USER")"

# Designed for the curl-into-sudo-bash distribution model — the script is a
# gist, no surrounding repo on disk. Everything lands under /opt/sandbox so
# systemd units have a stable absolute path. Override only if you really
# know why (re-deploys must match the prior layout).
SOURCE_DIR="${OPENCLAW_SOURCE_DIR:-/opt/sandbox}"

as_user() {
  # Run a command as the target user, with their HOME and a login env.
  sudo -u "$TARGET_USER" --preserve-env=PATH -H bash -lc "$*"
}

# ---------------------------------------------------------------------------
#  Opening banner + consent
# ---------------------------------------------------------------------------
draw_box "OpenClaw Cluster Installer" \
  "Designed for: curl -fsSL <gist> | sudo bash" \
  "" \
  "This script will, with sudo privileges:" \
  "" \
  "  • Install nginx, certbot, docker, jq, curl, git, gh, openssl" \
  "  • Create $SOURCE_DIR/ and populate it with prebuilt artifacts" \
  "    (deploy/, openclaw/, paperclip/, code-server/) pulled from" \
  "    the WaromiV/sandbox CI — no source build on the target" \
  "  • Bring up Authentik (docker compose)" \
  "  • Replace systemd units for openclaw, paperclip, code-server" \
  "    (existing units are backed up to <name>.service.bak.<epoch>)" \
  "  • Configure nginx + Let's Encrypt TLS for the domain you give" \
  "  • Install Claude CLI from claude.ai/install.sh and have you" \
  "    sign in interactively (60s timeout with auto-retry)" \
  "  • Install Meridian (@rynfar/meridian) and wire it as the" \
  "    Anthropic backend for openclaw" \
  "" \
  "Required: a public domain pointed at this host (UNSUPPORTED" \
  "          without one)." \
  "Required: GitHub authentication to pull the private CI artifacts." \
  "          Either: sudo GITHUB_TOKEN=ghp_... bash <(curl ...)" \
  "          or the script will prompt you to paste a PAT." \
  "" \
  "Press ENTER to continue, Ctrl-C to cancel."
read -r _ < /dev/tty || true

sub "Target user:   ${C_BOLD}${TARGET_USER}${C_RESET}${C_DIM} (home: ${TARGET_HOME})"
sub "Source repo:   ${C_BOLD}${SOURCE_DIR}${C_RESET}"

# ---------------------------------------------------------------------------
#  Domain + ACME email
# ---------------------------------------------------------------------------
banner "Domain"

DOMAIN="${OPENCLAW_DOMAIN:-}"
if [ -z "$DOMAIN" ]; then
  printf "%bEnter the public domain pointing to this host (e.g. openclaw.example.com): %b" \
    "${C_BOLD}" "${C_RESET}"
  read -r DOMAIN < /dev/tty
fi
DOMAIN="$(printf '%s' "$DOMAIN" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
case "$DOMAIN" in
  ""|skip|none|localhost|127.0.0.1|0.0.0.0|"::1")
    die "Deploy without a domain is UNSUPPORTED. Re-run with a real public domain (e.g. openclaw.example.com)."
    ;;
esac
if ! printf '%s' "$DOMAIN" | grep -Eq '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'; then
  die "Invalid domain syntax: $DOMAIN"
fi
ok "Domain: ${C_BOLD}$DOMAIN${C_RESET}"

ACME_EMAIL="${OPENCLAW_ACME_EMAIL:-}"
if [ -z "$ACME_EMAIL" ]; then
  printf "%bEnter contact email for Let's Encrypt: %b" "${C_BOLD}" "${C_RESET}"
  read -r ACME_EMAIL < /dev/tty
fi
ACME_EMAIL="$(printf '%s' "$ACME_EMAIL" | tr -d '[:space:]')"
[ -n "$ACME_EMAIL" ] || die "ACME contact email is required."

# ---------------------------------------------------------------------------
#  Distro + package install
# ---------------------------------------------------------------------------
banner "Dependencies"

ID="unknown"; ID_LIKE=""
if [ -f /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
fi
case " ${ID:-} ${ID_LIKE:-} " in
  *" debian "*|*" ubuntu "*)               PM="apt" ;;
  *" arch "*|*" manjaro "*|*" endeavouros "*) PM="pacman" ;;
  *" fedora "*|*" rhel "*|*" centos "*|*" rocky "*|*" almalinux "*) PM="dnf" ;;
  *) die "Unsupported distro (ID=${ID:-?}). Supported: debian/ubuntu, arch, fedora/rhel." ;;
esac
sub "Package manager: ${C_BOLD}${PM}${C_RESET}"

case "$PM" in
  apt)
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq \
      nginx certbot python3-certbot-nginx \
      docker.io docker-compose-v2 \
      curl jq git openssl ca-certificates \
      nodejs npm
    ;;
  pacman)
    pacman -Sy --noconfirm --needed \
      nginx certbot certbot-nginx \
      docker docker-compose \
      curl jq git openssl ca-certificates \
      nodejs npm
    ;;
  dnf)
    dnf install -y \
      nginx certbot python3-certbot-nginx \
      docker docker-compose-plugin \
      curl jq git openssl ca-certificates \
      nodejs npm
    ;;
esac
ok "OS packages installed"

# Compose plugin or standalone — figure out the right invocation
DOCKER_COMPOSE="docker compose"
if ! docker compose version >/dev/null 2>&1; then
  if command -v docker-compose >/dev/null 2>&1; then
    DOCKER_COMPOSE="docker-compose"
  else
    die "Neither 'docker compose' nor 'docker-compose' is usable after install."
  fi
fi
sub "Compose: ${C_BOLD}${DOCKER_COMPOSE}${C_RESET}"

systemctl enable --now docker
ok "Docker enabled"

# pnpm + corepack — paperclip's prod systemd unit runs `pnpm dev`
if ! command -v pnpm >/dev/null 2>&1; then
  step "Installing pnpm via corepack"
  corepack enable >/dev/null 2>&1 || true
  corepack prepare pnpm@latest --activate >/dev/null 2>&1 || npm install -g pnpm
fi
sub "pnpm: $(command -v pnpm) ($(pnpm --version 2>/dev/null || echo '?'))"

# gh CLI — we use it to pull prebuilt artifacts from the sandbox build
# workflow. Install the official Linux tarball (cross-distro, no third-party
# apt repos / GPG keyring shenanigans).
if ! command -v gh >/dev/null 2>&1; then
  step "Installing gh CLI"
  case "$(uname -m)" in
    x86_64) GH_ARCH=amd64 ;;
    aarch64|arm64) GH_ARCH=arm64 ;;
    *) die "Unsupported arch for gh CLI: $(uname -m)" ;;
  esac
  GH_VER="$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest \
            | jq -r '.tag_name' | sed 's/^v//')"
  [ -n "$GH_VER" ] && [ "$GH_VER" != "null" ] || die "Failed to fetch latest gh release"
  GH_TMP="$(mktemp -d)"
  curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VER}/gh_${GH_VER}_linux_${GH_ARCH}.tar.gz" \
    -o "$GH_TMP/gh.tar.gz"
  tar -xzf "$GH_TMP/gh.tar.gz" -C "$GH_TMP"
  install -m 0755 "$GH_TMP/gh_${GH_VER}_linux_${GH_ARCH}/bin/gh" /usr/local/bin/gh
  rm -rf "$GH_TMP"
fi
sub "gh: $(command -v gh) ($(gh --version 2>/dev/null | head -1))"

# Claude CLI and Meridian are installed up-front as the target user so the
# systemd ExecStart paths we write later resolve to real binaries.
step "Installing Claude CLI for $TARGET_USER (if missing)"
as_user "command -v claude >/dev/null 2>&1 || curl -fsSL https://claude.ai/install.sh | bash" \
  || die "Claude CLI install failed"

step "Installing @rynfar/meridian for $TARGET_USER (if missing)"
as_user 'command -v meridian >/dev/null 2>&1 || npm install -g @rynfar/meridian' \
  || die "Meridian install failed"

resolve_user_bin() {
  # Resolve a binary path that exists in $TARGET_USER's PATH or known locations.
  local bin="$1" out
  out="$(as_user "command -v $bin" 2>/dev/null || true)"
  if [ -z "$out" ]; then
    for cand in "$TARGET_HOME/.local/bin/$bin" "$TARGET_HOME/.npm-global/bin/$bin" "/usr/local/bin/$bin"; do
      if [ -x "$cand" ]; then out="$cand"; break; fi
    done
  fi
  printf '%s' "$out"
}

CLAUDE_BIN="$(resolve_user_bin claude)"
[ -n "$CLAUDE_BIN" ] || die "claude binary not found after install"
MERIDIAN_BIN="$(resolve_user_bin meridian)"
[ -n "$MERIDIAN_BIN" ] || die "meridian binary not found after install"
sub "claude:   ${C_BOLD}${CLAUDE_BIN}${C_RESET}"
sub "meridian: ${C_BOLD}${MERIDIAN_BIN}${C_RESET}"

# ---------------------------------------------------------------------------
#  Prebuilt artifacts from the sandbox build workflow
#
#  We pull openclaw-dist / paperclip-dist / code-server-dist from the latest
#  successful run of WaromiV/sandbox build.yml (overridable). This replaces
#  the multi-hour in-place build entirely. Authentication uses gh; either:
#   - $GITHUB_TOKEN env var (script logs gh in with it for $TARGET_USER), or
#   - an existing 'gh auth login' as $TARGET_USER
# ---------------------------------------------------------------------------
banner "Artifacts"

ARTIFACT_REPO="${OPENCLAW_ARTIFACT_REPO:-WaromiV/sandbox}"
ARTIFACT_BRANCH="${OPENCLAW_ARTIFACT_BRANCH:-main}"
ARTIFACT_WORKFLOW="${OPENCLAW_ARTIFACT_WORKFLOW:-build.yml}"
ARTIFACT_RUN_ID="${OPENCLAW_ARTIFACT_RUN_ID:-}"
sub "repo:     ${C_BOLD}${ARTIFACT_REPO}${C_RESET}"
sub "branch:   ${C_BOLD}${ARTIFACT_BRANCH}${C_RESET}"
sub "workflow: ${C_BOLD}${ARTIFACT_WORKFLOW}${C_RESET}"

# Authenticate gh as $TARGET_USER. Preference order:
#   1. GITHUB_TOKEN already in the (sudo-preserved) env
#   2. Existing 'gh auth login' from a prior run (idempotent re-runs)
#   3. Interactive prompt for a PAT (gist-pipe friendly)
# Token is fed to gh via stdin so it never lands in /proc/<pid>/cmdline or
# the bash history.
authenticate_gh() {
  if as_user 'gh auth status --hostname github.com' >/dev/null 2>&1; then
    return 0
  fi
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    step "Logging gh in with GITHUB_TOKEN (target: $TARGET_USER)"
    printf '%s' "$GITHUB_TOKEN" \
      | sudo -u "$TARGET_USER" -H gh auth login --hostname github.com --git-protocol https --with-token
    return $?
  fi
  warn "The sandbox repo + CI artifacts are private. gh needs a personal access token."
  warn "Create one at: https://github.com/settings/tokens/new?scopes=repo,read:org"
  printf "%bPaste a GitHub PAT (input hidden): %b" "${C_BOLD}" "${C_RESET}"
  local tok
  read -rs tok < /dev/tty
  echo
  [ -n "$tok" ] || die "Empty token. Aborting."
  printf '%s' "$tok" \
    | sudo -u "$TARGET_USER" -H gh auth login --hostname github.com --git-protocol https --with-token
}
authenticate_gh || die "gh auth login failed"
sub "gh auth: $(as_user 'gh auth status --hostname github.com 2>&1 | head -1' || echo unknown)"

# Resolve the run id we'll pull from. Preference order:
#   1. OPENCLAW_ARTIFACT_RUN_ID env (explicit pin)
#   2. successful run whose headSha matches the local HEAD (drift-free)
#   3. latest successful run on $ARTIFACT_BRANCH
if [ -z "$ARTIFACT_RUN_ID" ]; then
  LOCAL_SHA="$(cd "$SOURCE_DIR" && git rev-parse HEAD 2>/dev/null || true)"
  if [ -n "$LOCAL_SHA" ]; then
    step "Searching for a successful run matching local HEAD ($LOCAL_SHA)"
    ARTIFACT_RUN_ID="$(as_user "gh run list --repo='$ARTIFACT_REPO' --workflow='$ARTIFACT_WORKFLOW' --status=success --limit=20 --json databaseId,headSha -q '[.[] | select(.headSha==\"$LOCAL_SHA\")] | .[0].databaseId' " 2>/dev/null || true)"
  fi
  if [ -z "$ARTIFACT_RUN_ID" ] || [ "$ARTIFACT_RUN_ID" = "null" ]; then
    step "Falling back to latest successful run on $ARTIFACT_BRANCH"
    ARTIFACT_RUN_ID="$(as_user "gh run list --repo='$ARTIFACT_REPO' --workflow='$ARTIFACT_WORKFLOW' --branch='$ARTIFACT_BRANCH' --status=success --limit=1 --json databaseId -q '.[0].databaseId'" || true)"
  fi
fi
[ -n "$ARTIFACT_RUN_ID" ] && [ "$ARTIFACT_RUN_ID" != "null" ] \
  || die "No successful build run found on $ARTIFACT_REPO ($ARTIFACT_WORKFLOW @ $ARTIFACT_BRANCH)."

RUN_META="$(as_user "gh run view '$ARTIFACT_RUN_ID' --repo='$ARTIFACT_REPO' --json headSha,createdAt,displayTitle,url" 2>/dev/null || echo '{}')"
RUN_SHA="$(printf '%s' "$RUN_META" | jq -r '.headSha // "?"')"
RUN_URL="$(printf '%s' "$RUN_META" | jq -r '.url // ""')"
ok "Using run ${C_BOLD}${ARTIFACT_RUN_ID}${C_RESET} (sha: ${RUN_SHA:0:8})"
[ -n "$RUN_URL" ] && sub "$RUN_URL"

if [ -n "${LOCAL_SHA:-}" ] && [ -n "$RUN_SHA" ] && [ "$RUN_SHA" != "?" ] && [ "$LOCAL_SHA" != "$RUN_SHA" ]; then
  warn "Local HEAD (${LOCAL_SHA:0:8}) does not match the artifact's commit (${RUN_SHA:0:8})."
  warn "Source files for paperclip/code-server will be OVERWRITTEN with the artifact's snapshot."
  warn "To deploy your local commit instead: push it, wait for build.yml to go green, re-run."
fi

ART_DOWNLOAD_DIR="$SOURCE_DIR/.artifact-cache"
install -d -o "$TARGET_USER" -g "$TARGET_GROUP" -m 0755 "$ART_DOWNLOAD_DIR"

# Layout — sandbox-deploy is rooted at the repo top (so its tar contains
# ./deploy/*) while the three service tarballs are rooted at the subdir's
# top (their tars are openclaw/paperclip/code-server contents directly).
# Reflect that in the extraction target so paths line up.
declare -A ARTIFACT_TO_TARGET=(
  [sandbox-deploy]="$SOURCE_DIR"
  [openclaw-dist]="$SOURCE_DIR/openclaw"
  [paperclip-dist]="$SOURCE_DIR/paperclip"
  [code-server-dist]="$SOURCE_DIR/code-server"
)

# Order matters: sandbox-deploy first so the Authentik provisioner is on
# disk by the time we need it; service tarballs after.
ARTIFACT_ORDER=(sandbox-deploy openclaw-dist paperclip-dist code-server-dist)

install -d -o "$TARGET_USER" -g "$TARGET_GROUP" -m 0755 "$SOURCE_DIR"

for artifact in "${ARTIFACT_ORDER[@]}"; do
  target="${ARTIFACT_TO_TARGET[$artifact]}"
  stamp="$target/.artifact-${artifact}-run-${ARTIFACT_RUN_ID}"
  if [ -f "$stamp" ]; then
    ok "$artifact already at run $ARTIFACT_RUN_ID — skipping"
    continue
  fi
  step "Downloading $artifact"
  art_dir="$ART_DOWNLOAD_DIR/$artifact"
  rm -rf "$art_dir"
  as_user "gh run download '$ARTIFACT_RUN_ID' --repo='$ARTIFACT_REPO' -n '$artifact' -D '$art_dir'" \
    || die "gh run download failed for $artifact"
  tarball="$(find "$art_dir" -maxdepth 2 -name '*.tar.gz' | head -1)"
  [ -n "$tarball" ] || die "Expected a .tar.gz inside $art_dir, found nothing"
  step "Extracting into $target"
  install -d -o "$TARGET_USER" -g "$TARGET_GROUP" -m 0755 "$target"
  # --no-same-owner avoids 'failed to set ownership' warnings when running
  # as root extracting files owned by the CI runner's uid/gid.
  tar -xzf "$tarball" --no-same-owner -C "$target"
  chown -R "$TARGET_USER:$TARGET_GROUP" "$target"
  printf '%s\n%s\n' "run_id=$ARTIFACT_RUN_ID" "head_sha=$RUN_SHA" > "$stamp"
  chown "$TARGET_USER:$TARGET_GROUP" "$stamp"
  ok "$artifact extracted ($(du -sh "$target" 2>/dev/null | cut -f1))"
done

# Sanity-check the layout the rest of the script depends on.
[ -x "$SOURCE_DIR/deploy/authentik/provision.sh" ]       || die "sandbox-deploy missing deploy/authentik/provision.sh"
[ -f "$SOURCE_DIR/openclaw/dist/index.js" ]              || die "openclaw artifact missing dist/index.js"
[ -f "$SOURCE_DIR/code-server/out/node/entry.js" ]       || die "code-server artifact missing out/node/entry.js"
[ -d "$SOURCE_DIR/paperclip/node_modules" ]              || die "paperclip artifact missing node_modules"

# ---------------------------------------------------------------------------
#  Authentik — first bring-up with PLACEHOLDER local URLs (TLS not ready yet)
# ---------------------------------------------------------------------------
banner "Authentik bring-up"

AK_ENV="$SOURCE_DIR/deploy/authentik/.env"
if [ ! -f "$AK_ENV" ]; then
  step "Seeding $AK_ENV"
  AK_PASS="$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)"
  AK_TOK="$(openssl rand -hex 32)"
  AK_SECRET="$(openssl rand -hex 32)"
  PG_PW="$(openssl rand -hex 24)"
  cat >"$AK_ENV" <<EOF
AUTHENTIK_BOOTSTRAP_EMAIL=$ACME_EMAIL
AUTHENTIK_BOOTSTRAP_PASSWORD=$AK_PASS
AUTHENTIK_BOOTSTRAP_TOKEN=$AK_TOK
AUTHENTIK_SECRET_KEY=$AK_SECRET
PG_PASS=$PG_PW
HOST_BIND_HTTP=127.0.0.1:9000
PG_HOST_PORT=5436
EOF
  chmod 600 "$AK_ENV"
  chown "$TARGET_USER:$TARGET_USER" "$AK_ENV"
  ok "Wrote new Authentik .env (mode 0600)"
else
  ok "Reusing existing $AK_ENV"
fi

# First provision run — uses temporary local URLs because TLS isn't installed
# yet. We re-provision with the public domain after certbot succeeds.
step "Initial Authentik bring-up (local URLs)"
as_user "cd '$SOURCE_DIR' && AUTHENTIK_HTTP_PORT=9000 \
  PAPERCLIP_BASE_URL='http://127.0.0.1:3110' \
  CODESERVER_BASE_URL='http://127.0.0.1:8090' \
  OPENCLAW_BASE_URL='http://127.0.0.1:18789' \
  bash deploy/authentik/provision.sh" >/dev/null
ok "Authentik provisioned (HTTP)"

# ---------------------------------------------------------------------------
#  nginx server block + Let's Encrypt
# ---------------------------------------------------------------------------
banner "nginx + TLS"

# Distros differ on conf layout. We write to /etc/nginx/conf.d which is
# included by both Debian and RHEL family defaults.
NGINX_DIR=/etc/nginx
[ -d "$NGINX_DIR/conf.d" ] || mkdir -p "$NGINX_DIR/conf.d"
NGINX_SITE="$NGINX_DIR/conf.d/openclaw-cluster.conf"

step "Writing $NGINX_SITE"
cat > "$NGINX_SITE" <<NGX
# Managed by deploy/install-openclaw-cluster.sh.
# Layout:
#   /            → Authentik (SSO entry, registration, admin UI, OIDC)
#   /issues      → paperclip (app)
#   /editor      → code-server (admin-only, proxied through paperclip)
#   /openclaw    → openclaw gateway
#
# paperclip API namespaces (/api/auth, /api/access, /api/admin, etc.) are
# peeled off as more-specific matches so they don't fall into Authentik.

map \$http_upgrade \$connection_upgrade {
  default upgrade;
  ''      close;
}

server {
  listen 80;
  listen [::]:80;
  server_name $DOMAIN;
  # certbot's HTTP-01 challenge writes here; everything else 301s to https.
  location /.well-known/acme-challenge/ { root /var/www/letsencrypt; }
  location / { return 301 https://\$host\$request_uri; }
}

server {
  listen 443 ssl http2;
  listen [::]:443 ssl http2;
  server_name $DOMAIN;

  # ssl_certificate and ssl_certificate_key are injected by certbot below.
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_ciphers HIGH:!aNULL:!MD5;

  client_max_body_size 200m;
  proxy_http_version 1.1;
  proxy_buffering off;
  proxy_read_timeout 86400;

  proxy_set_header Host \$host;
  proxy_set_header X-Real-IP \$remote_addr;
  proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto \$scheme;
  proxy_set_header X-Forwarded-Host \$host;
  proxy_set_header Upgrade \$http_upgrade;
  proxy_set_header Connection \$connection_upgrade;

  # ----- paperclip API namespaces (must match BEFORE Authentik's /api/v3) -
  location ^~ /api/auth          { proxy_pass http://127.0.0.1:3110; }
  location ^~ /api/access        { proxy_pass http://127.0.0.1:3110; }
  location ^~ /api/admin         { proxy_pass http://127.0.0.1:3110; }
  location ^~ /api/oidc-providers{ proxy_pass http://127.0.0.1:3110; }
  location ^~ /api/health        { proxy_pass http://127.0.0.1:3110; }
  location ^~ /api/agents        { proxy_pass http://127.0.0.1:3110; }
  location ^~ /api/companies     { proxy_pass http://127.0.0.1:3110; }
  location ^~ /api/issues        { proxy_pass http://127.0.0.1:3110; }
  location ^~ /api/goals         { proxy_pass http://127.0.0.1:3110; }
  location ^~ /api/projects      { proxy_pass http://127.0.0.1:3110; }
  location ^~ /api/secrets       { proxy_pass http://127.0.0.1:3110; }
  location ^~ /api/llms          { proxy_pass http://127.0.0.1:3110; }
  location ^~ /api/instance      { proxy_pass http://127.0.0.1:3110; }
  location ^~ /api/openclaw      { proxy_pass http://127.0.0.1:3110; }

  # ----- paperclip UI surfaces ------------------------------------------
  location ^~ /issues  { proxy_pass http://127.0.0.1:3110; }
  location ^~ /assets/ { proxy_pass http://127.0.0.1:3110; }
  location = /favicon.ico { proxy_pass http://127.0.0.1:3110; access_log off; }

  # ----- code-server through paperclip /editor proxy --------------------
  location ^~ /editor  { proxy_pass http://127.0.0.1:3110; }

  # ----- openclaw gateway -----------------------------------------------
  location /openclaw/ {
    rewrite ^/openclaw/(.*)\$ /\$1 break;
    proxy_pass http://127.0.0.1:18789;
  }
  location = /openclaw {
    return 301 /openclaw/;
  }

  # ----- Authentik (catch-all at root) ----------------------------------
  location / {
    proxy_pass http://127.0.0.1:9000;
  }
}
NGX

mkdir -p /var/www/letsencrypt
nginx -t
systemctl enable nginx >/dev/null
systemctl reload nginx 2>/dev/null || systemctl restart nginx
ok "nginx config valid + reloaded (HTTP only so far)"

step "Requesting Let's Encrypt certificate for $DOMAIN"
if certbot certificates 2>/dev/null | grep -q "Certificate Name: $DOMAIN"; then
  ok "Certificate already present for $DOMAIN — renewing if needed"
  certbot renew --nginx --non-interactive --quiet || warn "certbot renew returned non-zero (likely not yet due)"
else
  certbot --nginx --non-interactive --agree-tos \
    -m "$ACME_EMAIL" -d "$DOMAIN" --redirect \
    || die "certbot failed. Make sure DNS for $DOMAIN A/AAAA points to this host and ports 80/443 are reachable from the public internet."
fi
ok "TLS certificate active for $DOMAIN"

# ---------------------------------------------------------------------------
#  Authentik reprovision with the public domain
# ---------------------------------------------------------------------------
banner "Authentik — reprovision with public URLs"

step "Re-running provisioner with https://$DOMAIN as the base URL"
as_user "cd '$SOURCE_DIR' && AUTHENTIK_HTTP_PORT=9000 \
  PAPERCLIP_BASE_URL='https://$DOMAIN' \
  CODESERVER_BASE_URL='https://$DOMAIN/editor' \
  OPENCLAW_BASE_URL='https://$DOMAIN/openclaw' \
  bash deploy/authentik/provision.sh" >/dev/null
ok "Authentik OIDC providers point at https://$DOMAIN"

# ---------------------------------------------------------------------------
#  EnvironmentFiles for the systemd units
# ---------------------------------------------------------------------------
banner "systemd units"

ENV_DIR=/etc/openclaw-cluster
mkdir -p "$ENV_DIR"
chmod 0755 "$ENV_DIR"

# Per-service env files. Owned by root, readable by group of target user
# so the unit can EnvironmentFile= them without leaking to other users.
TARGET_GROUP="$(id -gn "$TARGET_USER")"

write_env() {
  local path="$1" body="$2"
  printf '%s' "$body" > "$path"
  chmod 0640 "$path"
  chown "root:$TARGET_GROUP" "$path"
}

BRIDGE_SECRET_FILE="$TARGET_HOME/.openclaw/bridge.secret"
if [ ! -f "$BRIDGE_SECRET_FILE" ]; then
  install -d -o "$TARGET_USER" -g "$TARGET_GROUP" -m 0700 "$TARGET_HOME/.openclaw"
  as_user "openssl rand -hex 32 > '$BRIDGE_SECRET_FILE' && chmod 600 '$BRIDGE_SECRET_FILE'"
fi

# Keep BETTER_AUTH_SECRET stable across re-runs.
if [ -f "$ENV_DIR/paperclip.env" ] && grep -q '^BETTER_AUTH_SECRET=' "$ENV_DIR/paperclip.env"; then
  BA_SECRET="$(grep '^BETTER_AUTH_SECRET=' "$ENV_DIR/paperclip.env" | cut -d= -f2-)"
else
  BA_SECRET="$(openssl rand -hex 48)"
fi

write_env "$ENV_DIR/openclaw.env" "\
NODE_ENV=production
HOME=$TARGET_HOME
OPENCLAW_GATEWAY_PORT=18789
# Send openclaw's Anthropic traffic through Meridian (Claude Max session).
ANTHROPIC_API_KEY=meridian
ANTHROPIC_BASE_URL=http://127.0.0.1:3456
"

PAPERCLIP_DB_ENV_FILE="$TARGET_HOME/.openclaw/oidc/paperclip-db.env"
DATABASE_URL_LINE=""
if [ -f "$PAPERCLIP_DB_ENV_FILE" ]; then
  # Provisioner already wrote DATABASE_URL=postgres://... pointing at the
  # Authentik PG cluster. Inline it so paperclip.service is self-contained.
  DATABASE_URL_LINE="$(grep '^DATABASE_URL=' "$PAPERCLIP_DB_ENV_FILE" | head -1)"
fi

write_env "$ENV_DIR/paperclip.env" "\
NODE_ENV=production
HOME=$TARGET_HOME
PORT=3110
PAPERCLIP_LISTEN_HOST=127.0.0.1
PAPERCLIP_LISTEN_PORT=3110
PAPERCLIP_PUBLIC_URL=https://$DOMAIN
PAPERCLIP_ALLOWED_HOSTNAMES=$DOMAIN
PAPERCLIP_EDITOR_UPSTREAM=http://127.0.0.1:8090
PAPERCLIP_BRIDGE_SECRET_FILE=$BRIDGE_SECRET_FILE
CODE_SERVER_PORT=8090
BETTER_AUTH_SECRET=$BA_SECRET
${DATABASE_URL_LINE}
"

write_env "$ENV_DIR/code-server.env" "\
HOME=$TARGET_HOME
"

write_env "$ENV_DIR/meridian.env" "\
HOME=$TARGET_HOME
MERIDIAN_HOST=127.0.0.1
MERIDIAN_PORT=3456
"

# ---------------------------------------------------------------------------
#  Write unit files (backing up existing ones, never deleting the binaries)
# ---------------------------------------------------------------------------
write_unit() {
  local name="$1" body="$2"
  local path="/etc/systemd/system/${name}.service"
  if [ -f "$path" ]; then
    local ts="$(date +%s)"
    cp -a "$path" "${path}.bak.${ts}"
    sub "Backed up existing $path → ${path}.bak.${ts}"
  fi
  printf '%s' "$body" > "$path"
  ok "Wrote $path"
}

PNPM_BIN="$(command -v pnpm)"
NODE_BIN="$(command -v node)"
# CLAUDE_BIN + MERIDIAN_BIN were resolved up-front under Dependencies.

write_unit openclaw "[Unit]
Description=OpenClaw gateway
After=network-online.target docker.service
Wants=network-online.target
[Service]
Type=simple
User=$TARGET_USER
Group=$TARGET_GROUP
WorkingDirectory=$SOURCE_DIR/openclaw
EnvironmentFile=$ENV_DIR/openclaw.env
ExecStart=$NODE_BIN dist/index.js gateway --bind lan --port \${OPENCLAW_GATEWAY_PORT}
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
[Install]
WantedBy=multi-user.target
"

write_unit paperclip "[Unit]
Description=Paperclip server (UI + better-auth + editor proxy)
After=network-online.target openclaw.service
[Service]
Type=simple
User=$TARGET_USER
Group=$TARGET_GROUP
WorkingDirectory=$SOURCE_DIR/paperclip
EnvironmentFile=$ENV_DIR/paperclip.env
ExecStart=$PNPM_BIN dev --authenticated-private --bind loopback
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
"

write_unit code-server "[Unit]
Description=code-server (patched, OIDC-gated, admin-only)
After=network-online.target paperclip.service
[Service]
Type=simple
User=$TARGET_USER
Group=$TARGET_GROUP
WorkingDirectory=$SOURCE_DIR
EnvironmentFile=$ENV_DIR/code-server.env
ExecStart=$NODE_BIN $SOURCE_DIR/code-server/out/node/entry.js --auth oidc --oidc-config-file $TARGET_HOME/.openclaw/oidc/codeserver.json --bind-addr 127.0.0.1:8090 --disable-update-check
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
"

write_unit meridian "[Unit]
Description=Meridian — Claude Code SDK ⇄ Anthropic API proxy
After=network-online.target
[Service]
Type=simple
User=$TARGET_USER
Group=$TARGET_GROUP
WorkingDirectory=$TARGET_HOME
EnvironmentFile=$ENV_DIR/meridian.env
ExecStart=$MERIDIAN_BIN
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
"

systemctl daemon-reload

# ---------------------------------------------------------------------------
#  Enable + start all four units
# ---------------------------------------------------------------------------
banner "Starting services"

for unit in openclaw paperclip code-server meridian; do
  systemctl enable "$unit" >/dev/null
  systemctl restart "$unit"
  sleep 1
  if systemctl is-active --quiet "$unit"; then
    ok "$unit is active"
  else
    warn "$unit failed to start cleanly — see: journalctl -u $unit -n 100"
  fi
done

# ---------------------------------------------------------------------------
#  Claude CLI interactive login (60s retry loop)
# ---------------------------------------------------------------------------
banner "Claude login"

CRED_FILE="$TARGET_HOME/.claude/.credentials.json"

claude_authed() {
  [ -f "$CRED_FILE" ] && jq -e '.claudeAiOauth.accessToken' "$CRED_FILE" >/dev/null 2>&1
}

if claude_authed; then
  ok "Claude is already authenticated for $TARGET_USER (skipping login)"
else
  warn "Claude not yet logged in. Launching 'claude auth login' interactively."
  warn "Complete the OAuth flow in the browser that opens."
  warn "If 60s pass with no login, the CLI is killed and re-launched."

  attempts=0
  while ! claude_authed; do
    attempts=$((attempts + 1))
    step "Attempt $attempts — opening 'claude auth login' as $TARGET_USER"
    sudo -u "$TARGET_USER" -H "$CLAUDE_BIN" auth login --claudeai </dev/tty >/dev/tty 2>&1 &
    LOGIN_PID=$!
    end=$(( $(date +%s) + 60 ))
    while [ "$(date +%s)" -lt "$end" ]; do
      if claude_authed; then
        kill -TERM "$LOGIN_PID" 2>/dev/null || true
        break
      fi
      if ! kill -0 "$LOGIN_PID" 2>/dev/null; then
        break  # claude exited on its own
      fi
      sleep 2
    done
    if ! claude_authed; then
      warn "Login window elapsed (or claude exited) without credentials — restarting…"
      kill -TERM "$LOGIN_PID" 2>/dev/null || true
      wait "$LOGIN_PID" 2>/dev/null || true
    fi
    # safety valve: don't loop forever
    if [ "$attempts" -ge 10 ]; then
      die "Claude login did not complete after 10 attempts. Run 'claude auth login' manually as $TARGET_USER and re-run this script."
    fi
  done
  ok "Claude logged in (creds: $CRED_FILE)"
fi

# Bounce meridian so it re-reads ~/.claude/.credentials.json with the new token.
systemctl restart meridian
ok "meridian restarted to pick up fresh Claude credentials"

# Smoke checks (loopback + the public domain over HTTPS)
sleep 4
banner "Health"
check() {
  local label="$1" url="$2"
  local code
  code=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 5 "$url" || echo "000")
  if [ "$code" = "000" ]; then
    warn "$label → no response ($url)"
  else
    sub "$label → HTTP $code ($url)"
  fi
}
check "Authentik (loopback)"  "http://127.0.0.1:9000/-/health/ready/"
check "paperclip  (loopback)" "http://127.0.0.1:3110/api/health"
check "openclaw   (loopback)" "http://127.0.0.1:18789/healthz"
check "code-server(loopback)" "http://127.0.0.1:8090/"
check "Meridian   (loopback)" "http://127.0.0.1:3456/telemetry"
check "Public domain"         "https://$DOMAIN/-/health/ready/"

# ---------------------------------------------------------------------------
#  Summary banner — copy-pasteable for a non-technical operator
# ---------------------------------------------------------------------------
AK_PASS_VAL="$(grep '^AUTHENTIK_BOOTSTRAP_PASSWORD=' "$AK_ENV" | cut -d= -f2-)"
AK_TOK_VAL="$(grep '^AUTHENTIK_BOOTSTRAP_TOKEN=' "$AK_ENV" | cut -d= -f2-)"

banner "All set"

printf "%b%s✓ Cluster is live at https://%s%b\n\n" "${C_BOLD}${C_GREEN}" "" "$DOMAIN" "${C_RESET}"
cat <<EOF
${C_BOLD}Open these in your browser:${C_RESET}

  ${C_CYAN}https://${DOMAIN}/${C_RESET}                                 # Sign in / register (Authentik)
  ${C_CYAN}https://${DOMAIN}/if/admin/${C_RESET}                        # Authentik admin UI
  ${C_CYAN}https://${DOMAIN}/if/flow/initial-setup/${C_RESET}           # First-time setup if not yet done

${C_BOLD}Once signed in:${C_RESET}

  ${C_CYAN}https://${DOMAIN}/issues${C_RESET}                           # Paperclip
  ${C_CYAN}https://${DOMAIN}/editor${C_RESET}                           # code-server (admin only)
  ${C_CYAN}https://${DOMAIN}/openclaw${C_RESET}                         # OpenClaw gateway

${C_BOLD}Authentik bootstrap credentials${C_RESET}
${C_DIM}(stored at: ${AK_ENV}, mode 0600)${C_RESET}

  username : ${C_BOLD}${C_CYAN}akadmin${C_RESET}
  password : ${C_BOLD}${C_CYAN}${AK_PASS_VAL}${C_RESET}
  api token: ${C_BOLD}${C_CYAN}${AK_TOK_VAL}${C_RESET}

  To re-read at any time:
    ${C_DIM}\$${C_RESET} sudo cat "${AK_ENV}"

${C_BOLD}Meridian (Claude Max → Anthropic API proxy)${C_RESET}

  Listening:    127.0.0.1:3456 (loopback only)
  Telemetry:    http://127.0.0.1:3456/telemetry
  openclaw is wired to it via ${ENV_DIR}/openclaw.env (ANTHROPIC_BASE_URL).
  Claude creds: ${CRED_FILE}  (owned by ${TARGET_USER})

${C_BOLD}Deployed build${C_RESET}

  CI run    : ${C_CYAN}${ARTIFACT_RUN_ID}${C_RESET}
  Commit    : ${C_CYAN}${RUN_SHA}${C_RESET}
  Run URL   : ${C_CYAN}${RUN_URL}${C_RESET}

  Per-service stamp files at <service>/.artifact-run-${ARTIFACT_RUN_ID}.
  Re-runs are no-ops unless OPENCLAW_ARTIFACT_RUN_ID is overridden.

${C_BOLD}Service management${C_RESET}

  systemctl status   openclaw paperclip code-server meridian
  journalctl -u <unit> -f          # tail logs
  systemctl restart  <unit>

  Original (pre-install) systemd units, if any, are kept as
  /etc/systemd/system/<name>.service.bak.<epoch> — re-enable with:
    sudo mv /etc/systemd/system/openclaw.service.bak.* /etc/systemd/system/openclaw.service
    sudo systemctl daemon-reload && sudo systemctl restart openclaw

${C_BOLD}Rollback${C_RESET}

  sudo systemctl disable --now openclaw paperclip code-server meridian
  sudo rm /etc/nginx/conf.d/openclaw-cluster.conf && sudo systemctl reload nginx
  # Authentik docker stack:
  ${DOCKER_COMPOSE} -f "${SOURCE_DIR}/deploy/authentik/docker-compose.yml" down

EOF

trap - ERR
