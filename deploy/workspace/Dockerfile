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

# Entrypoint: run the gateway + code-server side by side. State and workspace
# live on the /workspace volume so they survive restarts.
#
# The gateway keeps mode=none on LOOPBACK — the same no-built-in-auth model as
# the rest of the stack (the gate is paperclip's session proxy + Authentik at
# the edge). openclaw refuses `bind=lan` without auth, and its trusted-proxy
# mode forces a device-pairing dance on non-browser clients, so instead a tiny
# TCP forwarder exposes loopback:18789 as 0.0.0.0:18790 for docker's published
# port. Only paperclip (via 127.0.0.1-published host ports) can reach it.
# ponytail: node net one-liner instead of socat — nothing to install.
RUN printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'export OPENCLAW_HOME="${OPENCLAW_HOME:-/workspace/.openclaw}"' \
  'mkdir -p "$OPENCLAW_HOME"' \
  '# First boot: the gateway refuses to run unconfigured. Same bootstrap as' \
  '# upstream docker setup (idempotent).' \
  '# bind=loopback must be explicit: in containers openclaw defaults to auto' \
  '# (0.0.0.0), which it refuses to combine with auth=none.' \
  '# agents.defaults.workspace=/workspace: agents work in the same root the' \
  '# editor serves — "their workspace" is literally what code-server shows.' \
  'node /opt/openclaw/dist/index.js config set --batch-json '"'"'[{"path":"gateway.mode","value":"local"},{"path":"gateway.bind","value":"loopback"},{"path":"agents.defaults.workspace","value":"/workspace"}]'"'"' || true' \
  'node /opt/openclaw/dist/index.js gateway --bind loopback --auth none --port 18789 &' \
  'gw=$!' \
  'node -e '"'"'const net=require("net");net.createServer(c=>{const u=net.connect(18789,"127.0.0.1");c.pipe(u).pipe(c);c.on("error",()=>u.destroy());u.on("error",()=>c.destroy())}).listen(18790,"0.0.0.0")'"'"' &' \
  'fw=$!' \
  'code-server --auth none --bind-addr 0.0.0.0:8090 --locale ru --disable-update-check /workspace &' \
  'cs=$!' \
  'wait -n "$gw" "$fw" "$cs"' \
  'kill "$gw" "$fw" "$cs" 2>/dev/null || true' \
  'exit 1' \
  > /usr/local/bin/workspace-entrypoint \
  && chmod +x /usr/local/bin/workspace-entrypoint

# Unprivileged user owns the workspace volume — the isolation boundary.
RUN useradd -m -u 10001 worker && mkdir -p /workspace && chown worker:worker /workspace
USER worker
# Russian display language: language pack from Open VSX + --locale ru at start
# (see entrypoint). Baked into the image so every worker container ships ru.
RUN code-server --install-extension ms-ceintl.vscode-language-pack-ru
WORKDIR /workspace
VOLUME ["/workspace"]
EXPOSE 8090 18790
ENTRYPOINT ["/usr/local/bin/workspace-entrypoint"]
