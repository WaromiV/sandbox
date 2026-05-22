import { defineConfig, devices } from "@playwright/test";

// Smoke test for the Authentik OIDC flow. Assumes bring-up.sh has run and
// tests/scripts/create-sample-user.sh has provisioned the sample user.
//
// Env overrides:
//   PAPERCLIP_URL          default http://127.0.0.1:3110
//   AUTHENTIK_URL          default http://127.0.0.1:9000
//   OIDC_TEST_USERNAME     default claudetest
//   OIDC_TEST_PASSWORD     default Sandbox-Smoke-2026!
const PAPERCLIP = process.env.PAPERCLIP_URL ?? "http://127.0.0.1:3110";
const AUTHENTIK = process.env.AUTHENTIK_URL ?? "http://127.0.0.1:9000";

export default defineConfig({
  testDir: ".",
  timeout: 60_000,
  expect: { timeout: 10_000 },
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
      metadata: { paperclip: PAPERCLIP, authentik: AUTHENTIK },
    },
  ],
});
