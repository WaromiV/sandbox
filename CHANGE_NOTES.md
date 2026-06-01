# Change Notes — `WaromiV/sandbox` stack

Operator/agent-facing log of **shippable features** in this stack (openclaw + paperclip +
code-server). Each entry maps a **version → commit → CI build artifact → how to deploy & enable**.
This is intentionally separate from OpenClaw's own `openclaw/package.json` version
(`2026.5.x-beta`, upstream CalVer) — this file versions *our integration stack*.

- **Repo:** https://github.com/WaromiV/sandbox  (`origin`, branch `main`)
- **Current version:** `0.1.0`
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
