// Back-channel logout receiver for the Authentik IdP.
//
// Authentik POSTs a `logout_token` (JWT, OIDC Back-Channel Logout 1.0) to the
// URL we register on the OAuth2 provider. When validation succeeds we delete
// every better-auth session belonging to the OIDC-linked user. Validation is
// strict per spec — wrong iss/aud/missing events claim → 400.
//
// We deliberately do NOT take a runtime dependency on `jose` here; the JWKS
// + RS256 verification mirrors openclaw/src/gateway/oidc-bearer.ts and uses
// node:crypto only. Same code path as the gateway means same trust shape.

import { promises as fs } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import { URL } from "node:url";
import { createPublicKey, createVerify, type KeyObject } from "node:crypto";
import { eq, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authAccounts, authSessions } from "@paperclipai/db";
import {
  AUTHENTIK_PROVIDER_ID,
  loadPaperclipOidcConfig,
  resolveOidcConfigPath,
} from "./oidc-config.js";
import { logger } from "../middleware/logger.js";

const BACK_CHANNEL_LOGOUT_EVENT_URI =
  "http://schemas.openid.net/event/backchannel-logout";

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
    throw new Error("JWKS response missing keys array");
  }
  const keysByKid = new Map<string, KeyObject>();
  for (const jwk of parsed.keys) {
    if (jwk.kty !== "RSA" || !jwk.n || !jwk.e || !jwk.kid) continue;
    const cryptoJwk: { [k: string]: string } = {
      kty: jwk.kty,
      n: jwk.n,
      e: jwk.e,
    };
    if (jwk.kid) cryptoJwk.kid = jwk.kid;
    if (jwk.alg) cryptoJwk.alg = jwk.alg;
    if (jwk.use) cryptoJwk.use = jwk.use;
    const pub = createPublicKey({ key: cryptoJwk, format: "jwk" });
    keysByKid.set(jwk.kid, pub);
  }
  jwksByIssuer.set(issuer, { fetchedAt: Date.now(), keysByKid });
  return keysByKid;
}

function b64urlDecode(input: string): Buffer {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

interface LogoutTokenPayload {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  iat?: number;
  jti?: string;
  sid?: string;
  events?: Record<string, unknown>;
  nonce?: string;
}

export interface VerifyLogoutTokenResult {
  sub: string | null;
  sid: string | null;
}

export async function verifyAuthentikLogoutToken(
  token: string,
  cfg: {
    issuer: string;
    client_id: string;
  },
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<VerifyLogoutTokenResult> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("logout_token is not a valid 3-part JWT");
  }
  const [headerB64, payloadB64, sigB64] = parts;
  const header = JSON.parse(b64urlDecode(headerB64).toString("utf8")) as {
    alg?: string;
    kid?: string;
  };
  if (header.alg !== "RS256") {
    throw new Error(`Only RS256 is supported; got ${header.alg}`);
  }
  if (!header.kid) {
    throw new Error("logout_token header missing kid");
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
  if (!verifier.verify(key, b64urlDecode(sigB64))) {
    throw new Error("logout_token signature did not verify");
  }
  const payload = JSON.parse(b64urlDecode(payloadB64).toString("utf8")) as LogoutTokenPayload;
  const expectedIssuer = cfg.issuer.endsWith("/") ? cfg.issuer.slice(0, -1) : cfg.issuer;
  const tokenIssuer = (payload.iss ?? "").replace(/\/$/, "");
  if (tokenIssuer !== expectedIssuer) {
    throw new Error(`logout_token iss mismatch: got ${tokenIssuer} expected ${expectedIssuer}`);
  }
  const audMatches = Array.isArray(payload.aud)
    ? payload.aud.includes(cfg.client_id)
    : payload.aud === cfg.client_id;
  if (!audMatches) {
    throw new Error(`logout_token aud does not include client_id=${cfg.client_id}`);
  }
  if (typeof payload.iat !== "number" || payload.iat > nowSec + 60) {
    throw new Error("logout_token iat invalid or in the future");
  }
  // OIDC back-channel logout: events MUST include the back-channel-logout URI.
  const events = payload.events ?? null;
  if (
    !events ||
    typeof events !== "object" ||
    !(BACK_CHANNEL_LOGOUT_EVENT_URI in events)
  ) {
    throw new Error("logout_token missing back-channel-logout events claim");
  }
  // Spec: a nonce claim is forbidden in logout tokens (distinguishes them
  // from id_tokens so a leaked logout_token can't be used as authentication).
  if (typeof payload.nonce === "string") {
    throw new Error("logout_token must not include a nonce claim");
  }
  const sub = typeof payload.sub === "string" && payload.sub.length > 0 ? payload.sub : null;
  const sid = typeof payload.sid === "string" && payload.sid.length > 0 ? payload.sid : null;
  if (!sub && !sid) {
    throw new Error("logout_token has neither sub nor sid");
  }
  return { sub, sid };
}

export interface InvalidateSessionsResult {
  matchedUsers: number;
  deletedSessions: number;
}

export async function invalidateOidcSessionsForSub(
  db: Db,
  sub: string,
): Promise<InvalidateSessionsResult> {
  const rows = await db
    .select({ userId: authAccounts.userId })
    .from(authAccounts)
    .where(
      and(
        eq(authAccounts.providerId, AUTHENTIK_PROVIDER_ID),
        eq(authAccounts.accountId, sub),
      ),
    );
  let deleted = 0;
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.userId)) continue;
    seen.add(row.userId);
    const result = await db
      .delete(authSessions)
      .where(eq(authSessions.userId, row.userId))
      .returning({ id: authSessions.id });
    deleted += result.length;
  }
  return { matchedUsers: seen.size, deletedSessions: deleted };
}

