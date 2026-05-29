import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("infra/stack-update");

/**
 * Launches and inspects the detached stack-update worker (deploy/stack-update.sh).
 *
 * The worker MUST outlive the gateway: when openclaw itself is in the changed
 * set it restarts openclaw.service, which would kill any process sharing the
 * gateway's cgroup. We therefore launch it in its own transient systemd unit
 * (`systemd-run`, `--user` when the gateway is non-root) and fall back to
 * `setsid` only when systemd-run is unavailable. The worker reports progress
 * through a status JSON file that both this module and the HTTP handler read —
 * that file is what bridges the brief window where the gateway restarts itself.
 */

export type StackUpdatePaths = {
  stateDir: string;
  statusFile: string;
  deployedFile: string;
  lockFile: string;
  logFile: string;
};

export type StackUpdateLaunchResult =
  | { kind: "launched"; startedAt: string; launchMethod: string; statusFile: string }
  | { kind: "already-running"; status: unknown }
  | { kind: "error"; message: string };

// Phases during which a worker is considered actively running.
const ACTIVE_PHASES = new Set([
  "running",
  "discovering",
  "checking",
  "downloading",
  "validating",
  "swapping",
  "restarting",
  "rolling_back",
]);

// A "running" status older than this with no live pid is treated as abandoned.
const STALE_AFTER_MS = 20 * 60_000;

// Env knobs the operator may set on the gateway that the worker honors; forwarded verbatim.
const FORWARDED_ENV = [
  "REPO",
  "WORKFLOW",
  "BRANCH",
  "COMPONENTS",
  "RUN_ID",
  "STACK_ROOT",
  "OPENCLAW_OPENCLAW_UNIT",
  "OPENCLAW_PAPERCLIP_UNIT",
  "OPENCLAW_CODE_SERVER_UNIT",
];

export function gatewayEuid(): number | undefined {
  return typeof process.geteuid === "function" ? process.geteuid() : undefined;
}

/** Whether privileged steps will need a sudo password (i.e. the gateway is not root). */
export function gatewayRequiresSudoPassword(): boolean {
  const euid = gatewayEuid();
  return euid !== undefined && euid !== 0;
}

/**
 * Resolve the state-file locations. Root writes under the stack root; a non-root
 * gateway writes under its own home so it can both write and read them without
 * escalation. Both the launcher and the status endpoint call this, so they agree.
 */
export function resolveStackUpdatePaths(): StackUpdatePaths {
  const override = process.env.OPENCLAW_STACK_STATE_DIR?.trim();
  const stateDir =
    override && override.length > 0
      ? override
      : gatewayEuid() === 0
        ? "/opt/openclaw-stack"
        : path.join(os.homedir(), ".openclaw", "stack-update");
  return {
    stateDir,
    statusFile: path.join(stateDir, ".update-status.json"),
    deployedFile: path.join(stateDir, ".deployed.json"),
    lockFile: path.join(stateDir, ".update.lock"),
    logFile: path.join(stateDir, ".update-worker.log"),
  };
}

function resolveScriptCandidates(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.OPENCLAW_STACK_UPDATE_SCRIPT,
    // Shipped alongside the gateway dist (CI copies deploy/stack-update.sh here).
    path.join(here, "..", "stack-update.sh"),
    // Dev monorepo: openclaw/src/infra -> repo-root/deploy. dist/infra has the same depth.
    path.join(here, "..", "..", "..", "deploy", "stack-update.sh"),
    // Common deployed deploy/ locations.
    "/opt/sandbox/deploy/stack-update.sh",
    "/opt/openclaw-stack/deploy/stack-update.sh",
  ];
  return candidates.filter((c): c is string => typeof c === "string" && c.length > 0);
}

export function resolveStackUpdateScriptPath(): string | null {
  for (const candidate of resolveScriptCandidates()) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // ignore unreadable candidate
    }
  }
  return null;
}

