import * as http from "node:http";
import * as net from "node:net";
import { URL } from "node:url";
import type { RequestHandler } from "express";
import {
  BRIDGE_COOKIE_NAME,
  BRIDGE_HEADER_NAME,
  bridgeCookieAttributes,
  mintBridgeToken,
  shouldRefresh,
  verifyBridgeToken,
} from "./token.js";

const EDITOR_PREFIX = "/editor";

export interface EditorBridgeOptions {
  upstreamUrl: string;
  isAuthenticated: (req: import("express").Request) => boolean;
  subjectOf: (req: import("express").Request) => string;
  // When set, the proxy asks the resolver for the user's Authentik id_token
  // and forwards it as `Authorization: Bearer <id_token>` so code-server
  // running with --auth oidc can validate against Authentik JWKS. Returning
  // null is the normal path for email/password users — the HMAC bridge cookie
  // continues to work and code-server in --auth bridge keeps validating it.
  idTokenForRequest?: (
    req: import("express").Request,
  ) => Promise<string | null> | string | null;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const piece of header.split(";")) {
    const eq = piece.indexOf("=");
    if (eq <= 0) continue;
    const k = piece.slice(0, eq).trim();
    const v = piece.slice(eq + 1).trim();
    if (k.length > 0) out[k] = v;
  }
  return out;
}

function stripEditorPrefix(originalUrl: string): string {
  if (originalUrl === EDITOR_PREFIX) return "/";
  if (originalUrl.startsWith(EDITOR_PREFIX + "/")) return originalUrl.slice(EDITOR_PREFIX.length) || "/";
  if (originalUrl.startsWith(EDITOR_PREFIX + "?")) return "/" + originalUrl.slice(EDITOR_PREFIX.length);
  return originalUrl;
}

function buildSetCookie(token: string): string {
  return `${BRIDGE_COOKIE_NAME}=${token}; ${bridgeCookieAttributes()}`;
}

