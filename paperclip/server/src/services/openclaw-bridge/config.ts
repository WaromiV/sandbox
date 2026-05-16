/**
 * OpenClaw bridge configuration.
 *
 * The bridge keeps paperclip's view of agents identical to openclaw's
 * `agents.list` and stages a paperclip-issued token + skill into each
 * agent's openclaw workspace. Config is env-driven so deployments can
 * wire it without modifying paperclip's config file.
 */

export type OpenclawBridgeConfig = {
  /** ws:// or wss:// URL of the openclaw gateway, e.g. ws://localhost:18789 */
  url: string;
  /** Bearer token for the openclaw gateway (`OPENCLAW_GATEWAY_TOKEN`). */
  token: string;
  /** Paperclip base URL advertised to agents (the URL the skill calls). */
  paperclipApiUrl: string;
  /** Sync cadence in ms (default 30s). */
  syncIntervalMs: number;
  /** Company id mirrored agents are attached to. */
  companyId: string;
};

const DEFAULT_SYNC_MS = 30_000;

function trimmed(value: string | undefined | null): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t.length > 0 ? t : null;
}

export function loadOpenclawBridgeConfig(
  env: NodeJS.ProcessEnv = process.env,
): OpenclawBridgeConfig | null {
  const url = trimmed(env.OPENCLAW_GATEWAY_URL);
  const token = trimmed(env.OPENCLAW_GATEWAY_TOKEN);
  if (!url || !token) {
    return null;
  }
  const paperclipApiUrl =
    trimmed(env.PAPERCLIP_PUBLIC_URL) ??
    trimmed(env.PAPERCLIP_API_URL) ??
    `http://localhost:${trimmed(env.PORT) ?? "3100"}`;
  const intervalRaw = Number(trimmed(env.OPENCLAW_SYNC_INTERVAL_MS) ?? "");
  const syncIntervalMs =
    Number.isFinite(intervalRaw) && intervalRaw >= 1000 ? Math.floor(intervalRaw) : DEFAULT_SYNC_MS;
  // For Phase 1 we mirror against a single configured company. Multi-company
  // support is a follow-up — once paperclip's UI lets the operator pick which
  // company each openclaw roster maps to.
  const companyId = trimmed(env.OPENCLAW_MIRROR_COMPANY_ID);
  if (!companyId) {
    return null;
  }
  return { url, token, paperclipApiUrl, syncIntervalMs, companyId };
}
