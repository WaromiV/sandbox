# Change Notes — `WaromiV/sandbox` stack

Operator/agent-facing log of **shippable features** in this stack (openclaw + paperclip +
code-server). Each entry maps a **version → commit → CI build artifact → how to deploy & enable**.
This is intentionally separate from OpenClaw's own `openclaw/package.json` version
(`2026.5.x-beta`, upstream CalVer) — this file versions *our integration stack*.

- **Repo:** https://github.com/WaromiV/sandbox  (`origin`, branch `main`)
- **Current version:** `2.0.0`
- **Versioning:** SemVer `MAJOR.MINOR.PATCH`
  - **MAJOR** — breaking deploy/config contract or a migration requiring manual steps.
  - **MINOR** — new backward-compatible feature (ships default-off / opt-in).
  - **PATCH** — bugfix, docs, or config tuning; no new capability.

## How deploys work here (read once)

There is no release-tag scheme; builds are GitHub Actions artifacts identified by **RUN_ID**
and marked with a `ci-<run-id>` git tag on the built commit.

To find the build for a given version's commit `<sha>`:
```bash
git fetch --tags
git tag --points-at <sha> | grep '^ci-'          # -> ci-<run-id>
# or: gh run list --commit <sha> --workflow build.yml   (RUN_ID is the run's id)
```
Deploy that artifact on the prod host (`/home/serv`), pick one:
```bash
# A) pull a specific CI artifact by run id and atomically repoint `current`:
RUN_ID=<run-id> deploy/fetch-artifacts.sh && deploy/stack-update.sh
# B) "Update from OpenClaw UI" button in Paperclip Settings (same stack-update path)
# C) from a git checkout on the host:
git -C <repo> pull origin main && pnpm -C <repo>/openclaw install && pnpm -C <repo>/openclaw build \
  && systemctl restart openclaw   # (or your gateway unit)
```
A feature's *code* is only live once the gateway runs a build that **contains its commit**.

---

## v2.0.0 — 2026-06-30 — Per-user workspaces: unified worker UI + isolated containers

**Summary.** Turns the stack into a multi-worker tool. Every SSO user is an
`instance_admin` (full cross-company access, governed only by attribution +
audit), gets their own always-on Docker workspace container (openclaw gateway +
code-server on a `/workspace` volume), and a unified UI exposing **their chats**,
**their workspace**, and **all companies** with an audit log.

> **Breaking** deploy/config contract → **MAJOR**. paperclip now needs docker
> access; nginx repoints `/editor` + `/openclaw` to paperclip; a per-user image
> is built at install. The server feature is opt-in via `WORKSPACE_CONTAINERS`
> (default off), but the canonical installer turns it on. See migration below.

**What changed.**
- **P0 — access + chats (no infra):** new `ALL_SSO_USERS_ADMIN` flag promotes
  every SSO user to `instance_admin` (create-hook + idempotent startup backfill,
  `auth/oidc-bootstrap.ts`). `MyIssues` now uses the server `touchedByUserId=me`
  filter instead of fetch-all + client-filter.
- **P2 — per-user containers:** new `deploy/workspace/Dockerfile` (openclaw +
  code-server, inlined entrypoint, `--bind lan`). paperclip
  `services/workspace-containers/` owns a registry (`~/.openclaw/workspaces/
  registry.json`), a docker-CLI manager (deterministic `ws-<id>` names +
  allocated host ports, always-on), and a per-user HTTP+WS proxy for `/editor`
  + `/openclaw`. Routing is by paperclip session — no njs needed.
- **P3 — bridge multiplexer:** one bridge per container instead of one shared
  gateway (`openclaw-bridge/multiplexer.ts`, watches the registry). External
  agent ids + uuids are namespaced per user (no cross-user collisions), retire
  is scoped per-company, and token/skill staging moves from shared-fs writes to
  `docker exec` (no shared filesystem assumed).
- **P4 — unified UI:** `GET /api/me/issues` (cross-company "my chats"),
  `POST /api/me/workspace/ensure`, `GET /api/instance/activity` (cross-company
  audit). New pages **My Workspace** (embedded editor), **My Chats**, **Audit
  Log**, plus a "Personal" sidebar section.
