#!/usr/bin/env bash
#
# stack-update.sh — "Update from OpenClaw UI" worker.
#
# Pulls the latest successful build.yml artifacts from the PUBLIC GitHub repo,
# deploys ONLY the components whose content hash changed (per-component git
# subtree digest published as a `<comp>-dist.rev` release sidecar), atomically
# repoints each component's `current` symlink — the path its systemd unit reads
# via WorkingDirectory — restarts just the changed units (openclaw LAST so the
# gateway's own restart doesn't kill this worker mid-flight), health-checks
# them, and rolls back the symlink + restart if a unit fails to come up.
#
# Scope is DISCOVERED at runtime per unit (system vs `systemctl --user`) and the
# stack layout is derived from each unit's WorkingDirectory, so it works for both
# the root/system cluster deploy and a user-scoped install. When the worker is
# not root and a privileged step is required (root-owned stack root, or a
# system-scoped daemon-reload/restart) it escalates via `sudo -A`, reading the
# operator password from $OPENCLAW_STACK_UPDATE_SUDO_PW_FILE (0600, unlinked
# immediately, validated up front, never logged or written to the status file).
#
# Progress is written to $STATUS_FILE after every phase; the gateway serves it
# back to the UI via GET <base>/update/status, which is what bridges the brief
# window where openclaw restarts itself.
#
# Env knobs (most are injected by the gateway launcher; all have safe defaults):
#   REPO            default WaromiV/sandbox
#   WORKFLOW        default build.yml
#   BRANCH          default main
#   COMPONENTS      default "openclaw paperclip code-server"
#   RUN_ID          pin a specific run; skips the "latest successful" API lookup
#   STACK_ROOT      override the release root (else derived from unit WorkingDirectory)
#   STATUS_FILE / DEPLOYED_FILE / LOCK_FILE   state paths (gateway-resolved)
#   OPENCLAW_<COMP>_UNIT                       override a unit name (COMP upper, - -> _)
#   OPENCLAW_STACK_UPDATE_LAUNCH               launch-method label for status
#   OPENCLAW_STACK_UPDATE_SUDO_PW_FILE         0600 file holding the sudo password
#   DRY_RUN=1       resolve + plan only; no downloads, swaps, restarts, or writes

set -uo pipefail # NOT -e: we must catch failures so rollback runs.

# --- config ----------------------------------------------------------------

REPO="${REPO:-WaromiV/sandbox}"
WORKFLOW="${WORKFLOW:-build.yml}"
BRANCH="${BRANCH:-main}"
DRY_RUN="${DRY_RUN:-0}"
LAUNCH_METHOD="${OPENCLAW_STACK_UPDATE_LAUNCH:-unknown}"
read -r -a ALL_COMPONENTS <<<"${COMPONENTS:-openclaw paperclip code-server}"

# Restart paperclip + code-server first; openclaw LAST so the gateway only kills
# itself once everything else is already swapped, restarted, and verified.
RESTART_ORDER=(paperclip code-server openclaw)

STATUS_FILE="${STATUS_FILE:-/opt/openclaw-stack/.update-status.json}"
DEPLOYED_FILE="${DEPLOYED_FILE:-/opt/openclaw-stack/.deployed.json}"
LOCK_FILE="${LOCK_FILE:-/opt/openclaw-stack/.update.lock}"

IS_ROOT=0
[ "$(id -u)" = "0" ] && IS_ROOT=1

