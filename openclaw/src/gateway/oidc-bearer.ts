// OIDC bearer-token verification for the openclaw gateway.
//
// Validates an `Authorization: Bearer <id_token>` issued by Authentik against
// the OIDC client config persisted to ~/.openclaw/oidc/gateway.json (written
// by deploy/authentik/provision.sh in the sandbox).
//
// Returns the set of operator scopes the token should grant, derived from
// paperclip's /api/access/role authority endpoint. Currently:
//   role = "admin" -> full operator scope set
//   role = "user"  -> READ_SCOPE only
//
// Phase D ships this module standalone. The integration point that calls it
// from the existing `authorizeHttpGatewayConnect` switch lives in Phase E —
// see the SEAM-* comments in this file. Until then, this module is loaded
// only when something explicitly imports it.
//
// Owner-boundary note: this is a generic auth seam (validates JWTs, maps
// upstream role into the existing OperatorScope set). No owner-specific
// behavior — anyone can swap the OIDC config file for a different IdP.

import { promises as fs } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import { URL } from "node:url";
import { createPublicKey, createVerify, type KeyObject } from "node:crypto";

// SEAM-1: scope names must match values exported from operator-scopes.ts.
// We do not import from there to keep this file zero-cycle against the rest
// of the gateway; the constants are duplicated and unit-tested for parity
// in Phase E when the integration lands.
export const ADMIN_SCOPE = "operator.admin";
export const READ_SCOPE = "operator.read";
export const WRITE_SCOPE = "operator.write";
export const APPROVALS_SCOPE = "operator.approvals";
export const PAIRING_SCOPE = "operator.pairing";
export const TALK_SECRETS_SCOPE = "operator.talk-secrets";

const ADMIN_SCOPES: readonly string[] = [
  ADMIN_SCOPE,
  READ_SCOPE,
  WRITE_SCOPE,
  APPROVALS_SCOPE,
  PAIRING_SCOPE,
  TALK_SECRETS_SCOPE,
];
const USER_SCOPES: readonly string[] = [READ_SCOPE];

export interface OpenclawOidcConfig {
  issuer: string;
  client_id: string;
  client_secret: string;
  redirect_uri: string;
  scopes: string[];
  role_authority_url?: string;
}

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".openclaw", "oidc", "gateway.json");

export function resolveOidcConfigPath(): string {
  const override = process.env.OPENCLAW_OIDC_CONFIG_FILE?.trim();
  return override && override.length > 0 ? override : DEFAULT_CONFIG_PATH;
}

export async function loadOidcConfig(configFile?: string): Promise<OpenclawOidcConfig | null> {
  const filePath = configFile && configFile.length > 0 ? configFile : resolveOidcConfigPath();
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`OIDC config at ${filePath} is not a JSON object`);
  }
  const cfg = parsed as Partial<OpenclawOidcConfig>;
  for (const key of ["issuer", "client_id", "client_secret", "redirect_uri"] as const) {
    if (typeof cfg[key] !== "string" || cfg[key]!.length === 0) {
      throw new Error(`OIDC config at ${filePath} missing required field: ${key}`);
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

// --- JWKS cache ---------------------------------------------------------

interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

interface JwksCache {
  fetchedAt: number;
  keysByKid: Map<string, KeyObject>;
}

const JWKS_TTL_MS = 10 * 60 * 1000;
const jwksByIssuer = new Map<string, JwksCache>();

function fetchBuffer(url: string): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }
    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        method: "GET",
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      },
    );
    req.setTimeout(5000, () => req.destroy(new Error("JWKS request timed out")));
    req.on("error", reject);
    req.end();
  });
}

function jwksUrlFromIssuer(issuer: string): string {
  const base = issuer.endsWith("/") ? issuer : `${issuer}/`;
  return `${base}jwks/`;
}

