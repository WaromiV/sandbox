/**
 * Per-user workspace proxy. Routes /editor (code-server) and /openclaw
 * (gateway control UI) to the requesting user's own container, resolved from
 * their paperclip session. Replaces the single shared upstream — each user
 * now reaches only their own isolated container.
 *
 * Reuses the raw http/net proxy approach (no proxy dependency) and ensures the
 * container exists before forwarding. Identity comes from the paperclip
 * session, so it works behind Authentik forward-auth and in dev alike.
 */
import * as http from "node:http";
import * as net from "node:net";
import type { RequestHandler, Request } from "express";
import { ensureUserContainer, invalidateEnsured } from "./manager.js";

export type WorkspaceUser = { userId: string; email: string | null };
export type WorkspaceUserResolver = (
  headers: http.IncomingHttpHeaders,
) => Promise<WorkspaceUser | null>;

export type WorkspaceTarget = "editor" | "gateway";

const PREFIXES: Record<string, WorkspaceTarget> = {
  "/editor": "editor",
  "/openclaw": "gateway",
};

function targetForUrl(url: string): { prefix: string; target: WorkspaceTarget } | null {
  for (const [prefix, target] of Object.entries(PREFIXES)) {
    if (url === prefix || url.startsWith(prefix + "/") || url.startsWith(prefix + "?")) {
      return { prefix, target };
    }
  }
  return null;
}

function stripPrefix(prefix: string, originalUrl: string): string {
  if (originalUrl === prefix) return "/";
  if (originalUrl.startsWith(prefix + "/")) return originalUrl.slice(prefix.length) || "/";
  if (originalUrl.startsWith(prefix + "?")) return "/" + originalUrl.slice(prefix.length);
  return originalUrl;
}

function portFor(target: WorkspaceTarget, c: { codeServerPort: number; gatewayPort: number }): number {
  return target === "editor" ? c.codeServerPort : c.gatewayPort;
}

/**
 * Express middleware proxying /editor and /openclaw HTTP requests to the
 * session user's container. Mount BEFORE express.json so the request body
 * stream stays intact for piping.
 */
export function createWorkspaceProxyRouter(resolveUser: WorkspaceUserResolver): RequestHandler {
  return function workspaceProxy(req: Request, res, next) {
    const match = targetForUrl(req.originalUrl);
    if (!match) return next();
    void (async () => {
      const who = await resolveUser(req.headers);
      if (!who) {
        res.status(401).type("text/plain").send("paperclip session required");
        return;
      }
      let container;
      try {
        container = await ensureUserContainer(who.userId, who.email);
      } catch (err) {
        res.status(502).type("text/plain").send(`workspace start failed: ${(err as Error).message}`);
        return;
      }
      const port = portFor(match.target, container);
      const forwardPath = stripPrefix(match.prefix, req.originalUrl);
      const headers: http.OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (name === "host" || name === "connection" || name === "content-length") continue;
        if (value !== undefined) headers[name] = value as string | string[];
      }
      headers["host"] = `127.0.0.1:${port}`;
      headers["x-forwarded-proto"] = (req.headers["x-forwarded-proto"] as string) ?? "http";
      headers["x-forwarded-host"] = (req.headers["x-forwarded-host"] as string) ?? req.headers.host ?? "";
      headers["x-forwarded-prefix"] = match.prefix;

      const upstreamReq = http.request(
        { host: "127.0.0.1", port, method: req.method, path: forwardPath, headers },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(res);
        },
      );
      upstreamReq.on("error", (err) => {
        invalidateEnsured(who.userId);
        if (!res.headersSent) res.status(502).type("text/plain").send(`workspace upstream error: ${err.message}`);
        else res.end();
      });
      req.on("aborted", () => upstreamReq.destroy());
      res.on("close", () => upstreamReq.destroy());
      req.pipe(upstreamReq);
    })().catch(() => {
      if (!res.headersSent) res.status(500).end();
    });
  };
}

/**
 * WebSocket upgrade handling for /editor and /openclaw (code-server and the
 * gateway both use WS). Forwards the raw handshake to the user's container.
 * Additive: ignores upgrades for other paths so existing WS servers still run.
 */
export function attachWorkspaceProxyUpgrade(
  server: http.Server,
  resolveUser: WorkspaceUserResolver,
): void {
  server.on("upgrade", (req, clientSocket, head) => {
    const url = req.url || "";
    const match = targetForUrl(url);
    if (!match) return; // not ours — leave for other upgrade listeners
    clientSocket.pause();
    void (async () => {
      const who = await resolveUser(req.headers);
      if (!who) {
        clientSocket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      const container = await ensureUserContainer(who.userId, who.email);
      const port = portFor(match.target, container);
      const forwardPath = stripPrefix(match.prefix, url);
      const upstreamSocket = net.connect(port, "127.0.0.1", () => {
        const lines: string[] = [];
        lines.push(`${req.method} ${forwardPath} HTTP/1.1`);
        lines.push(`Host: 127.0.0.1:${port}`);
        for (const [name, value] of Object.entries(req.headers)) {
          if (name === "host" || name === "content-length") continue;
          if (Array.isArray(value)) for (const v of value) lines.push(`${name}: ${v}`);
          else if (value !== undefined) lines.push(`${name}: ${value as string}`);
        }
        lines.push(`X-Forwarded-Prefix: ${match.prefix}`);
        lines.push("");
        lines.push("");
        upstreamSocket.write(lines.join("\r\n"));
        if (head && head.length) upstreamSocket.write(head);
        upstreamSocket.pipe(clientSocket);
        clientSocket.pipe(upstreamSocket);
        clientSocket.resume();
      });
      upstreamSocket.on("error", () => {
        invalidateEnsured(who.userId);
        clientSocket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      });
      clientSocket.on("error", () => upstreamSocket.destroy());
    })().catch(() => {
      clientSocket.end("HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    });
  });
}
