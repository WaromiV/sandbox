import { test, expect, request as pwRequest } from "@playwright/test";

// End-to-end smoke for the Authentik SSO flow into paperclip.
//
// Preconditions (run once before the suite):
//   1. bring-up.sh started Authentik + paperclip
//   2. tests/scripts/create-sample-user.sh provisioned the sample user
//
// What this proves:
//   - /api/auth/oidc-providers reports authentik (UI wiring contract)
//   - the auth page renders the "Sign in with Authentik" button
//   - clicking the button starts the OAuth2 code flow at Authentik
//   - submitting the Authentik form returns to paperclip with a session
//   - /api/access/role returns the expected role for the signed-in user
//   - the back-channel-logout endpoint is mounted in front of better-auth's
//     catch-all (400 with the spec'd error code, not 404 from the catch-all)

const PAPERCLIP = process.env.PAPERCLIP_URL ?? "http://127.0.0.1:3110";
const AUTHENTIK = process.env.AUTHENTIK_URL ?? "http://127.0.0.1:9000";
const TEST_USERNAME = process.env.OIDC_TEST_USERNAME ?? "claudetest";
const TEST_PASSWORD = process.env.OIDC_TEST_PASSWORD ?? "Sandbox-Smoke-2026!";

test.describe("paperclip OIDC discovery", () => {
  test("GET /api/auth/oidc-providers returns the authentik entry", async () => {
    const ctx = await pwRequest.newContext({ baseURL: PAPERCLIP });
    const res = await ctx.get("/api/auth/oidc-providers");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.providers)).toBe(true);
    const ids = body.providers.map((p: { id: string }) => p.id);
    expect(ids).toContain("authentik");
    await ctx.dispose();
  });

  test("back-channel-logout endpoint is mounted ahead of the better-auth catch-all", async () => {
    const ctx = await pwRequest.newContext({ baseURL: PAPERCLIP });
    // No logout_token in the body → spec error code "invalid_request".
    // If the catch-all had eaten the route we would see 404 or HTML from
    // better-auth's error renderer, never this JSON.
    const res = await ctx.post("/api/auth/oidc/back-channel-logout", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      data: "",
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_request");
    await ctx.dispose();
  });
});

test.describe("Sign in with Authentik — browser-driven", () => {
  test("button is rendered on /auth and labels the provider", async ({ page }) => {
    await page.goto("/auth");
    const button = page.getByRole("button", { name: /Sign in with Authentik/i });
    await expect(button).toBeVisible();
  });

  test("full OIDC code flow ends with a paperclip session", async ({ page, context }) => {
    await page.goto("/auth");
    const button = page.getByRole("button", { name: /Sign in with Authentik/i });
    await expect(button).toBeVisible();

    // Click + wait for the IdP origin. Better-auth's signInOauth returns a
    // url which the UI navigates to via window.location.assign.
    await Promise.all([
      page.waitForURL((url) => url.origin === AUTHENTIK, { timeout: 20_000 }),
      button.click(),
    ]);

    // Authentik renders its identification step in a Lit web component.
    // Clicks against the submit button are flaky against Playwright's
    // actionability checks — pressing Enter while focus is on the input
    // submits reliably.
    const username = page.locator('input[name="uidField"]').first();
    await username.waitFor({ state: "visible", timeout: 15_000 });
    await username.fill(TEST_USERNAME);
    await page.keyboard.press("Enter");

    const password = page.locator('input[name="password"]').first();
    await password.waitFor({ state: "visible", timeout: 15_000 });
    await password.fill(TEST_PASSWORD);
    await page.keyboard.press("Enter");

    // Authentik bounces back through /api/auth/oauth2/callback/authentik to "/".
    await page.waitForURL((url) => url.origin === PAPERCLIP, { timeout: 30_000 });

    // Better-auth session is set — getSession returns the user object.
    const session = await page.evaluate(async () => {
      const r = await fetch("/api/auth/get-session", { credentials: "include" });
      if (r.status === 401) return null;
      return r.json();
    });
    expect(session).not.toBeNull();
    expect(session?.user?.email ?? null).toBeTruthy();

    // Role authority reports a known role for this subject.
    const role = await page.evaluate(async () => {
      const r = await fetch("/api/access/role", { credentials: "include" });
      if (!r.ok) return null;
      return r.json();
    });
    expect(role).not.toBeNull();
    expect(role.role === "admin" || role.role === "user").toBe(true);

    // Cookie has the expected better-auth prefix and is HttpOnly.
    const cookies = await context.cookies(PAPERCLIP);
    const sessionCookie = cookies.find((c) => /paperclip-.*\.session/.test(c.name));
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie?.httpOnly).toBe(true);
  });
});