async function getJwks(issuer: string): Promise<Map<string, KeyObject>> {
  const cached = jwksByIssuer.get(issuer);
  if (cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) {
    return cached.keysByKid;
  }
  const url = jwksUrlFromIssuer(issuer);
  const res = await fetchBuffer(url);
  if (res.status !== 200) {
    throw new Error(`JWKS fetch returned ${res.status} from ${url}`);
  }
  const parsed = JSON.parse(res.body.toString("utf8")) as { keys?: Jwk[] };
  if (!parsed.keys || !Array.isArray(parsed.keys)) {
    throw new Error(`JWKS response missing keys array`);
  }
  const keysByKid = new Map<string, KeyObject>();
  for (const jwk of parsed.keys) {
    if (jwk.kty !== "RSA" || !jwk.n || !jwk.e || !jwk.kid) continue;
    const pub = createPublicKey({ key: jwk as Jwk & { kty: "RSA"; n: string; e: string }, format: "jwk" });
    keysByKid.set(jwk.kid, pub);
  }
  jwksByIssuer.set(issuer, { fetchedAt: Date.now(), keysByKid });
  return keysByKid;
}

// --- JWT verification (RS256 only; the Authentik default) ---------------

interface JwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}

interface JwtPayload {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  email?: string;
  preferred_username?: string;
}

function b64urlDecode(input: string): Buffer {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

export async function verifyIdToken(
  token: string,
  cfg: OpenclawOidcConfig,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<JwtPayload> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("id_token is not a valid 3-part JWT");
  }
  const [headerB64, payloadB64, sigB64] = parts;
  const header = JSON.parse(b64urlDecode(headerB64).toString("utf8")) as JwtHeader;
  if (header.alg !== "RS256") {
    throw new Error(`Only RS256 is supported; got ${header.alg}`);
  }
  if (!header.kid) {
    throw new Error("id_token header missing kid");
  }
  const jwks = await getJwks(cfg.issuer);
  const key = jwks.get(header.kid);
  if (!key) {
    throw new Error(`No JWKS key matches kid=${header.kid}`);
  }
  const signedInput = `${headerB64}.${payloadB64}`;
  const verifier = createVerify("RSA-SHA256");
  verifier.update(signedInput);
  verifier.end();
  const sig = b64urlDecode(sigB64);
  if (!verifier.verify(key, sig)) {
    throw new Error("id_token signature did not verify");
  }
  const payload = JSON.parse(b64urlDecode(payloadB64).toString("utf8")) as JwtPayload;
  const expectedIssuer = cfg.issuer.endsWith("/") ? cfg.issuer.slice(0, -1) : cfg.issuer;
  const tokenIssuer = (payload.iss ?? "").replace(/\/$/, "");
  if (tokenIssuer !== expectedIssuer) {
    throw new Error(`id_token iss mismatch: got ${tokenIssuer} expected ${expectedIssuer}`);
  }
  const audClaim = payload.aud;
  const audMatches = Array.isArray(audClaim)
    ? audClaim.includes(cfg.client_id)
    : audClaim === cfg.client_id;
  if (!audMatches) {
    throw new Error(`id_token aud does not include client_id=${cfg.client_id}`);
  }
  if (typeof payload.exp !== "number" || payload.exp <= nowSec) {
    throw new Error("id_token expired");
  }
  if (typeof payload.iat === "number" && payload.iat > nowSec + 60) {
    throw new Error("id_token iat in the future (clock skew)");
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new Error("id_token missing sub claim");
  }
  return payload;
}

// --- Role authority -----------------------------------------------------

interface RoleAuthorityResponse {
  role?: "admin" | "user";
  userId?: string | null;
  email?: string | null;
}

interface RoleCacheEntry {
  scopes: readonly string[];
  expiresAt: number;
}

const ROLE_CACHE_TTL_MS = 60_000;
const roleScopesCache = new Map<string, RoleCacheEntry>();

export function clearOidcRoleCache(): void {
  roleScopesCache.clear();
}

