<!-- Banner -->
<p align="center">
  <img src="assets/banner.svg" alt="Sandbox — a self-hosted AI-agent workspace" width="100%" />
</p>

<!-- Badges -->
<p align="center">
  <a href="https://github.com/WaromiV/sandbox/actions/workflows/build.yml">
    <img alt="Build" src="https://img.shields.io/github/actions/workflow/status/WaromiV/sandbox/build.yml?branch=main&style=for-the-badge&logo=githubactions&logoColor=white&label=build">
  </a>
  <a href="#-license">
    <img alt="License" src="https://img.shields.io/badge/license-MIT-3b82f6?style=for-the-badge">
  </a>
  <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A5%2022.16-3c873a?style=for-the-badge&logo=nodedotjs&logoColor=white">
  <img alt="pnpm" src="https://img.shields.io/badge/pnpm-11-f69220?style=for-the-badge&logo=pnpm&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178c6?style=for-the-badge&logo=typescript&logoColor=white">
</p>

<p align="center">
  <img alt="OpenClaw" src="https://img.shields.io/badge/gateway-OpenClaw-fb923c?style=flat-square">
  <img alt="Paperclip" src="https://img.shields.io/badge/orchestrator-Paperclip-f472b6?style=flat-square">
  <img alt="code-server" src="https://img.shields.io/badge/editor-code--server-34d399?style=flat-square">
  <img alt="Authentik SSO" src="https://img.shields.io/badge/SSO-Authentik%20OIDC-818cf8?style=flat-square">
  <a href="https://github.com/WaromiV/sandbox/commits/main"><img alt="Last commit" src="https://img.shields.io/github/last-commit/WaromiV/sandbox?style=flat-square&color=8b96a8"></a>
  <img alt="PRs welcome" src="https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square">
</p>

<p align="center">
  <b>Sandbox</b> bundles three open-source projects into one self-hosted AI-agent workspace and brings them all up with a single command.<br/>
  <a href="#-quick-start"><b>Quick start</b></a> ·
  <a href="#-whats-inside"><b>What's inside</b></a> ·
  <a href="#-architecture"><b>Architecture</b></a> ·
  <a href="#-single-sign-on"><b>SSO</b></a> ·
  <a href="#-deploy-to-a-server"><b>Deploy</b></a> ·
  <a href="#-updating"><b>Update</b></a>
</p>

---

## ⚡ Quick start