# --- logging ---------------------------------------------------------------

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
warn() { printf '[%s] WARN %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
now() { date -u +%FT%TZ; }
is_dry() { [ "$DRY_RUN" = "1" ]; }

for tool in jq tar curl; do
  command -v "$tool" >/dev/null 2>&1 || {
    warn "required tool not found: $tool"
    exit 70
  }
done

# --- status bookkeeping (rendered fresh from globals on every write) --------

PHASE="running"
RUN_ID="${RUN_ID:-}"
STARTED_AT="$(now)"
COMPLETED_AT=""
ERROR_JSON="null"
ROLLBACK_JSON="null"
declare -A STATE=()     # comp -> pending|unchanged|validated|swapped|restarting|active|failed|rolled_back|skipped
declare -A FROM_RUN=()  # comp -> previously deployed run id
declare -A TO_RUN=()    # comp -> run id being deployed
CHANGED=()              # comps selected for update this run

render_components() {
  local json='{}' c
  for c in "${ALL_COMPONENTS[@]}"; do
    json=$(jq -c \
      --arg c "$c" \
      --arg state "${STATE[$c]:-pending}" \
      --arg fromRun "${FROM_RUN[$c]:-}" \
      --arg toRun "${TO_RUN[$c]:-}" \
      '.[$c] = {
         state: $state,
         fromRunId: (if $fromRun == "" then null else $fromRun end),
         toRunId:   (if $toRun   == "" then null else $toRun   end)
       }' <<<"$json") || return 1
  done
  printf '%s' "$json"
}

render_status() {
  local changed_json
  changed_json=$(printf '%s\n' "${CHANGED[@]:-}" | jq -R . | jq -s 'map(select(. != ""))') || changed_json='[]'
  jq -n \
    --argjson components "$(render_components)" \
    --argjson changed "$changed_json" \
    --arg phase "$PHASE" \
    --arg runId "$RUN_ID" \
    --arg launch "$LAUNCH_METHOD" \
    --argjson pid "$$" \
    --arg startedAt "$STARTED_AT" \
    --arg updatedAt "$(now)" \
    --arg completedAt "$COMPLETED_AT" \
    --argjson error "$ERROR_JSON" \
    --argjson rollback "$ROLLBACK_JSON" \
    '{
       schemaVersion: 1,
       phase: $phase,
       runId: (if $runId == "" then null else $runId end),
       launchMethod: $launch,
       pid: $pid,
       startedAt: $startedAt,
       updatedAt: $updatedAt,
       completedAt: (if $completedAt == "" then null else $completedAt end),
       changed: $changed,
       components: $components,
       error: $error,
       rollback: $rollback
     }'
}

write_status() {
  PHASE="$1"
  log "phase=$PHASE${RUN_ID:+ run=$RUN_ID}"
  is_dry && return 0
  local tmp rendered
  rendered=$(render_status) || {
    warn "status render failed"
    return 0
  }
  tmp="${STATUS_FILE}.tmp.$$"
  if printf '%s' "$rendered" >"$tmp" 2>/dev/null; then
    mv -f "$tmp" "$STATUS_FILE" 2>/dev/null || warn "could not move status into place"
    chmod 0644 "$STATUS_FILE" 2>/dev/null || true
  else
    warn "could not write status file $STATUS_FILE"
    rm -f "$tmp" 2>/dev/null || true
  fi
}

# Capture unexpected exits (set -u trips, kills) into a terminal error status so
# the UI never spins forever on a stale "running".
on_exit() {
  local code=$?
  if [ "$code" != "0" ] && [ "$PHASE" != "done" ] && [ "$PHASE" != "error" ]; then
    ERROR_JSON=$(jq -n --arg r "worker exited unexpectedly (code $code)" '{reason:$r}')
    write_status error
  fi
}
trap on_exit EXIT

fail() { # reason-string [error-json]
  ERROR_JSON="${2:-$(jq -n --arg r "$1" '{reason:$r}')}"
  COMPLETED_AT="$(now)"
  write_status error
  exit 1
}

# --- privilege escalation (sudo -A askpass; never argv, never logged) -------

SUDO_PW=""
ASKPASS=""
setup_privilege() {
  [ "$IS_ROOT" = "1" ] && return 0
  local pwfile="${OPENCLAW_STACK_UPDATE_SUDO_PW_FILE:-}"
  [ -n "$pwfile" ] && [ -r "$pwfile" ] || return 0
  SUDO_PW="$(cat "$pwfile" 2>/dev/null)"
  rm -f "$pwfile" 2>/dev/null || true
  [ -n "$SUDO_PW" ] || return 0
  # Askpass echoes the password from our (private) environment so it never lands
  # on argv and stdin stays free for piped `tar` input.
  ASKPASS="$(mktemp)"
  chmod 0700 "$ASKPASS"
  printf '#!/bin/sh\nprintf "%%s\\n" "$OPENCLAW_SUDO_PW"\n' >"$ASKPASS"
  export OPENCLAW_SUDO_PW="$SUDO_PW"
  export SUDO_ASKPASS="$ASKPASS"
}
cleanup_privilege() {
  [ -n "$ASKPASS" ] && rm -f "$ASKPASS" 2>/dev/null
  unset OPENCLAW_SUDO_PW SUDO_ASKPASS 2>/dev/null || true
}

