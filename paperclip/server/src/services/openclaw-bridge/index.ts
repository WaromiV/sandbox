import { createHash } from "node:crypto";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "@paperclipai/db";
import { OpenclawRpcClient } from "./rpc-client.js";
import type { OpenclawBridgeConfig } from "./config.js";
import { stageRoster, type StagerResult } from "./stager.js";

/**
 * OpenClaw bridge: paperclip-side service that talks to the openclaw
 * gateway and keeps paperclip's view of agents identical to openclaw's
 * `agents.list`. The bridge is the only way agents get into paperclip
 * — manual creation through paperclip's old `POST /agents` flow stays
 * present in the codebase only to satisfy the Phase 1 deferral; the UI
 * hides it and the mirror will overwrite anything it manages.
 *
 * Lifecycle:
 *   const bridge = createOpenclawBridge(config);
 *   bridge.start();
 *   const roster = bridge.getRoster();
 *
 * The bridge keeps a long-lived WS connection and refreshes the roster
 * on `syncIntervalMs`. Roster lookups are synchronous and free —
 * callers (routes, UI proxies) read from the in-memory cache.
 */

export type OpenclawAgentIdentity = {
  name?: string;
  theme?: string;
  emoji?: string;
  avatar?: string;
  avatarUrl?: string;
};

export type OpenclawAgent = {
  /** Slug from openclaw (e.g. "viktor", "yaromir"). */
  id: string;
  /** Display name — identity.name if present, else id. */
  label: string;
  workspace: string | null;
  model: { primary?: string; fallbacks?: string[] } | null;
  identity: OpenclawAgentIdentity | null;
  /** Deterministic uuid v5–style id used when paperclip needs a uuid. */
  paperclipUuid: string;
};

export type OpenclawRoster = {
  /** Unix-ms when this roster snapshot was taken. */
  fetchedAtMs: number;
  defaultId: string | null;
  agents: OpenclawAgent[];
};

type GatewayListResult = {
  defaultId: string;
  mainKey: string;
  scope: string;
  agents: Array<{
    id: string;
    name?: string;
    workspace?: string;
    model?: { primary?: string; fallbacks?: string[] };
    identity?: OpenclawAgentIdentity;
  }>;
};

const EMPTY_ROSTER: OpenclawRoster = { fetchedAtMs: 0, defaultId: null, agents: [] };

/**
 * UUID-v5–like deterministic id derived from a stable namespace plus
 * the openclaw agent id. Lets paperclip use the same row id across
 * restarts and across sync cycles.
 */
function deterministicUuid(openclawAgentId: string): string {
  const NAMESPACE = "5ed4e8d7-2b6a-4ce3-9d6f-b1d8b6e1d3f4"; // bridge namespace
  const hash = createHash("sha1");
  hash.update(NAMESPACE);
  hash.update(openclawAgentId);
  const bytes = hash.digest();
  // Format as 8-4-4-4-12 UUID with version 5 (sha1) marker.
  const hex = bytes.subarray(0, 16).toString("hex");
  // Set version (bits 12-15 of time_hi_and_version) to 5.
  const versioned = hex.slice(0, 12) + "5" + hex.slice(13, 16) + hex.slice(16);
  // Set variant (bits 6-7 of clock_seq_hi_and_reserved) to 10 (rfc4122).
  const variantByte = parseInt(versioned.slice(16, 18), 16);
  const variant = ((variantByte & 0x3f) | 0x80).toString(16).padStart(2, "0");
  const final = versioned.slice(0, 16) + variant + versioned.slice(18);
  return `${final.slice(0, 8)}-${final.slice(8, 12)}-${final.slice(12, 16)}-${final.slice(16, 20)}-${final.slice(20, 32)}`;
}

function normaliseAgent(raw: GatewayListResult["agents"][number]): OpenclawAgent {
  const id = raw.id;
  const identity = raw.identity ?? null;
  const label = identity?.name?.trim() || raw.name?.trim() || id;
  return {
    id,
    label,
    workspace: raw.workspace ?? null,
    model: raw.model ?? null,
    identity,
    paperclipUuid: deterministicUuid(id),
  };
}

export type OpenclawBridge = {
  start: () => Promise<void>;
  stop: () => void;
  getRoster: () => OpenclawRoster;
  refreshNow: () => Promise<OpenclawRoster>;
  isReady: () => boolean;
};

export type OpenclawBridgeDeps = {
  log?: (msg: string, meta?: Record<string, unknown>) => void;
  /**
   * Paperclip db handle — when supplied, the bridge mirrors openclaw's
   * roster into paperclip's `agents` table and mints per-agent tokens.
   * When absent, the bridge runs in read-only roster mode (Phase 1).
   */
  db?: Db;
  /**
   * Path to paperclip's bundled skill source. Defaults to the
   * monorepo-relative `skills/paperclip/SKILL.md`.
   */
  skillSourcePath?: string;
};

function defaultSkillSourcePath(): string {
  // server/src/services/openclaw-bridge/index.ts -> ../../../../skills/paperclip/SKILL.md
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../..", "skills/paperclip/SKILL.md");
}

export function createOpenclawBridge(
  config: OpenclawBridgeConfig,
  deps: OpenclawBridgeDeps = {},
): OpenclawBridge {
  const log = deps.log ?? ((msg, meta) => console.log(`[openclaw-bridge] ${msg}`, meta ?? {}));
  let roster: OpenclawRoster = EMPTY_ROSTER;
  let ready = false;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const client = new OpenclawRpcClient({
    url: config.url,
    token: config.token,
    log,
  });

  async function fetchRosterOnce(): Promise<OpenclawRoster> {
    const result = (await client.request<GatewayListResult>("agents.list", {})) as GatewayListResult;
    const agents = (result.agents ?? []).map(normaliseAgent);
    const next: OpenclawRoster = {
      fetchedAtMs: Date.now(),
      defaultId: result.defaultId || null,
      agents,
    };
    roster = next;
    ready = true;
    // Phase 2: mirror into paperclip's table + stage token/skill on disk.
    if (deps.db) {
      try {
        const stagerResult: StagerResult = await stageRoster(
          {
            db: deps.db,
            config,
            skillSourcePath: deps.skillSourcePath ?? defaultSkillSourcePath(),
            resolveWorkspaceDir: (agent) => agent.workspace,
            log,
          },
          agents,
        );
        if (
          stagerResult.upserted +
            stagerResult.retired +
            stagerResult.tokensMinted +
            stagerResult.filesWritten >
          0
        ) {
          log(
            `mirror staged: upserted=${stagerResult.upserted} retired=${stagerResult.retired} tokens=${stagerResult.tokensMinted} files=${stagerResult.filesWritten}`,
          );
        }
      } catch (err) {
        log("mirror staging failed", { err: String(err) });
      }
    }
    return next;
  }

  function scheduleNextSync() {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      void fetchRosterOnce()
        .catch((err) => log("sync failed", { err: String(err) }))
        .finally(scheduleNextSync);
    }, config.syncIntervalMs);
    timer.unref?.();
  }

  return {
    async start() {
      stopped = false;
      try {
        await client.connect();
        await fetchRosterOnce();
        log(`mirror ready: ${roster.agents.length} agents`);
      } catch (err) {
        log("initial sync failed; will retry on schedule", { err: String(err) });
      } finally {
        scheduleNextSync();
      }
    },
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      client.close();
    },
    getRoster: () => roster,
    refreshNow: () => fetchRosterOnce(),
    isReady: () => ready,
  };
}

export type { OpenclawBridgeConfig };
export { loadOpenclawBridgeConfig } from "./config.js";
