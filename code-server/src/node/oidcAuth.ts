// OIDC validation + role lookup for code-server's --auth oidc mode.
//
// Design:
//   1. Each incoming request must carry an Authorization: Bearer <id_token>
//      header (or, fallback, a session cookie set by a future browser-OIDC
//      flow — not implemented in Phase C). Paperclip's editor-bridge proxy
//      forwards the user's Authentik id_token as the Bearer.
//   2. The id_token is verified against Authentik's JWKS (cached for 10 min).
//      Invalid signature, expired, wrong audience, wrong issuer → reject.
//   3. We then ask paperclip's /api/access/role endpoint whether this
//      subject is an admin. Result is cached per-sub for 60s so demotion
//      takes effect within one minute without per-request RTT.
//   4. Only "admin" role gets through. Anything else → 403.
//
// Why not full code-flow inside code-server? Phase C ships Bearer-only —
// covers the paperclip-proxied path (the only realistic access in dev) and
// is a fraction of the surface. Direct browser → code-server can be added
// later by mounting /oidc/login + /oidc/callback that exchange a code with
// Authentik and set a cookie.

import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyResult } from "jose"
import { promises as fs } from "fs"
import * as http from "http"
import * as https from "https"
import * as os from "os"
import * as path from "path"
import { URL } from "url"

export interface OidcClientConfig {
  issuer: string
  client_id: string
  client_secret: string
  redirect_uri: string
  scopes: string[]
  role_authority_url?: string
}

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".openclaw", "oidc", "codeserver.json")

export async function loadOidcConfig(configFile?: string): Promise<OidcClientConfig> {
  const filePath = configFile && configFile.length > 0 ? configFile : DEFAULT_CONFIG_PATH
  const raw = await fs.readFile(filePath, "utf8")
  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`OIDC config at ${filePath} is not a JSON object`)
  }
  for (const key of ["issuer", "client_id", "client_secret", "redirect_uri"] as const) {
    if (typeof parsed[key] !== "string" || parsed[key].length === 0) {
      throw new Error(`OIDC config at ${filePath} missing required field: ${key}`)
    }
  }
  return {
    issuer: parsed.issuer,
    client_id: parsed.client_id,
    client_secret: parsed.client_secret,
    redirect_uri: parsed.redirect_uri,
    scopes: Array.isArray(parsed.scopes) && parsed.scopes.length > 0
      ? parsed.scopes.filter((s: unknown): s is string => typeof s === "string")
      : ["openid", "profile", "email"],
    role_authority_url: typeof parsed.role_authority_url === "string"
      ? parsed.role_authority_url
      : undefined,
  }
}

// --- JWKS cache ---------------------------------------------------------

let cachedJwks: ReturnType<typeof createRemoteJWKSet> | undefined
let cachedJwksIssuer: string | undefined

function getJwks(issuer: string): ReturnType<typeof createRemoteJWKSet> {
  if (cachedJwks && cachedJwksIssuer === issuer) return cachedJwks
  const jwksUri = new URL(
    (issuer.endsWith("/") ? issuer : `${issuer}/`) + "jwks/",
  )
  cachedJwks = createRemoteJWKSet(jwksUri, { cooldownDuration: 30_000 })
  cachedJwksIssuer = issuer
  return cachedJwks
}

export async function verifyIdToken(
  token: string,
  cfg: OidcClientConfig,
): Promise<JWTVerifyResult<JWTPayload>> {
  const jwks = getJwks(cfg.issuer)
  return jwtVerify(token, jwks, {
    issuer: cfg.issuer.endsWith("/") ? cfg.issuer.slice(0, -1) : cfg.issuer,
    audience: cfg.client_id,
  })
}

// --- Bearer / cookie extraction -----------------------------------------

export function readIdTokenFromRequest(
  req: http.IncomingMessage & { cookies?: Record<string, string>; headers: http.IncomingHttpHeaders },
  cookieName: string,
): string | undefined {
  const authz = req.headers["authorization"]
  if (typeof authz === "string") {
    const m = authz.match(/^Bearer\s+(.+)$/i)
    if (m) return m[1].trim()
  }
  if (req.cookies && typeof req.cookies[cookieName] === "string") {
    const v = req.cookies[cookieName].trim()
    if (v.length > 0) return v
  }
  return undefined
}

// --- Role cache ---------------------------------------------------------

interface RoleCacheEntry {
  role: "admin" | "user"
  expiresAt: number
}

const ROLE_CACHE_TTL_MS = 60_000
const roleCache = new Map<string, RoleCacheEntry>()

export function clearRoleCache(): void {
  roleCache.clear()
}

function fetchJson(url: string, idToken: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch (err) {
      reject(err)
      return
    }
    const lib = parsed.protocol === "https:" ? https : http
    const req = lib.request(
      {
        method: "GET",
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        headers: {
          authorization: `Bearer ${idToken}`,
          accept: "application/json",
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (chunk) => chunks.push(chunk))
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8")
          let body: unknown = null
          try {
            body = text.length > 0 ? JSON.parse(text) : null
          } catch {
            body = text
          }
          resolve({ status: res.statusCode ?? 0, body })
        })
      },
    )
    req.setTimeout(5000, () => req.destroy(new Error("role authority request timed out")))
    req.on("error", reject)
    req.end()
  })
}

export async function resolveRoleFromAuthority(args: {
  sub: string
  idToken: string
  url: string
}): Promise<"admin" | "user"> {
  const cached = roleCache.get(args.sub)
  if (cached && cached.expiresAt > Date.now()) return cached.role
  const res = await fetchJson(args.url, args.idToken)
  if (res.status !== 200 || !res.body || typeof res.body !== "object") {
    throw new Error(`role authority returned ${res.status}`)
  }
  const raw = (res.body as { role?: unknown }).role
  const role = raw === "admin" ? "admin" : "user"
  roleCache.set(args.sub, { role, expiresAt: Date.now() + ROLE_CACHE_TTL_MS })
  return role
}

// --- Public check (consumed by http.ts:authenticated) -------------------

export interface OidcCheckArgs {
  token: string
  cfg: OidcClientConfig
  roleAuthorityUrl: string
}

export interface OidcCheckOk {
  ok: true
  sub: string
  email?: string
  role: "admin" | "user"
}

export interface OidcCheckFail {
  ok: false
  reason: "token_invalid" | "role_lookup_failed" | "forbidden"
  message: string
}

export async function performOidcCheck(args: OidcCheckArgs): Promise<OidcCheckOk | OidcCheckFail> {
  let payload: JWTPayload
  try {
    const verified = await verifyIdToken(args.token, args.cfg)
    payload = verified.payload
  } catch (err) {
    return {
      ok: false,
      reason: "token_invalid",
      message: err instanceof Error ? err.message : String(err),
    }
  }
  const sub = typeof payload.sub === "string" ? payload.sub : ""
  if (!sub) {
    return { ok: false, reason: "token_invalid", message: "id_token has no sub claim" }
  }
  let role: "admin" | "user"
  try {
    role = await resolveRoleFromAuthority({
      sub,
      idToken: args.token,
      url: args.roleAuthorityUrl,
    })
  } catch (err) {
    return {
      ok: false,
      reason: "role_lookup_failed",
      message: err instanceof Error ? err.message : String(err),
    }
  }
  if (role !== "admin") {
    return {
      ok: false,
      reason: "forbidden",
      message: "code-server access requires admin role",
    }
  }
  return {
    ok: true,
    sub,
    email: typeof payload.email === "string" ? payload.email : undefined,
    role,
  }
}
