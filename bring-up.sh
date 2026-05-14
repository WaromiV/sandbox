#!/usr/bin/env bash
# Brings up openclaw + paperclip + code-server natively (no docker required)
# Logs to ./logs/, opens each URL via xdg-open
cd "$(dirname "$0")"
mkdir -p logs

OC_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
PC_PORT="${PAPERCLIP_PORT:-3100}"
CS_PORT="${CODE_SERVER_PORT:-8080}"

echo "=== Tool versions ==="
node -v 2>&1 || true
pnpm -v 2>&1 || true
which code-server 2>&1 || true

# --- openclaw gateway (uses prebuilt dist/) ---
if [ -f openclaw/dist/index.js ]; then
  echo "=== Starting openclaw gateway on :$OC_PORT ==="
  (cd openclaw && nohup node dist/index.js gateway --bind lan --port "$OC_PORT" >../logs/openclaw.log 2>&1 & echo "openclaw pid=$!")
else
  echo "!! openclaw/dist/index.js not found — needs build (pnpm install && pnpm build inside openclaw/)"
fi

# --- paperclip (pnpm dev — serves at :3100) ---
if [ -d paperclip ]; then
  echo "=== Starting paperclip dev on :$PC_PORT ==="
  if [ ! -d paperclip/node_modules ]; then
    (cd paperclip && pnpm install >../logs/paperclip-install.log 2>&1) || echo "!! paperclip install failed (see logs/paperclip-install.log)"
  fi
  (cd paperclip && nohup pnpm dev >../logs/paperclip.log 2>&1 & echo "paperclip pid=$!")
fi

# --- code-server ---
if command -v code-server >/dev/null 2>&1; then
  echo "=== Starting code-server on :$CS_PORT ==="
  nohup code-server --auth none --bind-addr "127.0.0.1:$CS_PORT" >logs/code-server.log 2>&1 & echo "code-server pid=$!"
elif [ -f code-server/out/node/entry.js ]; then
  echo "=== Starting code-server from source on :$CS_PORT ==="
  (cd code-server && nohup node out/node/entry.js --auth none --bind-addr "127.0.0.1:$CS_PORT" >../logs/code-server.log 2>&1 & echo "code-server pid=$!")
else
  echo "!! code-server not installed and source isn't built. Try: curl -fsSL https://code-server.dev/install.sh | sh"
fi

sleep 3
echo "=== Status ==="
for url in "http://localhost:$OC_PORT/healthz" "http://localhost:$PC_PORT/api/health" "http://localhost:$CS_PORT/"; do
  printf "%-40s -> " "$url"
  curl -s -o /dev/null -w "HTTP %{http_code}\n" --max-time 2 "$url" || echo "no response"
done

echo "=== Opening in browser via xdg-open ==="
for url in "http://localhost:$OC_PORT" "http://localhost:$PC_PORT" "http://localhost:$CS_PORT"; do
  (xdg-open "$url" >/dev/null 2>&1 &)
  echo "opened $url"
done

echo "Done. Logs in ./logs/. To stop: pkill -f 'openclaw|paperclip|code-server'"
