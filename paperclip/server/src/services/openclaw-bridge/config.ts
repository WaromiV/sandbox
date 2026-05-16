/**
 * OpenClaw bridge configuration.
 *
 * The bridge keeps paperclip's view of agents identical to openclaw's
 * `agents.list` and stages a paperclip-issued token + skill into each
 * agent's openclaw workspace. Config is env-driven so deployments can
 * wire it without modifying paperclip's config file.
 *
 * As of the auto-bootstrap rewrite the bridge is fully self-bootstrapping:
 * it resolves (or creates on first boot) the paperclip company that
 * mirrors openclaw's roster, so operators no longer need to chase a
 * `OPENCLAW_MIRROR_COMPANY_ID` value or run paperclip's onboarding flow.
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
  /**
   * Display name of the paperclip company the bridge writes into.
   * Default: "OpenClaw". The bridge looks this up at startup; if the
   * company doesn't exist it gets created automatically.
   *
   * For migration from older installs that still use a pinned uuid
   * (`OPENCLAW_MIRROR_COMPANY_ID`), the uuid wins if both are set.
   */
  companyName: string;
  /**
   * Optional pinned company id. When set, overrides `companyName` and
   * the bridge will only mirror into that exact uuid (errors if it's
   * missing). Kept for back-compat with the original bridge release.
   */
  pinnedCompanyId: string | null;
};

const DEFAULT_SYNC_MS = 30_000;
const DEFAULT_COMPANY_NAME = "OpenClaw";

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
  return {
    url,
    token,
    paperclipApiUrl,
    syncIntervalMs,
    companyName: trimmed(env.OPENCLAW_MIRROR_COMPANY_NAME) ?? DEFAULT_COMPANY_NAME,
    pinnedCompanyId: trimmed(env.OPENCLAW_MIRROR_COMPANY_ID),
  };
}
