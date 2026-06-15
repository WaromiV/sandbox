# Sandbox cluster — agent guide

Root rules for the openclaw + paperclip + code-server + Authentik stack. Scoped
`AGENTS.md` files (e.g. `openclaw/AGENTS.md`, `paperclip/AGENTS.md`) own their
subtrees; this file owns cross-service policy, and the **auth model** below.

## Topology

Single host. In dev (`bring-up.sh`) everything binds `127.0.0.1`; in prod
(`deploy/install-openclaw-cluster.sh`) nginx + Let's Encrypt front one domain.

| Service     | Port    | Browser-facing? | Built-in auth |
| ----------- | ------- | --------------- | ------------- |
| paperclip   | `:3110` | yes             | yes — Authentik OIDC client + role authority (owns the users table) |
| code-server | `:8090` | via reverse proxy `/editor` | **none** (`--auth none`, loopback) |
| openclaw    | `:18789`| via reverse proxy `/openclaw` | **none** (`--auth none`, loopback) |
| Authentik   | `:9000` | yes             | the IdP itself |

## Auth model

**openclaw and code-server have NO built-in auth.** They run with `--auth none`
bound to loopback. The ONLY thing gating them is **Authentik forward-auth** at
the reverse proxy. Do not re-introduce per-service auth (no HMAC bridge tokens,
no per-service OIDC clients for these two) — that was removed deliberately.

- **paperclip** is the exception: it keeps its own Authentik **OIDC client**
  (browser session) and remains the **role authority** (`GET /api/access/role`,
  admin/user). It is not stripped of auth.
- **Authentik** issues a single domain-level **forward-auth proxy provider**
  (`openclaw-forward-auth`), assigned to the embedded outpost, which serves
  `/outpost.goauthentik.io/auth/nginx`. The reverse proxy calls it via
  `auth_request` on `/editor` and `/openclaw`. Provisioned by
  `deploy/authentik/provision.sh`.
- Default policy: any authenticated Authentik user passes. To restrict a path
  (e.g. editor = shell access = admins only), bind a group policy to the
  `openclaw-forward-auth` application in the Authentik admin UI. Do not try to
  enforce roles inside openclaw/code-server — they have no auth layer any more.

Why this shape: the editor is full shell on the host and the gateway is the
backend; centralizing the gate in Authentik (instead of per-service tokens or
OIDC clients) means one place to reason about access. paperclip stays a real
OIDC client because it owns identity and the role DB.

### Reverse proxy is mandatory for openclaw + code-server

Because those two have no auth, exposing their ports directly = unauthenticated
shell + gateway access. They MUST sit behind a proxy that enforces the
Authentik forward-auth subrequest. Prod wires this automatically. **Dev
(`bring-up.sh`) does NOT stand up nginx** — in dev the two services are reachable
on loopback with no gate; that's acceptable on a single-user dev box but never
on anything reachable by others.

### Manual nginx config (dev / custom hosts)

`bring-up.sh` intentionally does not manage nginx. To gate the dev services
exactly like prod, drop this in an nginx server block (after `./bring-up.sh` is
up and Authentik has been provisioned). Adjust `server_name` / TLS to taste.

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

server {
  listen 443 ssl;
  server_name your-host.example.com;     # or localhost for a self-signed dev cert
  # ssl_certificate / ssl_certificate_key ...

  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header X-Forwarded-Host $host;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection $connection_upgrade;

  # paperclip API + UI (its own OIDC session — NOT forward-auth gated).
  location ^~ /api/   { proxy_pass http://127.0.0.1:3110; }
  location ^~ /issues { proxy_pass http://127.0.0.1:3110; }
  location ^~ /assets/{ proxy_pass http://127.0.0.1:3110; }

  # --- Authentik embedded outpost: forward-auth subrequest target ---
  location /outpost.goauthentik.io {
    proxy_pass              http://127.0.0.1:9000/outpost.goauthentik.io;
    proxy_set_header        Host $host;
    proxy_set_header        X-Original-URL $scheme://$http_host$request_uri;
    add_header              Set-Cookie $auth_cookie;
    auth_request_set        $auth_cookie $upstream_http_set_cookie;
    proxy_pass_request_body off;
    proxy_set_header        Content-Length "";
  }
  location @goauthentik_signin {
    internal;
    add_header Set-Cookie $auth_cookie;
    return 302 /outpost.goauthentik.io/start?rd=$scheme://$http_host$request_uri;
  }

  # --- code-server (no auth) gated by Authentik forward-auth ---
  # Prefix stripped: code-server emits relative URLs (relativeRoot in
  # code-server/src/node/http.ts) that resolve under /editor/ in the browser.
  location ^~ /editor/ {
    auth_request     /outpost.goauthentik.io/auth/nginx;
    error_page       401 = @goauthentik_signin;
    auth_request_set $auth_cookie $upstream_http_set_cookie;
    add_header       Set-Cookie $auth_cookie;
    auth_request_set $ak_user $upstream_http_x_authentik_username;
    proxy_set_header X-authentik-username $ak_user;
    proxy_set_header X-Forwarded-Prefix /editor;
    rewrite ^/editor/(.*)$ /$1 break;
    proxy_pass http://127.0.0.1:8090;
  }
  location = /editor { return 301 /editor/; }

  # --- openclaw gateway (no auth) gated by Authentik forward-auth ---
  location /openclaw/ {
    auth_request     /outpost.goauthentik.io/auth/nginx;
    error_page       401 = @goauthentik_signin;
    auth_request_set $auth_cookie $upstream_http_set_cookie;
    add_header       Set-Cookie $auth_cookie;
    auth_request_set $ak_user $upstream_http_x_authentik_username;
    proxy_set_header X-authentik-username $ak_user;
    rewrite ^/openclaw/(.*)$ /$1 break;
    proxy_pass http://127.0.0.1:18789;
  }
  location = /openclaw { return 301 /openclaw/; }

  # Authentik catch-all (login flows, admin UI, OIDC).
  location / { proxy_pass http://127.0.0.1:9000; }
}
```

`deploy/install-openclaw-cluster.sh` writes the production equivalent of this
block (with TLS and the paperclip API namespaces enumerated) — keep the two in
sync when you change one.

## paperclip ⇄ openclaw bridge

paperclip mirrors openclaw's agent roster over a WebSocket (`OPENCLAW_GATEWAY_URL`).
The gateway runs `--auth none`, so **no `OPENCLAW_GATEWAY_TOKEN` is needed** — only
the URL. The per-agent `pcp_…` paperclip API keys the bridge stages into agent
workspaces are minted by paperclip and are unrelated to gateway auth.