- **deploy:** installer adds the service user to the `docker` group, builds
  `openclaw-workspace:latest`, repoints nginx `/editor` + `/openclaw` to
  paperclip (`:3110`, prefix preserved), allowlists `/api/me`, and sets
  `ALL_SSO_USERS_ADMIN=true` + `WORKSPACE_CONTAINERS=true`. Repo-root
  `.dockerignore` narrows the build context to `openclaw/`.

> P1 (a throwaway single-host `?folder=` editor) was intentionally folded into
> P2 — the container delivers the per-user editor properly.

**Migrate.** Pull, rebuild paperclip + openclaw, ensure docker is installed and
the paperclip service user is in the `docker` group, build the workspace image
(`docker build -f deploy/workspace/Dockerfile -t openclaw-workspace:latest .`),
reload nginx with the new `/editor` + `/openclaw` → `:3110` routing, and set
`WORKSPACE_CONTAINERS=true` + `ALL_SSO_USERS_ADMIN=true` in paperclip.env. The
installer does all of this. Containers + volumes are created lazily on first
login. The legacy single shared gateway/editor still works with the flag unset.

---

## v1.0.0 — 2026-06-15 — Authentik is the only gate for openclaw + code-server

**Summary.** Stripped all built-in auth from openclaw and code-server. They now
run `--auth none` on loopback and are guarded **solely** by Authentik
forward-auth at the reverse proxy. paperclip is unchanged — it keeps its own
Authentik OIDC client and remains the role authority.

> **Breaking** deploy/config contract → **MAJOR** bump (first 1.x). Re-run the
> Authentik provisioner and reload nginx on deploy; see migration below.

**What changed.**
- **code-server:** removed the patched `--auth bridge` and `--auth oidc` modes
  entirely (deleted `bridgeAuth.ts`, `oidcAuth.ts`, `tests/bridge-auth/`, and
  the `bridge-*`/`oidc-*` CLI flags). It only supports `none` / `password` now
  and is run with `--auth none`.
- **openclaw:** runs `gateway --bind loopback --auth none`. No openclaw core
  change — its dormant OIDC-bearer capability is simply never exercised.
- **paperclip:** removed the `/editor` editor-bridge proxy (HMAC token minting +
  WS gate) and the `oidc-id-token` forwarding. nginx now serves `/editor`
  straight to code-server. The openclaw-bridge connects tokenlessly
  (`OPENCLAW_GATEWAY_URL` only; `OPENCLAW_GATEWAY_TOKEN` no longer required).
- **deploy:** nginx gains an Authentik forward-auth `auth_request` on `/editor`
  and `/openclaw` (embedded outpost at `/outpost.goauthentik.io`); `/editor`
  routes directly to code-server with the prefix stripped. systemd units bind
  loopback + `--auth none`. No more `~/.openclaw/bridge.secret`.
- **provisioner:** drops the `codeserver.json` / `gateway.json` OIDC clients;
  keeps `paperclip.json`; adds a domain-level forward-auth proxy provider
  (`openclaw-forward-auth`) assigned to the embedded outpost.
- **docs:** new root `AGENTS.md` ("Auth model") with a ready-to-paste manual
  nginx config for dev/custom hosts.

**Migrate.** Pull, rebuild code-server + paperclip + openclaw, then
`deploy/authentik/provision.sh` (creates the forward-auth provider) and reload
nginx. `~/.openclaw/bridge.secret` and `oidc/{codeserver,gateway}.json` are now
unused and can be deleted. To restrict the editor to admins, bind a group
policy to the `openclaw-forward-auth` application in Authentik.

---

## v0.2.0 — 2026-06-05 — Paperclip reporter identity + per-agent token injection

**Summary.** openclaw agents now automatically receive their Paperclip identity at run time.
The openclaw-bridge stager (paperclip-side) already wrote a `paperclip-claimed-api-key.json`
token + `skills/paperclip/SKILL.md` into each agent's workspace directory; this release wires
the other half: openclaw reads those files at agent start and injects `PAPERCLIP_*` env vars
into both the sandbox (Docker) environment and the host exec environment. As a result,
`createdByAgentId` on issues filed via the Paperclip API is now set correctly for every
openclaw-launched agent (previously null). The Paperclip skill is also bundled into openclaw
core (`openclaw/skills/paperclip/SKILL.md`) so it's available even without bridge-staged copies.
`bring-up.sh` auto-enables the bridge when the gateway token is present in
`~/.openclaw/openclaw.json`. **Ships automatically — no config changes required once the bridge
is wired.**

