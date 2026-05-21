import type { IconName } from "../icons.js";

export type AgentSpace = {
  /** URL slug + tab suffix (e.g. "yaromir" → tab "editor:yaromir", path "/editor/yaromir"). */
  id: string;
  /** Display name shown in the sidebar tab and page header. */
  label: string;
  /** Filesystem folder that code-server should open for this agent space. */
  folder: string;
  /** Sidebar icon for this agent. */
  icon: IconName;
};

/**
 * Static catalog of agent spaces exposed as top-level sidebar tabs.
 *
 * The default list mirrors the agents found under
 * `~/.openclaw/workspace/agents/` on disk. Each entry maps a sidebar tab
 * to that agent's directory inside code-server, which the dev/Phase-2
 * docker layout bind-mounts at `/workspace`.
 *
 * Override at build time with `VITE_EDITOR_SPACES` — a JSON array of
 * `{id, label, folder, icon}` objects — when the deployment has a
 * different roster or workspace root.
 */
const AGENT_IDS = [
  "agent-manager",
  "designer",
  "flow-dev",
  "forwarder-dev",
  "gateway-builder",
  "marketing-lead",
  "office-dev",
  "security",
  "smm",
  "sofa",
  "tech-lead",
  "tech-writer",
  "viktor",
  "yaromir",
] as const;

// Best-effort icon hints. Agents that don't match a hint fall back to
// `folder`; visual distinction is mostly the label itself.
const ICON_HINTS: Record<string, IconName> = {
  "agent-manager": "folder",
  designer: "spark",
  "flow-dev": "terminal",
  "forwarder-dev": "send",
  "gateway-builder": "globe",
  "marketing-lead": "barChart",
  "office-dev": "monitor",
  security: "zap",
  smm: "messageSquare",
  sofa: "moon",
  "tech-lead": "brain",
  "tech-writer": "fileText",
  viktor: "user",
  yaromir: "user",
};

const DEFAULT_SPACES: AgentSpace[] = AGENT_IDS.map((id) => ({
  id,
  label: id,
  folder: `/workspace/agents/${id}`,
  icon: ICON_HINTS[id] ?? "folder",
}));

function parseOverride(raw: string | undefined): AgentSpace[] | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return null;
    }
    const out: AgentSpace[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const id = typeof e.id === "string" ? e.id : null;
      const folder = typeof e.folder === "string" ? e.folder : null;
      if (!id || !folder) continue;
      const label = typeof e.label === "string" && e.label.length > 0 ? e.label : id;
      const icon =
        typeof e.icon === "string" && e.icon.length > 0 ? (e.icon as IconName) : "folder";
      out.push({ id, label, folder, icon });
    }
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

let cached: AgentSpace[] | null = null;

export function getAgentSpaces(): AgentSpace[] {
  if (cached) return cached;
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  cached = parseOverride(env?.VITE_EDITOR_SPACES) ?? DEFAULT_SPACES;
  return cached;
}

/**
 * Build the agent-chip catalog from the live gateway `agents.list` result.
 * Falls back to the build-time defaults when the gateway hasn't returned
 * data yet (e.g. first paint before WS connect).
 */
export function spacesFromGatewayAgents(
  rows: ReadonlyArray<{ id: string; name?: string; workspace?: string }> | null | undefined,
): AgentSpace[] {
  if (!rows || rows.length === 0) return getAgentSpaces();
  return rows.map((r) => ({
    id: r.id,
    label: r.name && r.name.length > 0 ? r.name : r.id,
    folder: r.workspace && r.workspace.length > 0 ? r.workspace : `/workspace/agents/${r.id}`,
    icon: ICON_HINTS[r.id] ?? "folder",
  }));
}

/**
 * Special system workspace id for the OpenClaw runtime state directory
 * (`$HOME/.openclaw`). Distinct from agent spaces — it surfaces only inside
 * the editor rail as a dedicated entry, not in the agent chip strip.
 */
export const OPENCLAW_STATE_SPACE_ID = "openclaw-state" as const;

function getOpenClawStateFolder(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  // Default to `~/.openclaw`; code-server expands `~` to the host user home.
  // Override via `VITE_OPENCLAW_STATE_FOLDER` for deployments that bind-mount
  // the state dir elsewhere (e.g. docker layouts).
  return env?.VITE_OPENCLAW_STATE_FOLDER ?? "~/.openclaw";
}

const SYSTEM_SPACES: AgentSpace[] = [
  {
    id: OPENCLAW_STATE_SPACE_ID,
    label: ".openclaw",
    folder: getOpenClawStateFolder(),
    icon: "folder",
  },
];

export function getSystemSpaces(): AgentSpace[] {
  return SYSTEM_SPACES;
}

export function isSystemSpaceId(id: string | null | undefined): boolean {
  if (!id) return false;
  return SYSTEM_SPACES.some((s) => s.id === id);
}

export const EDITOR_TAB_PREFIX = "editor:" as const;

export function tabIdForSpace(space: AgentSpace): string {
  return `${EDITOR_TAB_PREFIX}${space.id}`;
}

export function pathForSpace(space: AgentSpace): string {
  return `/editor/${space.id}`;
}

export function spaceIdFromTab(tab: string): string | null {
  return tab.startsWith(EDITOR_TAB_PREFIX) ? tab.slice(EDITOR_TAB_PREFIX.length) : null;
}

export function findSpaceById(id: string | null | undefined): AgentSpace | undefined {
  if (!id) return undefined;
  return (
    getAgentSpaces().find((s) => s.id === id) ?? SYSTEM_SPACES.find((s) => s.id === id)
  );
}

export function findSpaceByTab(tab: string): AgentSpace | undefined {
  return findSpaceById(spaceIdFromTab(tab));
}