function buildClearCookie(): string {
  return `${BRIDGE_COOKIE_NAME}=; Path=/editor; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function createEditorBridgeRouter(opts: EditorBridgeOptions): RequestHandler {
  const upstream = new URL(opts.upstreamUrl);
  const upstreamHost = upstream.hostname;
  const upstreamPort = parseInt(upstream.port || "80", 10);

  return async function editorBridge(req, res, next) {
    if (!opts.isAuthenticated(req)) {
      res.status(401).type("text/plain").send("paperclip session required");
      return;
    }
    const cookies = parseCookies(req.headers.cookie);
    const existingToken = cookies[BRIDGE_COOKIE_NAME];
    const existingPayload = await verifyBridgeToken(existingToken);

    let token = existingToken;
    let mintedHeader: string | undefined;
    if (!existingPayload || shouldRefresh(existingPayload)) {
      const minted = await mintBridgeToken(opts.subjectOf(req));
      token = minted.token;
      mintedHeader = buildSetCookie(minted.token);
    }

    const forwardPath = stripEditorPrefix(req.originalUrl);
    const headers: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) {
      // Strip the inbound Authorization so we never leak the user's
      // paperclip-side bearer (board API key, agent JWT, etc.) to code-server.
      // We re-set it below with the OIDC id_token when one is available.
      if (
        name === "host" ||
        name === "connection" ||
        name === "content-length" ||
        name === "authorization"
      )
        continue;
      if (value !== undefined) headers[name] = value as any;
    }
    headers["host"] = `${upstreamHost}:${upstreamPort}`;
    headers[BRIDGE_HEADER_NAME] = token!;
    headers["cookie"] = `${BRIDGE_COOKIE_NAME}=${token}`;
    headers["x-forwarded-proto"] = (req.headers["x-forwarded-proto"] as string) ?? "http";
    headers["x-forwarded-host"] = (req.headers["x-forwarded-host"] as string) ?? req.headers.host ?? "";
    headers["x-forwarded-prefix"] = EDITOR_PREFIX;

    if (opts.idTokenForRequest) {
      try {
        const idToken = await opts.idTokenForRequest(req);
        if (idToken && idToken.length > 0) {
          headers["authorization"] = `Bearer ${idToken}`;
        }
      } catch {
        // Resolver failure is non-fatal — falling back to the HMAC bridge
        // cookie keeps the editor usable while we log on the next layer.
      }
    }

    const upstreamReq = http.request(
      {
        host: upstreamHost,
        port: upstreamPort,
        method: req.method,
        path: forwardPath,
        headers,
      },
      (upstreamRes) => {
        const passHeaders = { ...upstreamRes.headers };
        if (mintedHeader) {
          const existingSetCookie = passHeaders["set-cookie"];
          if (Array.isArray(existingSetCookie)) {
            passHeaders["set-cookie"] = [...existingSetCookie, mintedHeader];
          } else if (typeof existingSetCookie === "string") {
            passHeaders["set-cookie"] = [existingSetCookie, mintedHeader];
          } else {
            passHeaders["set-cookie"] = [mintedHeader];
          }
        }
        res.writeHead(upstreamRes.statusCode ?? 502, passHeaders);
        upstreamRes.pipe(res);
      },
    );
    upstreamReq.on("error", (err) => {
      if (!res.headersSent) {
        res.status(502).type("text/plain").send(`editor upstream error: ${err.message}`);
      } else {
        res.end();
      }
    });
    req.on("aborted", () => upstreamReq.destroy());
    res.on("close", () => upstreamReq.destroy());
    req.pipe(upstreamReq);
  };
}

export interface EditorBridgeWebSocketOptions
  extends Omit<EditorBridgeOptions, "idTokenForRequest"> {
  // WS upgrades arrive before any Express middleware has run, so we resolve
  // the id_token from the raw IncomingMessage instead of the Express Request.
  idTokenForUpgrade?: (
    req: http.IncomingMessage,
  ) => Promise<string | null> | string | null;
}

export function attachEditorBridgeWebSocket(
  server: http.Server,
  opts: EditorBridgeWebSocketOptions,
): void {
  const upstream = new URL(opts.upstreamUrl);
  const upstreamHost = upstream.hostname;
  const upstreamPort = parseInt(upstream.port || "80", 10);

  server.on("upgrade", async (req, clientSocket, head) => {
    const url = req.url || "";
    if (!url.startsWith(EDITOR_PREFIX)) return;
    clientSocket.pause();

    const cookies = parseCookies(req.headers.cookie);
    const payload = await verifyBridgeToken(cookies[BRIDGE_COOKIE_NAME]);
    if (!payload) {
      clientSocket.end(
        "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      return;
    }

    let idToken: string | null = null;
    if (opts.idTokenForUpgrade) {
      try {
        idToken = (await opts.idTokenForUpgrade(req)) ?? null;
      } catch {
        idToken = null;
      }
    }

    const token = cookies[BRIDGE_COOKIE_NAME]!;
    const forwardPath = stripEditorPrefix(url);
    const upstreamSocket = net.connect(upstreamPort, upstreamHost, () => {
      const lines: string[] = [];
      lines.push(`${req.method} ${forwardPath} HTTP/1.1`);
      lines.push(`Host: ${upstreamHost}:${upstreamPort}`);
      for (const [name, value] of Object.entries(req.headers)) {
        if (
          name === "host" ||
          name === "content-length" ||
          // Drop the inbound Authorization for the same reason as the HTTP
          // path — we re-add Bearer <id_token> below when available.
          name === "authorization"
        ) {
          continue;
        }
        if (Array.isArray(value)) {
          for (const v of value) lines.push(`${name}: ${v}`);
        } else if (value !== undefined) {
          lines.push(`${name}: ${value as string}`);
        }
      }
      lines.push(`${BRIDGE_HEADER_NAME}: ${token}`);
      lines.push(`X-Forwarded-Prefix: ${EDITOR_PREFIX}`);
      if (idToken) {
        lines.push(`Authorization: Bearer ${idToken}`);
      }
      lines.push("");
      lines.push("");
      upstreamSocket.write(lines.join("\r\n"));
      if (head && head.length > 0) upstreamSocket.write(head);
      clientSocket.resume();
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    });
    upstreamSocket.on("error", () => {
      try {
        clientSocket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      } catch {
        /* socket may already be closed */
      }
      clientSocket.destroy();
    });
    clientSocket.on("error", () => upstreamSocket.destroy());
  });
}

export function logoutEditorBridge(_req: import("express").Request, res: import("express").Response): void {
  res.setHeader("Set-Cookie", buildClearCookie());
  res.status(204).end();
}