have_sudo_password() { [ -n "$SUDO_PW" ]; }

# Run "$@" as root when needed: direct if already root, else via sudo -A.
as_root() {
  if [ "$IS_ROOT" = "1" ]; then
    "$@"
  else
    sudo -A -- "$@"
  fi
}

# --- unit / scope / layout discovery ---------------------------------------

declare -A UNIT=()        # comp -> unit name (e.g. openclaw.service)
declare -A SCOPE=()       # comp -> system|user|missing
declare -A CURRENT=()     # comp -> path of the `current` symlink (== unit WorkingDirectory)
declare -A REL_ROOT=()    # comp -> dir holding releases/ + current (dirname of CURRENT)
declare -A NEEDS_ROOT=()  # comp -> 1 if privileged (system scope or root-owned path) and we're non-root

unit_override() { # comp -> env override name or empty
  local key
  key="OPENCLAW_$(printf '%s' "$1" | tr '[:lower:]-' '[:upper:]_')_UNIT"
  printf '%s' "${!key:-}"
}

# Echo the WorkingDirectory for a unit in a given scope, empty if unset/missing.
unit_working_dir() { # scope unit
  if [ "$1" = "system" ]; then
    systemctl show -p WorkingDirectory --value "$2" 2>/dev/null
  else
    systemctl --user show -p WorkingDirectory --value "$2" 2>/dev/null
  fi
}

unit_exists() { # scope unit
  local frag
  if [ "$1" = "system" ]; then
    frag=$(systemctl show -p FragmentPath --value "$2" 2>/dev/null)
  else
    frag=$(systemctl --user show -p FragmentPath --value "$2" 2>/dev/null)
  fi
  [ -n "$frag" ]
}

# True if any existing ancestor of $1 is writable by us (so we can create $1).
path_writable() {
  local p="$1"
  while [ -n "$p" ] && [ ! -e "$p" ]; do p="$(dirname "$p")"; done
  [ -w "$p" ]
}

discover_comp() { # comp
  local comp="$1" candidates=() u scope="missing" wd
  local override
  override="$(unit_override "$comp")"
  if [ -n "$override" ]; then
    candidates=("$override")
  elif [ "$comp" = "openclaw" ]; then
    candidates=("openclaw.service" "openclaw-gateway.service" "openclawd.service")
  else
    candidates=("$comp.service")
  fi

  for u in "${candidates[@]}"; do
    if unit_exists system "$u"; then
      scope="system"
      UNIT[$comp]="$u"
      break
    elif unit_exists user "$u"; then
      scope="user"
      UNIT[$comp]="$u"
      break
    fi
  done
  SCOPE[$comp]="$scope"
  [ "$scope" = "missing" ] && {
    STATE[$comp]="skipped"
    return 1
  }

  wd="$(unit_working_dir "$scope" "${UNIT[$comp]}")"
  # Honor an explicit STACK_ROOT override; otherwise require the unit to follow
  # the `…/<comp>/current` symlink layout this updater repoints.
  if [ -n "${STACK_ROOT:-}" ]; then
    REL_ROOT[$comp]="$STACK_ROOT/$comp"
    CURRENT[$comp]="$STACK_ROOT/$comp/current"
  elif [ -n "$wd" ] && [ "$(basename "$wd")" = "current" ]; then
    CURRENT[$comp]="$wd"
    REL_ROOT[$comp]="$(dirname "$wd")"
  else
    warn "[$comp] unit ${UNIT[$comp]} ($scope) has no '…/current' WorkingDirectory — not updatable via symlink swap"
    STATE[$comp]="skipped"
    return 1
  fi

  if [ "$IS_ROOT" != "1" ] && { [ "$scope" = "system" ] || ! path_writable "${REL_ROOT[$comp]}"; }; then
    NEEDS_ROOT[$comp]=1
  else
    NEEDS_ROOT[$comp]=0
  fi
  STATE[$comp]="pending"
  log "[$comp] unit=${UNIT[$comp]} scope=$scope current=${CURRENT[$comp]} needsRoot=${NEEDS_ROOT[$comp]}"
  return 0
}

# --- systemctl per scope ----------------------------------------------------

