import { defineConfig, devices } from "@playwright/test";

// End-to-end tests for the openclaw→Paperclip skill + reporter identity feature.
//
// Verifies:
//  1. openclaw/skills/paperclip/SKILL.md is present and has valid frontmatter.
//  2. Each openclaw agent's workspace has a staged paperclip-claimed-api-key.json.
//  3. The staged token authenticates to Paperclip and resolves the correct agent.
//  4. Issues created with that token have createdByAgentId set (reporter identity).
//
// Env overrides:
//   PAPERCLIP_URL          default http://127.0.0.1:3101
//   OPENCLAW_WORKSPACE     default /home/w/programming/all/sandbox/.openclaw/workspace
//   TEST_AGENT_ID          openclaw agent id to test (default: flow-dev)
//
// Tests that need a live Paperclip skip automatically when the server is unreachable.
const PAPERCLIP = process.env.PAPERCLIP_URL ?? "http://127.0.0.1:3101";

export default defineConfig({
  testDir: ".",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: [["list"]],
  use: {
    baseURL: PAPERCLIP,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      metadata: { paperclip: PAPERCLIP },
    },
  ],
});
