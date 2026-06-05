import { promises as fs } from "node:fs";
import * as path from "node:path";

const TOKEN_FILE = "paperclip-claimed-api-key.json";

type ClaimedKeyFile = {
  token: string;
  agentId: string;
  companyId: string;
  apiUrl: string;
};

/**
 * Reads the Paperclip claimed-API-key staged by the openclaw-bridge stager
 * and returns PAPERCLIP_* env vars for the agent run.
 *
 * Returns an empty object when the file is absent or unreadable (e.g. the
 * bridge is not configured for this deployment).
 */
export async function loadPaperclipRunEnv(
  workspaceDir: string | undefined | null,
): Promise<Record<string, string>> {
  if (!workspaceDir) return {};
  const tokenPath = path.join(workspaceDir, TOKEN_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(tokenPath, "utf8");
  } catch {
    return {};
  }
  let parsed: ClaimedKeyFile;
  try {
    parsed = JSON.parse(raw) as ClaimedKeyFile;
  } catch {
    return {};
  }
  if (!parsed.token || !parsed.agentId || !parsed.companyId || !parsed.apiUrl) {
    return {};
  }
  return {
    PAPERCLIP_API_KEY: parsed.token,
    PAPERCLIP_AGENT_ID: parsed.agentId,
    PAPERCLIP_COMPANY_ID: parsed.companyId,
    PAPERCLIP_API_URL: parsed.apiUrl,
  };
}
