import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveSandboxRuntimeStatus } from "./runtime-status.js";

function configWithMode(mode: "off" | "all" | "telegram-topic"): OpenClawConfig {
  return { agents: { defaults: { sandbox: { mode } } } } as unknown as OpenClawConfig;
}

const TOPIC_SESSION = "agent:flow-dev:telegram:group:-1003701121418:topic:1167";
const GENERAL_TOPIC_SESSION = "agent:flow-dev:telegram:group:-1003701121418:topic:1";
const DM_SESSION = "agent:flow-dev:telegram:direct:12345";

describe("resolveSandboxRuntimeStatus — telegram-topic mode", () => {
  it("sandboxes a Telegram forum-topic run", () => {
    const status = resolveSandboxRuntimeStatus({
      cfg: configWithMode("telegram-topic"),
      sessionKey: TOPIC_SESSION,
    });
    expect(status.mode).toBe("telegram-topic");
    expect(status.sandboxed).toBe(true);
  });

  it("does not sandbox a DM run", () => {
    expect(
      resolveSandboxRuntimeStatus({
        cfg: configWithMode("telegram-topic"),
        sessionKey: DM_SESSION,
      }).sandboxed,
    ).toBe(false);
  });

  it("does not sandbox the General topic", () => {
    expect(
      resolveSandboxRuntimeStatus({
        cfg: configWithMode("telegram-topic"),
        sessionKey: GENERAL_TOPIC_SESSION,
      }).sandboxed,
    ).toBe(false);
  });

  it("mode off never sandboxes a topic run", () => {
    expect(
      resolveSandboxRuntimeStatus({ cfg: configWithMode("off"), sessionKey: TOPIC_SESSION })
        .sandboxed,
    ).toBe(false);
  });

  it("mode all still sandboxes a topic run (unchanged behavior)", () => {
    expect(
      resolveSandboxRuntimeStatus({ cfg: configWithMode("all"), sessionKey: TOPIC_SESSION })
        .sandboxed,
    ).toBe(true);
  });
});
