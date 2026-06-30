# Per-user workspace image: openclaw gateway + code-server on a /workspace
# volume. Both run with NO built-in auth — the only gate is the edge
# (Authentik forward-auth at nginx + paperclip's per-user proxy). One
# container per human worker. See deploy/install-openclaw-cluster.sh and
# paperclip server/src/services/workspace-containers/.
#
# Build context = repo root (openclaw must be built first). The repo-root
# .dockerignore narrows the context to openclaw/ only — it also bypasses
# openclaw/.dockerignore (which would drop node_modules/dist):
#   docker build -f deploy/workspace/Dockerfile -t openclaw-workspace:latest .
FROM node:22-bookworm

# code-server via its official installer — native, not vendored into the image.
RUN curl -fsSL https://code-server.dev/install.sh | sh

# openclaw prebuilt artifact (paths relative to the repo-root build context).
COPY openclaw/package.json /opt/openclaw/package.json
COPY openclaw/node_modules /opt/openclaw/node_modules
COPY openclaw/dist /opt/openclaw/dist

# Entrypoint: run the gateway + code-server side by side, both auth-less. State
# and workspace live on the /workspace volume so they survive restarts. --bind
# lan so the gateway listens on the container interface (published port).
RUN printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'export OPENCLAW_HOME="${OPENCLAW_HOME:-/workspace/.openclaw}"' \
  'mkdir -p "$OPENCLAW_HOME"' \
  'node /opt/openclaw/dist/index.js gateway --bind lan --auth none --port 18789 &' \
  'gw=$!' \
  'code-server --auth none --bind-addr 0.0.0.0:8090 --disable-update-check /workspace &' \
  'cs=$!' \
  'wait -n "$gw" "$cs"' \
  'kill "$gw" "$cs" 2>/dev/null || true' \
  'exit 1' \
  > /usr/local/bin/workspace-entrypoint \
  && chmod +x /usr/local/bin/workspace-entrypoint

# Unprivileged user owns the workspace volume — the isolation boundary.
RUN useradd -m -u 10001 worker && mkdir -p /workspace && chown worker:worker /workspace
USER worker
WORKDIR /workspace
VOLUME ["/workspace"]
EXPOSE 8090 18789
ENTRYPOINT ["/usr/local/bin/workspace-entrypoint"]
