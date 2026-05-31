import { describe, expect, it } from "vitest";
import { isTelegramGroupTopic } from "./topic-scope.js";

describe("isTelegramGroupTopic", () => {
  it("matches a Telegram group forum topic session", () => {
    expect(isTelegramGroupTopic("agent:flow-dev:telegram:group:-1003701121418:topic:1167")).toBe(
      true,
    );
    // Also tolerates the bare conversation-ref form (no agent: prefix).
    expect(isTelegramGroupTopic("telegram:group:-1003701121418:topic:2681")).toBe(true);
  });

  it("excludes the General topic (thread id 1)", () => {
    expect(isTelegramGroupTopic("agent:flow-dev:telegram:group:-1003701121418:topic:1")).toBe(
      false,
    );
  });

  it("excludes non-forum groups (no topic segment)", () => {
    expect(isTelegramGroupTopic("agent:flow-dev:telegram:group:-1003701121418")).toBe(false);
  });

  it("excludes direct / DM sessions", () => {
    expect(isTelegramGroupTopic("agent:flow-dev:telegram:direct:12345")).toBe(false);
    expect(isTelegramGroupTopic("agent:main:telegram:direct:1053274893")).toBe(false);
  });

  it("excludes non-Telegram group topics", () => {
    expect(isTelegramGroupTopic("agent:flow-dev:slack:group:C123:topic:5")).toBe(false);
  });

  it("excludes main / CLI / empty sessions", () => {
    expect(isTelegramGroupTopic("agent:main:main")).toBe(false);
    expect(isTelegramGroupTopic("main")).toBe(false);
    expect(isTelegramGroupTopic("")).toBe(false);
    expect(isTelegramGroupTopic(undefined)).toBe(false);
    expect(isTelegramGroupTopic(null)).toBe(false);
  });
});
