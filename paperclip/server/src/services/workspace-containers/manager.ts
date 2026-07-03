/**
 * Workspace container manager: idempotently ensure a user's always-on Docker
 * container (openclaw gateway + code-server) is running, via the docker CLI.
 *
 * Deterministic names + registry-allocated ports mean no orchestration state
 * beyond the registry file.
 * ponytail: single-host docker; swap for an orchestrator only when >1 host.
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { ensureEntry, listEntries, type WorkspaceEntry } from "./registry.js";

const exec = promisify(execFile);

/**
 * Write a file inside a running container via `docker exec` (stdin -> cat).
 * Used by the bridge to stage per-agent token/skill when there's no shared
 * filesystem. absPath/dir are bridge-controlled (no quotes), so the inline sh
 * is safe. ponytail: cat-over-stdin; swap to a tar copy only if perf matters.
 */
export function dockerExecWrite(
  containerName: string,
  absPath: string,
  content: string,
  mode = "600",
): Promise<void> {
  return new Promise((resolve, reject) => {
    const dir = absPath.replace(/\/[^/]*$/, "") || "/";
    const script = `mkdir -p '${dir}' && cat > '${absPath}' && chmod ${mode} '${absPath}'`;
    const child = spawn("docker", ["exec", "-i", containerName, "sh", "-c", script]);
    let stderr = "";
    child.on("error", reject);
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`docker exec write failed (${code}): ${stderr}`)),
    );
    child.stdin.write(content);
    child.stdin.end();
  });
}

function image(): string {
  return process.env.WORKSPACE_IMAGE?.trim() || "openclaw-workspace:latest";
}

async function containerState(name: string): Promise<"running" | "stopped" | "absent"> {
  try {
    const { stdout } = await exec("docker", ["inspect", "-f", "{{.State.Running}}", name]);
    return stdout.trim() === "true" ? "running" : "stopped";
  } catch {
    return "absent";
  }
}

async function startContainer(entry: WorkspaceEntry): Promise<void> {
  const state = await containerState(entry.containerName);
  if (state === "running") return;
  if (state === "stopped") {
    await exec("docker", ["start", entry.containerName]);
    return;
  }
  await exec("docker", [
    "run", "-d",
    "--name", entry.containerName,
    "--restart", "unless-stopped",
    "-v", `${entry.volumeName}:/workspace`,
    // 18790 = in-container forwarder to the loopback-bound gateway (see
    // deploy/workspace/Dockerfile).
    "-p", `127.0.0.1:${entry.gatewayPort}:18790`,
    "-p", `127.0.0.1:${entry.codeServerPort}:8090`,
    "-e", "OPENCLAW_HOME=/workspace/.openclaw",
    image(),
  ]);
}

export type EnsuredContainer = {
  gatewayPort: number;
  codeServerPort: number;
  /** ws:// URL the bridge connects to. */
  gatewayUrl: string;
  /** http:// upstream the editor proxy forwards to. */
  editorUpstream: string;
};

// Skip the docker round-trip for users already started this process lifetime.
// Cleared by invalidateEnsured() when the proxy can't reach the container or
// the idle reaper stops it.
const ensured = new Set<string>();

// Last time each user's workspace saw traffic (proxy request / WS frame).
// Drives the idle reaper. In-memory: on restart, unseen users get a fresh
// grace window rather than being reaped immediately.
const lastActiveAt = new Map<string, number>();

/** Record activity for a user's workspace (keeps it off the idle reaper). */
export function touchUser(userId: string): void {
  lastActiveAt.set(userId, Date.now());
}

export async function ensureUserContainer(
  userId: string,
  email: string | null = null,
): Promise<EnsuredContainer> {
  touchUser(userId);
  const entry = await ensureEntry(userId, email);
  if (!ensured.has(userId)) {
    await startContainer(entry);
    ensured.add(userId);
  }
  return {
    gatewayPort: entry.gatewayPort,
    codeServerPort: entry.codeServerPort,
    gatewayUrl: `ws://127.0.0.1:${entry.gatewayPort}`,
    editorUpstream: `http://127.0.0.1:${entry.codeServerPort}`,
  };
}

/** Forget a user so the next ensure re-checks docker (e.g. after a refused connection). */
export function invalidateEnsured(userId: string): void {
  ensured.delete(userId);
}

// ---------------------------------------------------------------------------
//  Idle reaper — stop containers with no traffic for WORKSPACE_IDLE_TIMEOUT_MIN
//  (default 60). The volume is kept, so the next visit `docker start`s it back
//  in ~1s. Trades a bit of return latency for idle RAM.
// ---------------------------------------------------------------------------
function idleTimeoutMs(): number {
  const min = Number(process.env.WORKSPACE_IDLE_TIMEOUT_MIN);
  return (Number.isFinite(min) && min > 0 ? min : 60) * 60_000;
}

async function stopContainer(name: string): Promise<void> {
  await exec("docker", ["stop", name]).catch(() => undefined);
}

/** Stop every workspace idle longer than `idleMs`. Exposed for tests. */
export async function reapIdleWorkspaces(
  idleMs: number = idleTimeoutMs(),
  log?: (msg: string) => void,
): Promise<number> {
  const now = Date.now();
  let stopped = 0;
  for (const entry of await listEntries()) {
    const last = lastActiveAt.get(entry.userId);
    if (last === undefined) {
      // First sighting (e.g. after a restart) — grant a fresh grace window.
      lastActiveAt.set(entry.userId, now);
      continue;
    }
    if (now - last < idleMs) continue;
    if ((await containerState(entry.containerName)) !== "running") continue;
    await stopContainer(entry.containerName);
    invalidateEnsured(entry.userId);
    lastActiveAt.delete(entry.userId);
    stopped += 1;
    log?.(`stopped idle workspace ${entry.containerName} (idle ${Math.round((now - last) / 60_000)}m); volume kept`);
  }
  return stopped;
}

/** Start the periodic idle reaper. Returns a stop function. */
export function startWorkspaceIdleReaper(log?: (msg: string) => void): () => void {
  const tickMs = Math.min(idleTimeoutMs(), 5 * 60_000);
  const timer = setInterval(() => {
    void reapIdleWorkspaces(undefined, log).catch(() => undefined);
  }, tickMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