sc_restart() { # comp
  local comp="$1" u="${UNIT[$1]}"
  if [ "${SCOPE[$comp]}" = "user" ]; then
    user_systemctl restart "$u"
  else
    as_root systemctl restart "$u"
  fi
}
sc_is_active() { # comp
  local comp="$1" u="${UNIT[$1]}"
  if [ "${SCOPE[$comp]}" = "user" ]; then
    systemctl --user is-active --quiet "$u"
  else
    as_root systemctl is-active --quiet "$u"
  fi
}
user_systemctl() { systemctl --user "$@"; }

daemon_reload_scopes() { # space-separated scopes present in changed set
  local scopes="$1"
  case "$scopes" in *system*) as_root systemctl daemon-reload ;; esac
  case "$scopes" in *user*) systemctl --user daemon-reload ;; esac
}

poll_is_active() { # comp timeout-seconds
  local comp="$1" deadline=$(($(date +%s) + ${2:-45}))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    sc_is_active "$comp" && return 0
    sleep 2
  done
  return 1
}

# --- content digest (sidecar is authoritative; local fallback) --------------

# Deterministic content hash of an extracted release tree. Used only when a CI
# `<comp>-dist.rev` sidecar is absent (older releases); the sidecar normally
# carries the per-component git subtree id and we compare that opaquely.
content_digest() { # dir
  (cd "$1" 2>/dev/null &&
    find . -type f -printf '%P\0' 2>/dev/null |
    LC_ALL=C sort -z | xargs -0 -r sha256sum 2>/dev/null |
    sha256sum | cut -d' ' -f1)
}

manifest_get_rev() { # comp
  jq -r --arg c "$1" '.components[$c].rev // ""' "$DEPLOYED_FILE" 2>/dev/null
}
manifest_get_run() { # comp
  jq -r --arg c "$1" '.components[$c].runId // ""' "$DEPLOYED_FILE" 2>/dev/null
}
manifest_set() { # comp runId rev
  is_dry && return 0
  local cur tmp
  cur=$(cat "$DEPLOYED_FILE" 2>/dev/null)
  [ -n "$cur" ] || cur='{"schemaVersion":1,"components":{}}'
  tmp="${DEPLOYED_FILE}.tmp.$$"
  jq --arg c "$1" --arg run "$2" --arg rev "$3" --arg at "$(now)" \
    '.schemaVersion = 1
     | .components[$c] = {runId:$run, rev:$rev, deployedAt:$at}' \
    <<<"$cur" >"$tmp" 2>/dev/null &&
    mv -f "$tmp" "$DEPLOYED_FILE" 2>/dev/null || {
    warn "could not update manifest for $1"
    rm -f "$tmp" 2>/dev/null
  }
}

# --- GitHub (public, unauthenticated) ---------------------------------------

GH_API="https://api.github.com"
GH_DL="https://github.com"
gh_curl() { curl -fsSL -H "User-Agent: openclaw-stack-update" -H "Accept: application/vnd.github+json" "$@"; }

resolve_run_id() {
  [ -n "$RUN_ID" ] && {
    log "using pinned RUN_ID=$RUN_ID"
    return 0
  }
  local url="$GH_API/repos/$REPO/actions/workflows/$WORKFLOW/runs?branch=$BRANCH&status=success&per_page=1"
  RUN_ID=$(gh_curl "$url" | jq -r '.workflow_runs[0].id // empty')
  [ -n "$RUN_ID" ] || fail "no successful $WORKFLOW run found on $BRANCH"
  log "latest successful run: $RUN_ID"
}

# Echo the candidate rev sidecar for a component (empty if absent).
fetch_sidecar_rev() { # comp
  curl -fsSL -H "User-Agent: openclaw-stack-update" \
    "$GH_DL/$REPO/releases/download/ci-$RUN_ID/$1-dist.rev" 2>/dev/null | tr -d '[:space:]'
}

# --- main -------------------------------------------------------------------