- **Commit:** `11e4e81e` (`feat(paperclip): per-agent token injection + reporter identity (v0.2.0)`)
- **Build artifact:** CI run for `11e4e81e` → tag `ci-<run-id>`.
- **Docs:** `openclaw/skills/paperclip/SKILL.md`; `tests/paperclip-reporter/`
- **Status:** typecheck clean; 7 vitest unit tests (loadPaperclipRunEnv) green; 8 Playwright
  integration tests green (1 skipped — multi-agent, requires ≥2 staged tokens). Enabled
  automatically when `OPENCLAW_GATEWAY_URL` / `OPENCLAW_GATEWAY_TOKEN` are set in paperclip's
  env (done by `bring-up.sh` when `~/.openclaw/openclaw.json` has `gateway.auth.token`).

### Install / enable

No new config keys required. The full pipeline activates once the openclaw-bridge is wired:

1. **Deploy** a build containing this commit.
2. Run `./bring-up.sh` from the repo root. The script detects `gateway.auth.token` in
   `~/.openclaw/openclaw.json` and sets `OPENCLAW_GATEWAY_URL` + `OPENCLAW_GATEWAY_TOKEN` in
   paperclip's env automatically. Bridge-sync log line:
   ```
       (openclaw-bridge enabled: ws://127.0.0.1:18789)
   ```
3. Paperclip will mirror openclaw agents and stage per-agent tokens. On the next agent run,
   openclaw reads `<workspace>/paperclip-claimed-api-key.json` and injects the vars.

### Verify
```bash
# Static checks (no running stack needed):
cd tests && npx playwright test --config paperclip-reporter/playwright.config.ts

# Expected:
#  ✓ SKILL.md exists at openclaw/skills/paperclip/SKILL.md
#  ✓ SKILL.md has required frontmatter fields
#  ✓ SKILL.md documents the key API endpoints
#  ✓ agent workspace has a staged token file          <- needs bridge running once
#  ✓ staged token file has required fields
#  ✓ staged skill file exists in agent workspace
#  ✓ GET /api/agents/me returns the mirrored agent    <- needs paperclip running
#  ✓ issue created with staged token records reporter <- needs paperclip running
```

### Rollback
Remove `OPENCLAW_GATEWAY_URL` and `OPENCLAW_GATEWAY_TOKEN` from paperclip's env (or set
`USE_AUTHENTIK` / restart without bridge). Agents fall back to no token → `createdByAgentId`
returns to null. No DB migration needed; the column already existed.

### Known gaps (not in this version)
- Per-topic Docker containers do not auto-clone the target repo (carried from v0.1.0). → v0.3.0.
- Sandbox observability not surfaced into Telegram or Paperclip (carried from v0.1.0). → v0.3.0.
- Multi-agent reporter test (test 9) is skipped unless ≥2 agent workspaces have staged tokens.
  Run the stack with at least two named agents (`flow-dev` + `tech-lead`) to exercise it.

---

## v0.1.0 — 2026-06-01 — Per-Telegram-topic Docker isolation

**Summary.** New OpenClaw sandbox mode `sandbox.mode: "telegram-topic"`. An agent run is
sandboxed (Docker) **only** when it originates from a Telegram forum *topic*; with
`scope: "session"` each topic gets its own container + isolated checkout, so per-topic agents
stop sharing one git HEAD. DMs, non-topic groups, the General topic (thread id 1), and CLI runs
stay on the host. The shared Jira MCP and cross-agent delegation keep working
(`sessions_*`/`subagents` already allow-listed; Jira re-allowed via `alsoAllow`). **Default `off`
— zero behavior change until opted in.**

- **Commit:** `265d29a9` (`feat(sandbox): add telegram-topic mode for per-topic agent isolation`)
- **Build artifact:** GitHub Actions run `26720572948` → tag `ci-26720572948` (commit `265d29a9`).
  Deploy it with: `RUN_ID=26720572948 deploy/fetch-artifacts.sh && deploy/stack-update.sh`.