function fetchJsonWithBearer(
  url: string,
  bearer: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }
    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        method: "GET",
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        headers: {
          authorization: `Bearer ${bearer}`,
          accept: "application/json",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: unknown = null;
          try {
            body = text.length > 0 ? JSON.parse(text) : null;
          } catch {
            body = text;
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.setTimeout(5000, () => req.destroy(new Error("role authority request timed out")));
    req.on("error", reject);
    req.end();
  });
}

export async function resolveScopesForOidcSubject(args: {
  sub: string;
  idToken: string;
  roleAuthorityUrl: string;
}): Promise<readonly string[]> {
  const cached = roleScopesCache.get(args.sub);
  if (cached && cached.expiresAt > Date.now()) return cached.scopes;
  const res = await fetchJsonWithBearer(args.roleAuthorityUrl, args.idToken);
  if (res.status !== 200 || !res.body || typeof res.body !== "object") {
    throw new Error(`role authority returned ${res.status}`);
  }
  const role = (res.body as RoleAuthorityResponse).role;
  const scopes = role === "admin" ? ADMIN_SCOPES : USER_SCOPES;
  roleScopesCache.set(args.sub, { scopes, expiresAt: Date.now() + ROLE_CACHE_TTL_MS });
  return scopes;
}

// --- Public entry point (call site for Phase E) ------------------------

export interface OidcBearerResult {
  ok: true;
  sub: string;
  email: string | null;
  scopes: readonly string[];
}

export interface OidcBearerFailure {
  ok: false;
  reason: "no_config" | "no_bearer" | "token_invalid" | "role_lookup_failed";
  message: string;
}

// SEAM-2: Phase E wires this into authorizeHttpGatewayConnect — try this
// path FIRST when the Authorization header looks like a JWT (three dot-
// separated base64url segments); fall through to the existing shared-secret
// path on no_config/no_bearer. token_invalid and role_lookup_failed are
// hard fails — do not silently fall back to shared secret (avoids
// confused-deputy issues where a stale JWT lets shared-secret auth slip in).
export async function tryVerifyOidcBearer(
  bearer: string | undefined,
  cfgOverride?: OpenclawOidcConfig | null,
): Promise<OidcBearerResult | OidcBearerFailure> {
  if (!bearer || bearer.length === 0) {
    return { ok: false, reason: "no_bearer", message: "no Authorization bearer" };
  }
  let cfg: OpenclawOidcConfig | null;
  if (cfgOverride === undefined) {
    cfg = await loadOidcConfig();
  } else {
    cfg = cfgOverride;
  }
  if (!cfg) {
    return { ok: false, reason: "no_config", message: "no OIDC config at ~/.openclaw/oidc/gateway.json" };
  }
  if (!cfg.role_authority_url) {
    return {
      ok: false,
      reason: "no_config",
      message: "OIDC config has no role_authority_url; cannot resolve scopes",
    };
  }
  let payload: JwtPayload;
  try {
    payload = await verifyIdToken(bearer, cfg);
  } catch (err) {
    return {
      ok: false,
      reason: "token_invalid",
      message: err instanceof Error ? err.message : String(err),
    };
  }
  const sub = payload.sub!;
  let scopes: readonly string[];
  try {
    scopes = await resolveScopesForOidcSubject({
      sub,
      idToken: bearer,
      roleAuthorityUrl: cfg.role_authority_url,
    });
  } catch (err) {
    return {
      ok: false,
      reason: "role_lookup_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
  return {
    ok: true,
    sub,
    email: payload.email ?? null,
    scopes,
  };
}

// Heuristic: does this header value look like a JWT (three b64url segments)?
// Phase E uses this to gate which auth path runs first.
export function looksLikeJwt(token: string | undefined | null): boolean {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  return parts.every((p) => p.length > 0 && /^[A-Za-z0-9_-]+$/.test(p));
}
