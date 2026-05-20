#!/usr/bin/env bash
# Pulls the three build artifacts from the latest successful "build" workflow
# run on main, atomically swaps the `current` symlink for each component, and
# restarts the matching systemd unit. Idempotent and safe to re-run.
#
# Requires: gh CLI authenticated (GH_TOKEN env or `gh auth login`).
# Env knobs:
#   REPO          (default: WaromiV/sandbox)
#   STACK_ROOT    (default: /opt/openclaw-stack)
#   WORKFLOW      (default: build.yml)
#   BRANCH        (default: main)
#   SKIP_RESTART  (default: 0)

set -euo pipefail

REPO="${REPO:-WaromiV/sandbox}"
STACK_ROOT="${STACK_ROOT:-/opt/openclaw-stack}"
WORKFLOW="${WORKFLOW:-build.yml}"
BRANCH="${BRANCH:-main}"
SKIP_RESTART="${SKIP_RESTART:-0}"

COMPONENTS=(openclaw paperclip code-server)

log() { printf '[%(%H:%M:%S)T] %s\n' -1 "$*"; }
die() { echo "error: $*" >&2; exit 1; }

command -v gh >/dev/null   || die "gh CLI not installed"
command -v tar >/dev/null  || die "tar not installed"
command -v jq >/dev/null   || die "jq not installed"
gh auth status >/dev/null  || die "gh CLI not authenticated (set GH_TOKEN or run 'gh auth login')"

log "Looking up latest successful run of $WORKFLOW on $BRANCH in $REPO"
RUN_ID=$(gh run list --repo "$REPO" --workflow "$WORKFLOW" --branch "$BRANCH" \
           --status success --limit 1 --json databaseId --jq '.[0].databaseId')
[ -n "$RUN_ID" ] || die "no successful runs found"
log "run id: $RUN_ID"

STAGING=$(mktemp -d)
trap 'rm -rf "$STAGING"' EXIT

for comp in "${COMPONENTS[@]}"; do
  artifact="${comp}-dist"
  comp_root="$STACK_ROOT/$comp"
  release_dir="$comp_root/releases/$RUN_ID"
  current_link="$comp_root/current"

  if [ -d "$release_dir" ]; then
    log "[$comp] release $RUN_ID already on disk — skipping download"
  else
    log "[$comp] downloading $artifact from run $RUN_ID"
    gh run download "$RUN_ID" --repo "$REPO" --name "$artifact" --dir "$STAGING/$comp"
    tarball=$(ls "$STAGING/$comp"/*.tar.gz | head -1)
    [ -n "$tarball" ] || die "[$comp] no tarball in artifact"

    sudo mkdir -p "$release_dir"
    sudo tar -xzf "$tarball" -C "$release_dir"
    # paperclip runs as its own system user so the release tree (and the
    # parent containing the `current` symlink) must be owned by it.
    if [ "$comp" = "paperclip" ] && id paperclip >/dev/null 2>&1; then
      sudo chown -R paperclip:paperclip "$comp_root"
    fi
    log "[$comp] extracted to $release_dir"
  fi

  # Atomic symlink swap.
  tmp_link="$comp_root/current.tmp.$$"
  sudo ln -sfn "$release_dir" "$tmp_link"
  sudo mv -Tf "$tmp_link" "$current_link"
  log "[$comp] current -> $RUN_ID"
done

if [ "$SKIP_RESTART" = "1" ]; then
  log "SKIP_RESTART=1 — leaving systemd units alone"
  exit 0
fi

log "Restarting systemd units"
sudo systemctl daemon-reload
for comp in "${COMPONENTS[@]}"; do
  unit="${comp}.service"
  if systemctl list-unit-files "$unit" >/dev/null 2>&1 \
     && [ -n "$(systemctl list-unit-files --no-legend "$unit")" ]; then
    sudo systemctl restart "$unit"
    log "[$comp] restarted $unit"
  else
    log "[$comp] $unit not installed yet — skipping restart"
  fi
done

log "done. Prune old releases with:"
log "  find $STACK_ROOT/*/releases -mindepth 1 -maxdepth 1 -type d | sort | head -n -3 | xargs -r sudo rm -rf"