**You need:** Linux/macOS · [Node](https://nodejs.org) ≥ 22.16 · [pnpm](https://pnpm.io) 11 (`corepack enable`) · [Docker](https://docs.docker.com/engine/) (only for the SSO layer) · `git`, `curl`, `openssl`.

```bash
# 1. Clone
git clone https://github.com/WaromiV/sandbox.git
cd sandbox

# 2. Build the two app services (code-server ships prebuilt)
( cd openclaw  && pnpm install && pnpm build )
( cd paperclip && pnpm install && pnpm build )

# 3. Bring up the whole cluster — gateway + UI + editor (+ Authentik SSO)
./bring-up.sh
```

`bring-up.sh` generates secrets, provisions Authentik, starts every service, health-checks each URL, and opens your browser at **Paperclip** — the only door you walk through:

| Service        | URL                              | Notes                                          |
| -------------- | -------------------------------- | ---------------------------------------------- |
| 📎 **Paperclip**   | <http://127.0.0.1:3110>          | Browser-facing UI · role authority             |
| `</>` code-server  | proxied at `/editor/`            | Loopback-only; reached *through* Paperclip      |
| 🦞 OpenClaw        | <http://127.0.0.1:18789/healthz> | Backend gateway (server-to-server)             |
| 🔐 Authentik       | <http://127.0.0.1:9000>          | Identity provider (OIDC)                       |

```bash
# Skip the SSO stack entirely (no Docker needed):
USE_AUTHENTIK=0 ./bring-up.sh

# Stop everything:
pkill -f 'openclaw|paperclip|code-server'
```

> **Logs** stream to `./logs/`. The shared bridge secret lives at `~/.openclaw/bridge.secret` — keep it private.

---

## 🧩 What's inside

Sandbox is the integration layer. The product is what these three pieces become *together*: an assistant that does the work, an orchestrator that runs the company, and an editor where it all happens.

| | Component | Role | Port |
|---|---|---|---|
| 🦞 | **[OpenClaw](openclaw/)** | Multi-channel AI gateway — *the employee*. Talks to you on the channels you already use and executes work. | `:18789` |
| 📎 | **[Paperclip](paperclip/)** | Node + React orchestration UI — *the company*. Org charts, budgets, goals, and agent coordination. Owns the user/role DB and is the **only browser-facing service**. | `:3110` |
| `</>` | **[code-server](code-server/)** | Patched VS Code in the browser — *the workbench*. Loopback-only; surfaced through Paperclip's `/editor/` proxy. | `:8090` |
| 🔐 | **[Authentik](deploy/authentik/)** | Self-hosted OIDC identity provider — single sign-on across all three. | `:9000` |

> **If OpenClaw is an _employee_, Paperclip is the _company_** — and code-server is the desk they share.

---

## 🏗 Architecture

Single host, everything on `127.0.0.1`, no reverse proxy in dev. Your browser only ever connects to **Paperclip**; it proxies the editor and calls the gateway server-to-server.

```
                                ┌──────────────────────────┐
                                │   🔐 Authentik (OIDC IdP) │  :9000
                                └────────────┬─────────────┘
                       silent SSO bounce ····│···· (3 independent clients)
              ┌──────────────────────────────┼──────────────────────────────┐
              ▼                               ▼                              ▼
   ┌─────────────────────┐        ┌──────────────────────┐       ┌────────────────────┐
   │  🌐  Your browser   │ ─────▶ │  📎  Paperclip  :3110 │ ────▶ │ </> code-server     │ :8090
   └─────────────────────┘        │  • role authority     │  HMAC │     (loopback only) │
                                   │  • /editor/ proxy     │ /OIDC └────────────────────┘
                                   │  • user + role DB     │
                                   └───────────┬───────────┘
                                  server-to-server (bearer token)
                                               ▼
                                   ┌──────────────────────┐
                                   │  🦞  OpenClaw  :18789 │  multi-channel gateway
                                   └──────────────────────┘
```

**Roles:** `admin` and `user`. The first person to ever sign in becomes `admin` (race-safe singleton bootstrap); everyone else defaults to `user` and is promoted by an admin. Paperclip is the source of truth — the other services consult `GET /api/access/role`.

---

## 🔐 Single sign-on

Sandbox is migrating from HMAC **bridge tokens** to real **OIDC SSO** via [Authentik](https://goauthentik.io/) (MIT, self-hosted). Every service is its own *independent* OIDC client — not a delegation chain — so a shared session is just Authentik's IdP session: hit a second service and you land without a second login prompt.

The migration ships in **five independently-deployable phases** (each is reversible):

| Phase | Scope | Status |
|:-----:|-------|--------|
| **A** | Authentik in Compose; provisioner creates the 3 OIDC apps → `~/.openclaw/oidc/` | ✅ wired |
| **B** | Paperclip becomes OIDC client + role authority (`PAPERCLIP_AUTH_MODE=oidc`) | 🟡 |
| **C** | code-server OIDC client (`--auth oidc`); Paperclip forwards `id_token` | 🟡 |
| **D** | OpenClaw OIDC resource server (`Authorization: Bearer <id_token>`) | 🟡 |
| **E** | Cleanup — retire HMAC bridge, delete `bridge.secret`, drop the flag | ⬜ |

```bash
# Opt code-server into OIDC once Authentik has provisioned its config:
CODE_SERVER_AUTH=oidc ./bring-up.sh
```

> Until Phase C lands, code-server runs with `--auth bridge`: Paperclip mints a short-lived HMAC token from the shared secret and injects it on the `/editor/` proxy. The bridge secret is kept on disk for one release after each phase as a rollback path.

---

## 🚀 Deploy to a server

For a real host (not the dev `bring-up.sh`), `deploy/` ships systemd units and the SSO stack:

```bash
deploy/install-openclaw-cluster.sh     # installs the 3 systemd services
deploy/fetch-artifacts.sh              # pulls prebuilt service bundles
```

```
deploy/
├── systemd/                # openclaw.service · paperclip.service · code-server.service
├── authentik/              # docker-compose + provision.sh (creates OIDC apps)
└── install-openclaw-cluster.sh
```

There's also a self-contained **bridge installer** — `openclaw-bridge-installer.sh` — that points an *existing* systemd OpenClaw unit at a vendored build carrying the Paperclip bridge schema, via a drop-in override (fully reversible with `--rollback`):

```bash
sudo ./openclaw-bridge-installer.sh            # install
sudo ./openclaw-bridge-installer.sh --verify   # check
sudo ./openclaw-bridge-installer.sh --rollback # undo
```

---

## 🔄 Updating

Once the cluster is live you can pull the latest build straight from the **OpenClaw Control UI** — open **Settings**, find **"Update from OpenClaw UI"**, and click. It pulls the newest successful `build.yml` artifacts from this **public** repo (no token needed), deploys **only the components whose content hash changed**, atomically repoints the `current` symlink each systemd unit runs from, restarts just those units, and **rolls back automatically** if one fails its health check. `code-server` is republished byte-identical when untouched, so it's skipped — no needless editor restart.

The action is **admin-only** (`operator.admin`). Prefer a shell? [`deploy/fetch-artifacts.sh`](deploy/fetch-artifacts.sh) does the same pull → swap → restart from the command line.

### 🧩 If OpenClaw runs under systemd

The updater **discovers each unit's scope at runtime**, so it works whether your services are **system** units (`/etc/systemd/system`, run as root) or **user** units (`systemctl --user`, `~/.config/systemd/user/…` — the default for `openclaw onboard --install-daemon`).

| Your setup | What the click does |
| --- | --- |
| **System / root units** (the cluster default) | The gateway is already root, so it swaps + restarts directly. One click, done. |
| **User units / non-root gateway** | The gateway can't write a root-owned stack or restart system units on its own, so the panel shows a **password** field. Enter your login password and it escalates the privileged steps via `sudo` — validated up front, sent only over **HTTPS or loopback**, and **never logged or stored**. |

> The updater repoints a `…/<component>/current` symlink, so a unit qualifies only if its `WorkingDirectory` points at one (as the units in [`deploy/systemd/`](deploy/systemd/) do). A stock `openclaw onboard` user daemon whose `ExecStart` points at the global npm/`bin` path isn't symlink-versioned — keep using `openclaw update` for that gateway; the button still updates the other components.

### 📦 If you installed "as is" from the dist bundle

This is the layout [`deploy/install-openclaw-cluster.sh`](deploy/install-openclaw-cluster.sh) + [`deploy/fetch-artifacts.sh`](deploy/fetch-artifacts.sh) produce: each service lives under `/opt/openclaw-stack/<component>/releases/<run-id>/` with a `current` symlink, and the systemd units run from `…/current`. That's exactly what the button drives — every click drops a fresh `releases/<run-id>/`, flips `current`, and restarts only the changed unit:

```
/opt/openclaw-stack/
├── openclaw/      releases/<run-id>/  +  current ──▶ unit WorkingDirectory
├── paperclip/     releases/<run-id>/  +  current
└── code-server/   releases/<run-id>/  +  current
```

Old releases are kept, so rollback is just flipping the symlink back — which the updater does for you on a failed health check.

> The **first** click after a fresh install has no recorded baseline, so all three components are treated as changed (a full deploy). Every click after that is selective by content hash.

---

## 📂 Repository layout

```
sandbox/
├── bring-up.sh                  # one-command dev cluster (start here)
├── openclaw/                    # 🦞 multi-channel AI gateway
├── paperclip/                   # 📎 orchestration server + React UI (browser-facing)
├── code-server/                 # </> patched VS Code in the browser
├── deploy/                      # systemd units + Authentik SSO stack
├── tests/                       # cross-service tests (bridge-auth, e2e)
├── assets/                      # README banner
└── logs/                        # runtime logs (gitignored)
```

---

## 📜 License

[MIT](openclaw/LICENSE) — each bundled project keeps its own license: **OpenClaw**, **Paperclip**, and **code-server** are all MIT.

<p align="center"><sub>Built to be self-hosted. Your host, your data, your agents.</sub></p>