main() {
  # Concurrency: one updater at a time. The HTTP layer also fast-paths a 409.
  if ! is_dry; then
    exec 9>"$LOCK_FILE" 2>/dev/null || fail "cannot open lock $LOCK_FILE"
    flock -n 9 || {
      log "another update already holds the lock"
      exit 75
    }
  fi

  setup_privilege
  trap 'cleanup_privilege; on_exit' EXIT

  write_status running
  resolve_run_id

  # 1. Discover units / scope / layout.
  write_status discovering
  local comp updatable=()
  for comp in "${ALL_COMPONENTS[@]}"; do
    discover_comp "$comp" && updatable+=("$comp")
  done
  [ ${#updatable[@]} -gt 0 ] || fail "no updatable components found (no unit with a '…/current' layout)"

  # 2. Change detection by sidecar rev vs the deployed manifest.
  write_status checking
  CHANGED=()
  for comp in "${updatable[@]}"; do
    FROM_RUN[$comp]="$(manifest_get_run "$comp")"
    local cand cur
    cand="$(fetch_sidecar_rev "$comp")"
    cur="$(manifest_get_rev "$comp")"
    if [ -n "$cand" ] && [ "$cand" = "$cur" ] && [ -L "${CURRENT[$comp]}" ]; then
      STATE[$comp]="unchanged"
      log "[$comp] unchanged (rev=$cand)"
    else
      CHANGED+=("$comp")
    fi
  done
  if [ ${#CHANGED[@]} -eq 0 ]; then
    COMPLETED_AT="$(now)"
    write_status done
    log "nothing changed; no restarts"
    return 0
  fi
  log "changed: ${CHANGED[*]}"

  # Pre-flight the password BEFORE touching anything, so a wrong/missing
  # password fails cleanly with no half-applied state.
  local need_root=0
  for comp in "${CHANGED[@]}"; do [ "${NEEDS_ROOT[$comp]:-0}" = "1" ] && need_root=1; done
  if [ "$need_root" = "1" ]; then
    if ! have_sudo_password; then
      fail "needs_sudo_password" "$(jq -n '{reason:"needs_sudo_password", message:"This gateway is not root; a password is required to update system-scoped units."}')"
    fi
    if ! is_dry && ! sudo -A -v >/dev/null 2>&1; then
      fail "sudo_auth_failed" "$(jq -n '{reason:"sudo_auth_failed", message:"The provided password was rejected by sudo."}')"
    fi
  fi

  if is_dry; then
    log "DRY_RUN: would restart in order:"
    for comp in "${RESTART_ORDER[@]}"; do
      case " ${CHANGED[*]} " in *" $comp "*) log "  - $comp (${SCOPE[$comp]})" ;; esac
    done
    return 0
  fi

  # 3. Download + extract changed components (idempotent: skip if on disk).
  write_status downloading
  declare -A CAND_REV=() TO_REL=()
  for comp in "${CHANGED[@]}"; do
    local rel="${REL_ROOT[$comp]}/releases/$RUN_ID"
    TO_REL[$comp]="$rel"
    TO_RUN[$comp]="$RUN_ID"
    if [ -d "$rel" ] && [ -n "$(ls -A "$rel" 2>/dev/null)" ]; then
      log "[$comp] release $RUN_ID already on disk"
    else
      log "[$comp] downloading + extracting $comp-dist.tar.gz"
      if [ "${NEEDS_ROOT[$comp]:-0}" = "1" ]; then as_root mkdir -p "$rel"; else mkdir -p "$rel"; fi
      if [ "${NEEDS_ROOT[$comp]:-0}" = "1" ]; then
        curl -fsSL -H "User-Agent: openclaw-stack-update" \
          "$GH_DL/$REPO/releases/download/ci-$RUN_ID/$comp-dist.tar.gz" |
          as_root tar -xz -C "$rel" || fail "download/extract failed for $comp"
      else
        curl -fsSL -H "User-Agent: openclaw-stack-update" \
          "$GH_DL/$REPO/releases/download/ci-$RUN_ID/$comp-dist.tar.gz" |
          tar -xz -C "$rel" || fail "download/extract failed for $comp"
      fi
    fi

    # code-server wrapper imports lib/vscode/out/server-main.js; CI ships out as
    # a symlink, but fix it if a bare dir slipped through (mirrors fetch-artifacts.sh).
    if [ "$comp" = "code-server" ]; then
      local vsc="$rel/lib/vscode"
      if [ -d "$vsc/out-vscode-reh-web-min" ] && [ ! -L "$vsc/out" ] && [ ! -f "$vsc/out/server-main.js" ]; then
        as_root rm -rf "$vsc/out"
        (cd "$vsc" && as_root ln -s out-vscode-reh-web-min out)
      fi
    fi
    # paperclip runs as its own user; the release tree (and the dir holding the
    # `current` symlink) must be owned by it.
    if [ "$comp" = "paperclip" ] && id paperclip >/dev/null 2>&1; then
      as_root chown -R paperclip:paperclip "${REL_ROOT[$comp]}" 2>/dev/null || true
    fi

    # Effective rev: sidecar if present, else a local content digest so the
    # manifest stays comparable across runs even without a sidecar.
    CAND_REV[$comp]="$(fetch_sidecar_rev "$comp")"
    [ -n "${CAND_REV[$comp]}" ] || CAND_REV[$comp]="$(content_digest "$rel")"
  done

  # 4. Pre-swap validation — abort before touching any symlink.
  write_status validating
  declare -A ENTRY=([openclaw]=dist/index.js [paperclip]=server/dist/index.js [code-server]=out/node/entry.js)
  for comp in "${CHANGED[@]}"; do
    local entry="${ENTRY[$comp]:-}"
    if [ -n "$entry" ] && [ ! -f "${TO_REL[$comp]}/$entry" ]; then
      fail "validation_failed" "$(jq -n --arg c "$comp" --arg e "$entry" '{reason:"validation_failed", component:$c, message:("missing entrypoint "+$e)}')"
    fi
    STATE[$comp]="validated"
  done

  # 5. Capture old symlink targets, then atomic swap.
  write_status swapping
  declare -A OLD_TARGET=()
  for comp in "${CHANGED[@]}"; do
    local link="${CURRENT[$comp]}"
    OLD_TARGET[$comp]="$(readlink "$link" 2>/dev/null || true)"
    local tmp="$link.tmp.$$"
    if [ "${NEEDS_ROOT[$comp]:-0}" = "1" ]; then
      as_root ln -sfn "${TO_REL[$comp]}" "$tmp" && as_root mv -Tf "$tmp" "$link" || fail "swap failed for $comp"
    else
      ln -sfn "${TO_REL[$comp]}" "$tmp" && mv -Tf "$tmp" "$link" || fail "swap failed for $comp"
    fi
    STATE[$comp]="swapped"
    log "[$comp] current -> releases/$RUN_ID (was ${OLD_TARGET[$comp]:-none})"
  done

  # daemon-reload each scope present in the changed set.
  local scopes=""
  for comp in "${CHANGED[@]}"; do scopes="$scopes ${SCOPE[$comp]}"; done
  daemon_reload_scopes "$scopes"

  # 6. Restart changed units (openclaw LAST), health-poll, rollback on failure.
  for comp in "${RESTART_ORDER[@]}"; do
    case " ${CHANGED[*]} " in *" $comp "*) ;; *) continue ;; esac
    STATE[$comp]="restarting"
    write_status restarting
    sc_restart "$comp" || warn "[$comp] restart command returned non-zero"
    if poll_is_active "$comp" 45; then
      STATE[$comp]="active"
      manifest_set "$comp" "$RUN_ID" "${CAND_REV[$comp]}"
      log "[$comp] active"
    else
      STATE[$comp]="failed"
      write_status rolling_back
      local outcome="failed"
      if [ -n "${OLD_TARGET[$comp]:-}" ]; then
        local link="${CURRENT[$comp]}" tmp
        tmp="$link.rollback.$$"
        if [ "${NEEDS_ROOT[$comp]:-0}" = "1" ]; then
          as_root ln -sfn "${OLD_TARGET[$comp]}" "$tmp" && as_root mv -Tf "$tmp" "$link"
        else
          ln -sfn "${OLD_TARGET[$comp]}" "$tmp" && mv -Tf "$tmp" "$link"
        fi
        sc_restart "$comp" || true
        if poll_is_active "$comp" 45; then outcome="ok"; fi
        STATE[$comp]="rolled_back"
      else
        outcome="unavailable"
      fi
      ROLLBACK_JSON=$(jq -n --arg c "$comp" --arg o "$outcome" --arg r "${OLD_TARGET[$comp]:-}" \
        '{component:$c, outcome:$o, restoredTarget:(if $r=="" then null else $r end)}')
      ERROR_JSON=$(jq -n --arg c "$comp" '{reason:"unit_unhealthy", component:$c, message:"unit failed is-active after restart"}')
      COMPLETED_AT="$(now)"
      # Stop here: do not restart later components (notably openclaw) on a failure.
      write_status error
      exit 1
    fi
  done

  COMPLETED_AT="$(now)"
  write_status done
  log "done. updated: ${CHANGED[*]}"
}

main "$@"