- **Docs:** `openclaw/docs/gateway/sandboxing.md` (mode tab).
- **Status:** code on `main` + verified (typecheck clean for the diff; gate + wiring unit tests;
  157-test sandbox suite green). **Not enabled in any prod config.**

### Install / enable (prod, `/home/serv/.openclaw/openclaw.json`)
1. **Deploy** a build containing `265d29a9` (see "How deploys work"). Confirm:
   `openclaw sandbox explain --session 'agent:flow-dev:telegram:group:<chatId>:topic:<topicId>'`.
2. **Docker prereqs on the host:**
   ```bash
   sudo usermod -aG docker serv          # gateway shells out to docker; re-login after
   OPENCLAW_SANDBOX=1 openclaw/scripts/docker/setup.sh   # builds openclaw-sandbox:bookworm-slim
   DOCKER_BUILDKIT=1 docker build -f openclaw/scripts/docker/sandbox/Dockerfile.common \
     -t openclaw-sandbox-common:bookworm-slim openclaw/scripts/docker/sandbox   # node/pnpm/go/rust
   docker network create openclaw-sbx
   ```
3. **Opt one agent in** (`agents.list[]` → `flow-dev`), plus a global Jira re-allow:
   ```jsonc
   { "id": "flow-dev", "workspace": "/home/serv/.openclaw/workspace/agents/flow-dev",
     "sandbox": { "mode": "telegram-topic", "scope": "session", "workspaceAccess": "none",
       "docker": { "image": "openclaw-sandbox-common:bookworm-slim", "network": "openclaw-sbx",
         "binds": ["/home/serv/.config/gh:/home/sandbox/.config/gh:ro"] } } }
   // top-level "tools":
   "tools": { "sandbox": { "tools": { "alsoAllow": ["*jira*"] } } }
   ```
   Gateway hot-reloads config (or restart it).
4. **Fleet-wide later:** set `agents.defaults.sandbox.mode: "telegram-topic"` and add
   `"sandbox": { "mode": "off" }` to `gateway-builder`, `agent-manager`, `sofa` (they need
   channel/config tools and must stay on host).

### Verify
```bash
# message flow-dev's topic, then:
docker ps                 # one openclaw-sbx-… container for that topic
openclaw sandbox list     # entry keyed by the topic sessionKey
# DM the bot -> no container; second topic -> a second container
```

### Rollback
Set the agent's (or defaults') `sandbox.mode` back to `"off"` and reload — instant, no data loss.
Containers are pruned by `prune.idleHours`/`maxAgeDays`, or remove now with `openclaw sandbox`.

### Known gaps (not in this version)
- Target repo is **not auto-cloned** into the per-topic container (workspace copy carries identity
  files only). Agent clones it itself, or add `docker.setupCommand`. → candidate for `v0.2.0`.
- Observability is `openclaw sandbox list` + `docker ps` + logs only; nothing surfaced into
  Telegram or Paperclip. → candidate for `v0.2.0`.

---

## How to add an entry / bump the version (for agents)

1. Decide the bump from the rules at the top (feature → MINOR, fix → PATCH, breaking → MAJOR).
2. Update the **`Current version:`** line at the top of this file.
3. Insert a new section **directly under the `---` after "How deploys work"** (newest first),
   copying this template and filling every field:

```markdown
## vX.Y.Z — YYYY-MM-DD — <short title>

**Summary.** <what changed, and whether it ships default-off>

- **Commit:** `<sha>` (`<commit subject>`)
- **Build artifact:** CI run for `<sha>` → tag `ci-<run-id>`.
- **Docs:** `<path>`
- **Status:** <verification done; enabled where?>

### Install / enable
<ordered steps; commands in fenced blocks; real config paths>

### Verify
<exact commands + expected output>

### Rollback
<how to revert>

### Known gaps
<deferred items, with the version they’re targeted for>
```
4. Keep the date absolute (`YYYY-MM-DD`), reference the **commit SHA** (so the build artifact is
   discoverable), and never delete old entries — append only.
