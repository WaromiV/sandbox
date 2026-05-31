import type {
  SandboxBrowserSettings,
  SandboxDockerSettings,
  SandboxPruneSettings,
  SandboxSshSettings,
} from "./types.sandbox.js";

export type AgentModelConfig =
  | string
  | {
      /** Primary model (provider/model). */
      primary?: string;
      /** Per-agent model fallbacks (provider/model). */
      fallbacks?: string[];
      /** Optional provider request timeout in milliseconds for capabilities that support it. */
      timeoutMs?: number;
    };

export type AgentEmbeddedHarnessConfig = {
  /** Agent runtime id. Omitted uses "pi"; "auto" opts into plugin harness auto-selection. */
  runtime?: string;
};

export type AgentRuntimePolicyConfig = {
  /** Agent runtime id. Omitted uses "pi"; "auto" opts into plugin harness auto-selection. */
  id?: string;
};

export type AgentSandboxConfig = {
  /**
   * When to sandbox an agent run:
   * - "off" (default): never sandbox.
   * - "non-main": sandbox every non-main session.
   * - "all": sandbox every session.
   * - "telegram-topic": sandbox only runs that originate from a Telegram forum
   *   topic — one container + isolated workspace per topic — so per-topic agents
   *   stop sharing one checkout/branch. DMs, non-topic groups, and CLI runs stay
   *   on the host.
   */
  mode?: "off" | "non-main" | "all" | "telegram-topic";
  /** Sandbox runtime backend id. Default: "docker". */
  backend?: string;
  /** Agent workspace access inside the sandbox. */
  workspaceAccess?: "none" | "ro" | "rw";
  /**
   * Session tools visibility for sandboxed sessions.
   * - "spawned": only allow session tools to target sessions spawned from this session (default)
   * - "all": allow session tools to target any session
   */
  sessionToolsVisibility?: "spawned" | "all";
  /** Container/workspace scope for sandbox isolation. */
  scope?: "session" | "agent" | "shared";
  workspaceRoot?: string;
  /** Docker-specific sandbox settings. */
  docker?: SandboxDockerSettings;
  /** SSH-specific sandbox settings. */
  ssh?: SandboxSshSettings;
  /** Optional sandboxed browser settings. */
  browser?: SandboxBrowserSettings;
  /** Auto-prune sandbox settings. */
  prune?: SandboxPruneSettings;
};