// Public handler used by the Express route. Returns the spec-required JSON
// body shapes (errors per the OIDC back-channel logout spec).
export async function handleBackChannelLogout(
  db: Db,
  rawLogoutToken: string | undefined,
): Promise<
  | { status: 200; body: object }
  | { status: 400 | 501; body: { error: string; error_description?: string } }
> {
  if (!rawLogoutToken || rawLogoutToken.length === 0) {
    return {
      status: 400,
      body: { error: "invalid_request", error_description: "missing logout_token" },
    };
  }
  const cfg = loadPaperclipOidcConfig();
  if (!cfg) {
    return {
      status: 501,
      body: {
        error: "not_implemented",
        error_description: `OIDC not configured; expected ${resolveOidcConfigPath()}`,
      },
    };
  }
  let verified: VerifyLogoutTokenResult;
  try {
    verified = await verifyAuthentikLogoutToken(rawLogoutToken, cfg);
  } catch (err) {
    logger.warn({ err }, "back-channel logout: token rejected");
    return {
      status: 400,
      body: {
        error: "invalid_request",
        error_description: err instanceof Error ? err.message : String(err),
      },
    };
  }
  if (verified.sub) {
    try {
      const result = await invalidateOidcSessionsForSub(db, verified.sub);
      logger.info(
        { sub: verified.sub, sid: verified.sid, ...result },
        "back-channel logout: sessions invalidated",
      );
    } catch (err) {
      logger.error({ err, sub: verified.sub }, "back-channel logout: session invalidation failed");
      return {
        status: 400,
        body: {
          error: "invalid_request",
          error_description: "session invalidation failed",
        },
      };
    }
  } else {
    // Spec allows sid-only — but we don't store the IdP sid on the session
    // row, so we cannot map it back. Log and accept so Authentik doesn't
    // keep retrying; a future change can wire sid storage in.
    logger.warn(
      { sid: verified.sid },
      "back-channel logout: sid-only token received, but paperclip does not store IdP sid; accepting without action",
    );
  }
  return { status: 200, body: {} };
}
