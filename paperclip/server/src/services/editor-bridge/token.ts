// DEPRECATED — superseded by Authentik id_token forwarding.
//
// HMAC bridge tokens were the pre-SSO trust mechanism between the paperclip
// editor proxy and code-server. After Phase E of the SSO migration the proxy
// forwards the user's Authentik id_token as the Bearer header and code-server
// validates it against JWKS. This module is kept compiled for one release as
// a rollback path; new code paths should not call into it.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const TOKEN_VERSION = "v1";
const HMAC_ALGO = "sha256";

export const BRIDGE_COOKIE_NAME = process.env.PAPERCLIP_BRIDGE_COOKIE ?? "pc_bridge";
export const BRIDGE_HEADER_NAME = (process.env.PAPERCLIP_BRIDGE_HEADER ?? "x-paperclip-bridge").toLowerCase();

const DEFAULT_TTL_SECONDS = 900;
const REFRESH_THRESHOLD_SECONDS = 300;

export interface BridgePayload {
  v: 1;
  sub: string;
  iat: number;
  exp: number;
  jti: string;
}

let cachedSecret: Buffer | null = null;

export function clearBridgeSecretCache(): void {
  cachedSecret = null;
}

export async function loadBridgeSecret(): Promise<Buffer> {
  if (cachedSecret) return cachedSecret;
  const envHex = process.env.PAPERCLIP_BRIDGE_SECRET;
  if (envHex && envHex.length > 0) {
    const buf = Buffer.from(envHex, "hex");
    if (buf.length < 16) throw new Error("PAPERCLIP_BRIDGE_SECRET must be at least 16 bytes hex");
    cachedSecret = buf;
    return buf;
  }
  const filePath =
    process.env.PAPERCLIP_BRIDGE_SECRET_FILE ?? path.join(os.homedir(), ".openclaw", "bridge.secret");
  const raw = (await fs.readFile(filePath, "utf8")).trim();
  const buf = Buffer.from(raw, "hex");
  if (buf.length < 16) throw new Error(`bridge secret in ${filePath} must be at least 16 bytes hex`);
  cachedSecret = buf;
  return buf;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function b64urlDecode(input: string): Buffer {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

export async function mintBridgeToken(subject: string, opts: { ttlSeconds?: number } = {}): Promise<{
  token: string;
  payload: BridgePayload;
}> {
  const secret = await loadBridgeSecret();
  const ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const now = Math.floor(Date.now() / 1000);
  const payload: BridgePayload = {
    v: 1,
    sub: subject,
    iat: now,
    exp: now + ttl,
    jti: randomBytes(8).toString("hex"),
  };
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = b64url(createHmac(HMAC_ALGO, secret).update(`${TOKEN_VERSION}.${payloadB64}`).digest());
  return { token: `${TOKEN_VERSION}.${payloadB64}.${sig}`, payload };
}

export async function verifyBridgeToken(token: string | undefined): Promise<BridgePayload | null> {
  if (!token || typeof token !== "string" || token.length > 4096) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [ver, payloadB64, sigB64] = parts;
  if (ver !== TOKEN_VERSION) return null;
  const secret = await loadBridgeSecret();
  let sig: Buffer;
  try {
    sig = b64urlDecode(sigB64);
  } catch {
    return null;
  }
  const expected = createHmac(HMAC_ALGO, secret).update(`${ver}.${payloadB64}`).digest();
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
  let parsed: BridgePayload;
  try {
    const raw = b64urlDecode(payloadB64).toString("utf8");
    const obj = JSON.parse(raw);
    if (
      obj?.v !== 1 ||
      typeof obj.sub !== "string" ||
      typeof obj.iat !== "number" ||
      typeof obj.exp !== "number" ||
      typeof obj.jti !== "string"
    ) {
      return null;
    }
    parsed = obj as BridgePayload;
  } catch {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (parsed.exp <= now) return null;
  if (parsed.iat > now + 60) return null;
  return parsed;
}

export function shouldRefresh(payload: BridgePayload, now: number = Math.floor(Date.now() / 1000)): boolean {
  return payload.exp - now < REFRESH_THRESHOLD_SECONDS;
}

export function bridgeCookieAttributes(): string {
  const attrs = [
    `Path=/editor`,
    `HttpOnly`,
    `SameSite=Lax`,
    `Max-Age=${DEFAULT_TTL_SECONDS}`,
  ];
  return attrs.join("; ");
}
