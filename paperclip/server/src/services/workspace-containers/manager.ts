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
import { ensureEntry, type WorkspaceEntry } from "./registry.js";

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
    "-p", `127.0.0.1:${entry.gatewayPort}:18789`,
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
// Cleared by invalidateEnsured() when the proxy can't reach the container.
const ensured = new Set<string>();

export async function ensureUserContainer(
  userId: string,
  email: string | null = null,
): Promise<EnsuredContainer> {
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
