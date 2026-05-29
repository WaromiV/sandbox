import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import {
  gatewayRequiresSudoPassword,
  isWorkerRunning,
  resolveStackUpdatePaths,
} from "../infra/stack-update-worker.js";
import { handleStackUpdateHttpRequest } from "./stack-update-http.js";
import type { ResolvedGatewayAuth } from "./auth.js";

function mkReq(method: string, url: string): IncomingMessage {
  return {
    method,
    url,
    headers: { host: "localhost" },
    socket: { remoteAddress: "127.0.0.1", encrypted: false },
  } as unknown as IncomingMessage;
}

type FakeRes = ServerResponse & {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  ended: boolean;
};

function mkRes(): FakeRes {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: "",
    ended: false,
    setHeader(key: string, value: string) {
      this.headers[key.toLowerCase()] = value;
    },
    end(chunk?: string) {
      if (chunk !== undefined) {
        this.body = String(chunk);
      }
      this.ended = true;
    },
  };
  return res as unknown as FakeRes;
}

// Auth is never consulted on these paths (route + method checks precede it), so
// a placeholder is fine.
const opts = { basePath: "/openclaw", auth: { mode: "none" } as unknown as ResolvedGatewayAuth };

describe("handleStackUpdateHttpRequest route + method gating", () => {
  it("returns false for an unrelated path (lets later stages handle it)", async () => {
    const res = mkRes();
    const handled = await handleStackUpdateHttpRequest(mkReq("GET", "/openclaw/other"), res, opts);
    expect(handled).toBe(false);
    expect(res.ended).toBe(false);
  });

  it("405s a GET on /update/run", async () => {
    const res = mkRes();
    const handled = await handleStackUpdateHttpRequest(mkReq("GET", "/openclaw/update/run"), res, opts);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe("POST");
  });

  it("405s a POST on /update/status", async () => {
    const res = mkRes();
    const handled = await handleStackUpdateHttpRequest(
      mkReq("POST", "/openclaw/update/status"),
      res,
      opts,
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe("GET");
  });

  it("respects a custom base path", async () => {
    const res = mkRes();
    const handled = await handleStackUpdateHttpRequest(mkReq("GET", "/update/run"), res, {
      ...opts,
      basePath: "/",
    });
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(405);
  });
});

describe("isWorkerRunning staleness guard", () => {
  const recent = new Date().toISOString();
  const old = new Date(Date.now() - 60 * 60_000).toISOString();

  it("is false for no status / terminal phases", () => {
    expect(isWorkerRunning(null)).toBe(false);
    expect(isWorkerRunning({ phase: "done" })).toBe(false);
    expect(isWorkerRunning({ phase: "error" })).toBe(false);
    expect(isWorkerRunning({ phase: "idle" })).toBe(false);
  });

  it("is false when the recorded pid is dead", () => {
    expect(isWorkerRunning({ phase: "running", pid: 2_000_000_000, updatedAt: recent })).toBe(false);
  });

  it("is false when an active status is stale", () => {
    expect(isWorkerRunning({ phase: "restarting", pid: process.pid, updatedAt: old })).toBe(false);
  });

  it("is true for a fresh active status with a live pid", () => {
    expect(isWorkerRunning({ phase: "restarting", pid: process.pid, updatedAt: recent })).toBe(true);
  });
});

describe("worker helpers", () => {
  it("resolves a status file path under a non-empty state dir", () => {
    const paths = resolveStackUpdatePaths();
    expect(paths.stateDir.length).toBeGreaterThan(0);
    expect(paths.statusFile.endsWith(".update-status.json")).toBe(true);
    expect(paths.deployedFile.endsWith(".deployed.json")).toBe(true);
  });

  it("reports a boolean for the sudo-password requirement", () => {
    expect(typeof gatewayRequiresSudoPassword()).toBe("boolean");
  });
});
