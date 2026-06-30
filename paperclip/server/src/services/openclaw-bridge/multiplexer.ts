/**
 * OpenClaw bridge multiplexer.
 *
 * In the per-user workspace model there is one openclaw gateway per user
 * container, not a single shared gateway. This watches the workspace registry
 * and runs one per-user bridge per running container, each mirroring that
 * container's agents into the user's home company (namespaced so identical
 * openclaw slugs across users don't collide).
 *
 * Implements the same OpenclawBridge interface as a single bridge, so the
 * /api/openclaw routes consume it unchanged (roster is the aggregate).
 */
import type { Db } from "@paperclipai/db";
import { listEntries, type WorkspaceEntry } from "../workspace-containers/registry.js";
import { createOpenclawBridge, type OpenclawBridge, type OpenclawRoster } from "./index.js";
import type { OpenclawBridgeConfig } from "./config.js";

const POLL_MS = 15_000;

export type MultiplexerDeps = {
  db: Db;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
  skillSourcePath?: string;
  paperclipApiUrl?: string;
};

function homeCompanyName(entry: WorkspaceEntry): string {
  return `Workspace — ${entry.email || entry.userId}`;
}

function configForEntry(entry: WorkspaceEntry, paperclipApiUrl: string): OpenclawBridgeConfig {
  return {
    url: `ws://127.0.0.1:${entry.gatewayPort}`,
    token: "", // gateway runs --auth none
    paperclipApiUrl,
    syncIntervalMs: 30_000,
    companyName: homeCompanyName(entry),
    pinnedCompanyId: null,
  };
}

export function createOpenclawBridgeMultiplexer(deps: MultiplexerDeps): OpenclawBridge {
  const log = deps.log ?? (() => {});
  const paperclipApiUrl =
    deps.paperclipApiUrl ??
    process.env.PAPERCLIP_PUBLIC_URL?.trim() ??
    process.env.PAPERCLIP_API_URL?.trim() ??
    `http://localhost:${process.env.PORT?.trim() || "3100"}`;
  const managed = new Map<string, OpenclawBridge>();
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  function aggregateRoster(): OpenclawRoster {
    const agents: OpenclawRoster["agents"] = [];
    let fetchedAtMs = 0;
    for (const bridge of managed.values()) {
      const r = bridge.getRoster();
      agents.push(...r.agents);
      fetchedAtMs = Math.max(fetchedAtMs, r.fetchedAtMs);
    }
    return { fetchedAtMs, defaultId: null, agents };
  }

  async function reconcile(): Promise<void> {
    let entries: WorkspaceEntry[] = [];
    try {
      entries = await listEntries();
    } catch (err) {
      log("registry read failed", { err: String(err) });
      return;
    }
    const seen = new Set<string>();
    for (const entry of entries) {
      seen.add(entry.userId);
      if (managed.has(entry.userId)) continue;
      const bridge = createOpenclawBridge(configForEntry(entry, paperclipApiUrl), {
        db: deps.db,
        log: (msg, meta) => log(`[user ${entry.userId.slice(0, 8)}] ${msg}`, meta),
        skillSourcePath: deps.skillSourcePath,
        namespace: entry.userId,
        containerName: entry.containerName,
      });
      managed.set(entry.userId, bridge);
      void bridge
        .start()
        .catch((err) => log("per-user bridge start failed", { userId: entry.userId, err: String(err) }));
      log(`started bridge for user ${entry.userId} (gateway :${entry.gatewayPort})`);
    }
    for (const [userId, bridge] of managed) {
      if (seen.has(userId)) continue;
      bridge.stop();
      managed.delete(userId);
      log(`stopped bridge for user ${userId} (no longer in registry)`);
    }
  }

  function scheduleNext(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      void reconcile().finally(scheduleNext);
    }, POLL_MS);
    timer.unref?.();
  }

  return {
    async start() {
      stopped = false;
      await reconcile();
      scheduleNext();
    },
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      for (const bridge of managed.values()) bridge.stop();
      managed.clear();
    },
    getRoster: aggregateRoster,
    async refreshNow() {
      await Promise.all(
        [...managed.values()].map((bridge) => bridge.refreshNow().catch(() => undefined)),
      );
      return aggregateRoster();
    },
    // Ready once at least one container's bridge is ready, or trivially when
    // there are no user containers yet.
    isReady() {
      if (managed.size === 0) return true;
      for (const bridge of managed.values()) if (bridge.isReady()) return true;
      return false;
    },
    // No single company in the per-user model — the UI falls back to the
    // companies list.
    getCompanyId: () => null,
  };
}
