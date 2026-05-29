import type { IncomingMessage, ServerResponse } from "node:http";
import type { TLSSocket } from "node:tls";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  gatewayEuid,
  gatewayRequiresSudoPassword,
  isWorkerRunning,
  launchStackUpdateWorker,
  readStackUpdateStatus,
} from "../infra/stack-update-worker.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { sendInvalidRequest, sendJson, sendMethodNotAllowed } from "./http-common.js";
import {
  authorizeScopedGatewayHttpRequestOrReply,
  resolveTrustedHttpOperatorScopes,
} from "./http-utils.js";

const log = createSubsystemLogger("gateway/stack-update");

const RUN_METHOD = "gateway.stack.update";
const STATUS_METHOD = "gateway.stack.update.status";
const MAX_BODY_BYTES = 8192;

type StackUpdateRoute = "run" | "status";

function resolveRoute(req: IncomingMessage, basePath: string): StackUpdateRoute | null {
  const base = basePath.replace(/\/$/, "");
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (pathname === `${base}/update/run`) {
    return "run";
  }
  if (pathname === `${base}/update/status`) {
    return "status";
  }
  return null;
}

// A sudo password may only cross the wire over TLS or from loopback — never over
// plaintext LAN HTTP.
function isSecureOrLoopback(req: IncomingMessage): boolean {
  if ((req.socket as TLSSocket).encrypted === true) {
    return true;
  }
  const addr = req.socket.remoteAddress ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

async function readOptionalJsonBody(
  req: IncomingMessage,
): Promise<{ sudoPassword?: string } | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (aborted) {
        resolve(null);
        return;
      }
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        resolve(parsed && typeof parsed === "object" ? (parsed as { sudoPassword?: string }) : {});
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

function runtimeInfo() {
  return { euid: gatewayEuid() ?? null, requiresSudoPassword: gatewayRequiresSudoPassword() };
}

async function handleStatus(res: ServerResponse): Promise<void> {
  const status = await readStackUpdateStatus();
  if (!status) {
    sendJson(res, 200, { phase: "idle", runtime: runtimeInfo() });
    return;
  }
  // Staleness guard: an "active" status whose worker is gone must not leave the
  // UI polling forever.
  const phase = typeof status.phase === "string" ? status.phase : "";
  const activeButGone =
    phase !== "done" && phase !== "error" && phase !== "idle" && !isWorkerRunning(status);
  if (activeButGone) {
    sendJson(res, 200, {
      ...status,
      phase: "error",
      error: { reason: "worker_vanished", message: "update worker is no longer running" },
      runtime: runtimeInfo(),
    });
    return;
  }
  sendJson(res, 200, { ...status, runtime: runtimeInfo() });
}

async function handleRun(req: IncomingMessage, res: ServerResponse, basePath: string): Promise<void> {
  const body = await readOptionalJsonBody(req);
  if (body === null) {
    sendInvalidRequest(res, "invalid request body");
    return;
  }
  const sudoPassword =
    typeof body.sudoPassword === "string" && body.sudoPassword.length > 0
      ? body.sudoPassword
      : undefined;
  if (sudoPassword && !isSecureOrLoopback(req)) {
    sendJson(res, 400, {
      ok: false,
      error: {
        type: "insecure_transport",
        message: "A password may only be sent over HTTPS or from loopback.",
      },
    });
    return;
  }

  const result = await launchStackUpdateWorker(sudoPassword ? { sudoPassword } : undefined);
  if (result.kind === "already-running") {
    sendJson(res, 409, {
      ok: false,
      error: { type: "conflict", message: "an update is already in progress" },
      status: result.status,
    });
    return;
  }
  if (result.kind === "error") {
    log.warn("failed to launch stack update", { message: result.message });
    sendJson(res, 500, { ok: false, error: { type: "launch_failed", message: result.message } });
    return;
  }
  const base = basePath.replace(/\/$/, "");
  sendJson(res, 202, {
    ok: true,
    accepted: true,
    launchMethod: result.launchMethod,
    runStartedAt: result.startedAt,
    statusUrl: `${base}/update/status`,
    runtime: runtimeInfo(),
  });
}

export async function handleStackUpdateHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    basePath: string;
    auth: ResolvedGatewayAuth;
    getResolvedAuth?: () => ResolvedGatewayAuth;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
  },
): Promise<boolean> {
  const route = resolveRoute(req, opts.basePath);
  if (route === null) {
    return false;
  }
  if (route === "run" && req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }
  if (route === "status" && req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
    return true;
  }

  // Both routes are admin-only: gate them behind the same operator.admin scope
  // that update.run / gateway.restart.request already use.
  const authResult = await authorizeScopedGatewayHttpRequestOrReply({
    req,
    res,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
    operatorMethod: route === "run" ? RUN_METHOD : STATUS_METHOD,
    resolveOperatorScopes: resolveTrustedHttpOperatorScopes,
  });
  if (!authResult) {
    return true;
  }

  if (route === "status") {
    await handleStatus(res);
    return true;
  }
  await handleRun(req, res, opts.basePath);
  return true;
}