export async function readStackUpdateStatus(): Promise<Record<string, unknown> | null> {
  const { statusFile } = resolveStackUpdatePaths();
  try {
    const raw = await fs.promises.readFile(statusFile, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we may not signal it — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True if the status file describes a worker that is still genuinely running. */
export function isWorkerRunning(status: Record<string, unknown> | null): boolean {
  if (!status) {
    return false;
  }
  const phase = typeof status.phase === "string" ? status.phase : "";
  if (!ACTIVE_PHASES.has(phase)) {
    return false;
  }
  const pid = typeof status.pid === "number" ? status.pid : undefined;
  if (pid !== undefined && !isPidAlive(pid)) {
    return false;
  }
  const updatedAt = typeof status.updatedAt === "string" ? Date.parse(status.updatedAt) : NaN;
  if (Number.isFinite(updatedAt) && Date.now() - updatedAt > STALE_AFTER_MS) {
    return false;
  }
  return true;
}

function commandOnPath(cmd: string): boolean {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    try {
      fs.accessSync(path.join(dir, cmd), fs.constants.X_OK);
      return true;
    } catch {
      // not here
    }
  }
  return false;
}

function buildExtraEnv(pwFile: string | undefined, paths: StackUpdatePaths): Record<string, string> {
  const env: Record<string, string> = {
    STATUS_FILE: paths.statusFile,
    DEPLOYED_FILE: paths.deployedFile,
    LOCK_FILE: paths.lockFile,
    HOME: process.env.HOME ?? os.homedir(),
    PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  };
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  if (runtimeDir) {
    env.XDG_RUNTIME_DIR = runtimeDir;
  }
  if (pwFile) {
    env.OPENCLAW_STACK_UPDATE_SUDO_PW_FILE = pwFile;
  }
  for (const key of FORWARDED_ENV) {
    const value = process.env[key];
    if (typeof value === "string" && value.length > 0) {
      env[key] = value;
    }
  }
  return env;
}

type LaunchPlan = { method: string; argv: string[]; useSpawnEnv: boolean };

function buildLaunchPlan(
  scriptPath: string,
  extraEnv: Record<string, string>,
  startedAtMs: number,
): LaunchPlan {
  const isRoot = gatewayEuid() === 0;
  const unitName = `openclaw-stack-update-${startedAtMs}`;
  if (commandOnPath("systemd-run")) {
    const setenv = Object.entries(extraEnv).map(([k, v]) => `--setenv=${k}=${v}`);
    // systemd-run runs with the manager's env, NOT ours, so pass everything via --setenv.
    const base = isRoot
      ? ["systemd-run", "--quiet", "--unit", unitName, "--collect"]
      : ["systemd-run", "--user", "--quiet", "--unit", unitName, "--collect"];
    return {
      method: isRoot ? "systemd-run-system" : "systemd-run-user",
      argv: [...base, ...setenv, "/bin/bash", scriptPath],
      useSpawnEnv: false,
    };
  }
  if (commandOnPath("setsid")) {
    return { method: "setsid", argv: ["setsid", "/bin/bash", scriptPath], useSpawnEnv: true };
  }
  return { method: "detached", argv: ["/bin/bash", scriptPath], useSpawnEnv: true };
}

function writeSudoPasswordFile(password: string): string {
  const file = path.join(
    os.tmpdir(),
    `openclaw-stack-update-pw-${process.pid}-${Math.abs(hashString(password + String(Date.now())))}`,
  );
  fs.writeFileSync(file, password, { mode: 0o600 });
  return file;
}

// Small non-crypto hash only to vary the temp filename; never used for security.
function hashString(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i++) {
    h = (Math.imul(31, h) + value.charCodeAt(i)) | 0;
  }
  return h;
}

export async function launchStackUpdateWorker(opts?: {
  sudoPassword?: string;
}): Promise<StackUpdateLaunchResult> {
  const existing = await readStackUpdateStatus();
  if (isWorkerRunning(existing)) {
    return { kind: "already-running", status: existing };
  }

  const scriptPath = resolveStackUpdateScriptPath();
  if (!scriptPath) {
    return {
      kind: "error",
      message: "stack-update.sh not found (set OPENCLAW_STACK_UPDATE_SCRIPT to override)",
    };
  }

  const paths = resolveStackUpdatePaths();
  try {
    fs.mkdirSync(paths.stateDir, { recursive: true });
  } catch (err) {
    return {
      kind: "error",
      message: `cannot create state dir ${paths.stateDir}: ${(err as Error).message}`,
    };
  }

  const password = opts?.sudoPassword;
  let pwFile: string | undefined;
  if (typeof password === "string" && password.length > 0) {
    try {
      pwFile = writeSudoPasswordFile(password);
    } catch (err) {
      return { kind: "error", message: `cannot stage credentials: ${(err as Error).message}` };
    }
  }

  const startedAtMs = Date.now();
  const extraEnv = buildExtraEnv(pwFile, paths);
  const plan = buildLaunchPlan(scriptPath, extraEnv, startedAtMs);
  extraEnv.OPENCLAW_STACK_UPDATE_LAUNCH = plan.method;
  if (!plan.useSpawnEnv) {
    // env passed via --setenv; rebuild argv with the launch label included.
    const rebuilt = buildLaunchPlan(scriptPath, extraEnv, startedAtMs);
    plan.argv = rebuilt.argv;
  }

  let logFd: number | undefined;
  try {
    logFd = fs.openSync(paths.logFile, "a", 0o640);
  } catch {
    logFd = undefined;
  }

  try {
    const child = spawn(plan.argv[0]!, plan.argv.slice(1), {
      detached: true,
      stdio: ["ignore", logFd ?? "ignore", logFd ?? "ignore"],
      env: plan.useSpawnEnv ? { ...process.env, ...extraEnv } : process.env,
    });
    child.on("error", (err) => {
      log.warn("stack-update worker failed to spawn", { error: err });
    });
    child.unref();
    log.info("launched stack-update worker", { method: plan.method, scriptPath });
  } catch (err) {
    if (pwFile) {
      try {
        fs.unlinkSync(pwFile);
      } catch {
        // best effort
      }
    }
    return { kind: "error", message: `failed to launch worker: ${(err as Error).message}` };
  } finally {
    if (logFd !== undefined) {
      try {
        fs.closeSync(logFd);
      } catch {
        // best effort
      }
    }
  }

  return {
    kind: "launched",
    startedAt: new Date(startedAtMs).toISOString(),
    launchMethod: plan.method,
    statusFile: paths.statusFile,
  };
}
