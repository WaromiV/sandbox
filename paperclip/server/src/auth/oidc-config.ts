import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Shape produced by deploy/authentik/provision.sh and consumed at boot.
// File lives at ~/.openclaw/oidc/paperclip.json with mode 0600. Presence of
// this file is the feature flag — when absent, OIDC integration stays dark.
export interface PaperclipOidcConfig {
  issuer: string;
  client_id: string;
  client_secret: string;
  redirect_uri: string;
  scopes?: string[];
  role_authority_url?: string;
}

const DEFAULT_PATH = path.join(os.homedir(), ".openclaw", "oidc", "paperclip.json");

export function resolveOidcConfigPath(): string {
  const override = process.env.PAPERCLIP_OIDC_CONFIG_FILE?.trim();
  return override && override.length > 0 ? override : DEFAULT_PATH;
}

export function loadPaperclipOidcConfig(): PaperclipOidcConfig | null {
  const configPath = resolveOidcConfigPath();
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`OIDC config at ${configPath} is not a JSON object`);
  }
  const cfg = parsed as Partial<PaperclipOidcConfig>;
  for (const key of ["issuer", "client_id", "client_secret", "redirect_uri"] as const) {
    if (typeof cfg[key] !== "string" || cfg[key]!.length === 0) {
      throw new Error(`OIDC config at ${configPath} missing required field: ${key}`);
    }
  }
  return {
    issuer: cfg.issuer!,
    client_id: cfg.client_id!,
    client_secret: cfg.client_secret!,
    redirect_uri: cfg.redirect_uri!,
    scopes: Array.isArray(cfg.scopes) && cfg.scopes.length > 0
      ? cfg.scopes.filter((s): s is string => typeof s === "string")
      : ["openid", "profile", "email"],
    role_authority_url: typeof cfg.role_authority_url === "string"
      ? cfg.role_authority_url
      : undefined,
  };
}

export function discoveryUrlFromIssuer(issuer: string): string {
  const base = issuer.endsWith("/") ? issuer : `${issuer}/`;
  return `${base}.well-known/openid-configuration`;
}

// Constant used in better-auth + as the URL suffix for the OAuth callback
// (the genericOAuth plugin mounts at /api/auth/oauth2/callback/<providerId>).
export const AUTHENTIK_PROVIDER_ID = "authentik";
