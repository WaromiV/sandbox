import { WebSocket } from "ws";
import { randomUUID } from "node:crypto";

/**
 * Minimal openclaw gateway RPC client.
 *
 * Implements just enough of the wire protocol (`{type:"req"|"res"|"event"}`)
 * to call `agents.list` and `agents.files.set` from paperclip. Reuses one
 * connection for the lifetime of the bridge process; reconnects on close.
 *
 * Not exhaustive — for paperclip's adapter the full client lives in
 * `packages/adapters/openclaw-gateway/src/server/execute.ts`. This is a
 * lightweight cousin used only by the agent mirror sync.
 */

type RpcFrame =
  | { type: "req"; id: string; method: string; params: unknown }
  | {
      type: "res";
      id: string;
      ok: boolean;
      payload?: unknown;
      error?: { code: string; message: string };
    }
  | { type: "event"; event: string; payload?: unknown };

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export type RpcClientOptions = {
  url: string;
  token: string;
  /** Extra headers for the WS upgrade (e.g. x-paperclip-user for gateways in trusted-proxy auth mode). */
  headers?: Record<string, string>;
  /** Base reconnect delay when the socket drops; backs off exponentially. */
  reconnectDelayMs?: number;
  /** Cap for the exponential reconnect backoff (default 60s). */
  maxReconnectDelayMs?: number;
  /** Per-request timeout. */
  requestTimeoutMs?: number;
  onEvent?: (event: string, payload: unknown) => void;
  onConnect?: () => void;
  onClose?: () => void;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
};

export class OpenclawRpcClient {
  private ws: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private readonly pending = new Map<string, Pending>();
  private closed = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly reconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private reconnectAttempts = 0;
  private readonly requestTimeoutMs: number;

  constructor(private readonly opts: RpcClientOptions) {
    this.reconnectDelayMs = opts.reconnectDelayMs ?? 5_000;
    // Cap at 60s: a returning user's idle-stopped container is remirrored
    // within ~1 min, and the retries (fast ECONNREFUSED) are cheap.
    this.maxReconnectDelayMs = opts.maxReconnectDelayMs ?? 60_000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 20_000;
  }

  /** True once the WS is OPEN *and* the `connect` handshake is acknowledged. */
  private handshakeOk = false;

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.handshakeOk;
  }

  private log(msg: string, meta?: Record<string, unknown>) {
    this.opts.log?.(msg, meta);
  }

  async connect(): Promise<void> {
    if (this.isOpen()) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.openSocket().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = new URL(this.opts.url);
      // The gateway accepts `?token=` for browser-style connect.
      url.searchParams.set("token", this.opts.token);
      const ws = new WebSocket(url.toString(), {
        headers: { "X-OpenClaw-Token": this.opts.token, ...(this.opts.headers ?? {}) },
      });
      let settled = false;
      ws.once("open", () => {
        this.ws = ws;
        this.log("openclaw rpc socket open; performing connect handshake");
        // Gateway protocol requires `connect` as the first request frame.
        this.performHandshake(ws)
          .then(() => {
            this.handshakeOk = true;
            settled = true;
            this.reconnectAttempts = 0; // recovered — reset backoff
            this.opts.onConnect?.();
            this.log("openclaw rpc handshake ok");
            resolve();
          })
          .catch((err) => {
            settled = true;
            this.handshakeOk = false;
            try {
              ws.close();
            } catch {
              // ignore
            }
            reject(err);
          });
      });
      ws.once("error", (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        } else {
          this.log("openclaw rpc error", { err: String(err) });
        }
      });
      ws.on("close", () => {
        const wasEstablished = this.handshakeOk;
        this.ws = null;
        this.handshakeOk = false;
        for (const pending of this.pending.values()) {
          pending.reject(new Error("openclaw rpc connection closed"));
        }
        this.pending.clear();
        this.opts.onClose?.();
        // Only log a genuine drop of an established connection; repeated
        // failed-connect closes are covered by the backoff announcement.
        if (wasEstablished) {
          this.log("openclaw rpc closed");
        }
        if (!this.closed) {
          this.scheduleReconnect();
        }
      });
      ws.on("message", (data) => {
        let frame: RpcFrame;
        try {
          frame = JSON.parse(data.toString()) as RpcFrame;
        } catch {
          return;
        }
        if (frame.type === "res") {
          const pending = this.pending.get(frame.id);
          if (!pending) return;
          this.pending.delete(frame.id);
          if (frame.ok) {
            pending.resolve(frame.payload);
          } else {
            pending.reject(
              new Error(
                `${frame.error?.code ?? "ERR"}: ${frame.error?.message ?? "unknown gateway error"}`,
              ),
            );
          }
        } else if (frame.type === "event") {
          this.opts.onEvent?.(frame.event, frame.payload);
        }
      });
    });
  }

  /**
   * Exponential backoff with ±20% jitter, capped at maxReconnectDelayMs. A
   * gateway that's down (e.g. an idle-stopped workspace container) is retried
   * ever less often instead of every 5s, which also keeps the logs quiet. The
   * jitter stops many per-user bridges from reconnecting in lockstep.
   */
  private nextReconnectDelay(): number {
    const exp = Math.min(
      this.reconnectDelayMs * 2 ** this.reconnectAttempts,
      this.maxReconnectDelayMs,
    );
    this.reconnectAttempts += 1;
    const jitter = exp * 0.2 * (Math.random() * 2 - 1);
    return Math.max(this.reconnectDelayMs, Math.round(exp + jitter));
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || this.closed) return;
    const delay = this.nextReconnectDelay();
    // Only announce the first attempt after a drop; further backed-off retries
    // stay silent so a long-down gateway doesn't spam the log.
    if (this.reconnectAttempts === 1) {
      this.log("openclaw rpc disconnected; will retry with backoff", { firstDelayMs: delay });
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => this.scheduleReconnect());
    }, delay);
  }

  async request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    await this.connect();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.handshakeOk) {
      throw new Error("openclaw rpc not connected");
    }
    return this.rawRequest<T>(method, params);
  }

  /** Send a request without waiting for handshake — used by handshake itself. */
  private rawRequest<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("openclaw rpc socket not open");
    }
    const ws = this.ws;
    const id = randomUUID();
    const frame: RpcFrame = { type: "req", id, method, params };
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`openclaw rpc timeout: ${method}`));
        }
      }, this.requestTimeoutMs);
      timer.unref?.();
    });
    ws.send(JSON.stringify(frame));
    return promise as Promise<T>;
  }

  private async performHandshake(ws: WebSocket): Promise<void> {
    // Briefly install the message handler before sending the connect frame —
    // the handler was already attached in openSocket; we just need to make
    // sure rawRequest can route the response. Since `this.ws` is already
    // set, rawRequest works.
    void ws;
    // Openclaw's current `PROTOCOL_VERSION` (`src/gateway/protocol/version.ts`).
    // Bumped together with openclaw — kept loose here so a minor mismatch only
    // surfaces if the gateway raises MIN_CLIENT_PROTOCOL_VERSION above ours.
    const connectParams = {
      minProtocol: 4,
      maxProtocol: 4,
      client: {
        id: "gateway-client",
        displayName: "paperclip-openclaw-bridge",
        version: "0.1.0",
        platform: "node",
        mode: "backend",
      },
      role: "operator",
      scopes: ["operator.admin"],
      auth: {
        token: this.opts.token,
      },
    } as const;
    await this.rawRequest("connect", connectParams);
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}
