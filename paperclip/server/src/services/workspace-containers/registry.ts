/**
 * Per-user workspace registry.
 *
 * One always-on Docker container per human worker (openclaw gateway +
 * code-server). This file owns the userId -> container mapping and host-port
 * allocation. The registry file IS the allocation state — no separate table.
 *
 * Read by: the per-user editor/gateway proxy and the openclaw bridge
 * multiplexer (each container has its own gateway). Written by: the container
 * manager when it first provisions a user.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type WorkspaceEntry = {
  userId: string;
  email: string | null;
  containerName: string;
  volumeName: string;
  /** Host port mapped to the container's openclaw gateway (18789). */
  gatewayPort: number;
  /** Host port mapped to the container's code-server (8090). */
  codeServerPort: number;
  createdAt: string;
  updatedAt: string;
};

type RegistryFile = { users: Record<string, WorkspaceEntry> };

const PORT_BASE = 19000; // host ports allocated upward from here, in pairs

export function registryPath(): string {
  const fromEnv = process.env.WORKSPACE_REGISTRY_PATH?.trim();
  if (fromEnv) return fromEnv;
  const home = process.env.OPENCLAW_HOME?.trim() || path.join(os.homedir(), ".openclaw");
  return path.join(home, "workspaces", "registry.json");
}

// Single-process serialization: paperclip runs as one process, so chaining
// writes is enough to keep read-modify-write atomic.
// ponytail: in-process lock; add file locking only if paperclip runs multi-process.
let writeChain: Promise<unknown> = Promise.resolve();

async function readRegistry(): Promise<RegistryFile> {
  try {
    const raw = await fs.readFile(registryPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<RegistryFile>;
    return parsed.users ? (parsed as RegistryFile) : { users: {} };
  } catch {
    return { users: {} };
  }
}

async function writeRegistry(reg: RegistryFile): Promise<void> {
  const p = registryPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(reg, null, 2));
}

export async function getEntry(userId: string): Promise<WorkspaceEntry | null> {
  const reg = await readRegistry();
  return reg.users[userId] ?? null;
}

export async function listEntries(): Promise<WorkspaceEntry[]> {
  const reg = await readRegistry();
  return Object.values(reg.users);
}

function shortId(userId: string): string {
  return createHash("sha1").update(userId).digest("hex").slice(0, 12);
}

function allocatePorts(reg: RegistryFile): { gatewayPort: number; codeServerPort: number } {
  const used = new Set<number>();
  for (const e of Object.values(reg.users)) {
    used.add(e.gatewayPort);
    used.add(e.codeServerPort);
  }
  let p = PORT_BASE;
  while (used.has(p) || used.has(p + 1)) p += 2;
  return { gatewayPort: p, codeServerPort: p + 1 };
}

/** Get-or-create the registry entry for a user. Does NOT touch docker. */
export async function ensureEntry(userId: string, email: string | null): Promise<WorkspaceEntry> {
  const result = writeChain.then(async () => {
    const reg = await readRegistry();
    const existing = reg.users[userId];
    if (existing) return existing;
    const sid = shortId(userId);
    const ports = allocatePorts(reg);
    const now = new Date().toISOString();
    const entry: WorkspaceEntry = {
      userId,
      email,
      containerName: `ws-${sid}`,
      volumeName: `wsvol-${sid}`,
      gatewayPort: ports.gatewayPort,
      codeServerPort: ports.codeServerPort,
      createdAt: now,
      updatedAt: now,
    };
    reg.users[userId] = entry;
    await writeRegistry(reg);
    return entry;
  });
  writeChain = result.catch(() => undefined);
  return result;
}
