import { Router } from "express";
import { AUTHENTIK_PROVIDER_ID, loadPaperclipOidcConfig } from "../auth/oidc-config.js";

// GET /api/auth/oidc-providers
//
// Returns the OIDC providers configured for this paperclip instance. The
// sign-in UI calls this on mount to decide whether to render "Sign in with
// <provider>" buttons alongside the email/password form. Open endpoint —
// it's an empty array on instances without OIDC, never reveals secrets.
//
// Shape:
//   { providers: [{ id: "authentik", displayName: "Authentik" }] }
//
// `id` matches the providerId better-auth's genericOAuth plugin uses, so
// the UI just POSTs to /api/auth/sign-in/oauth2 with the same id.
export function oidcProvidersRoutes(): Router {
  const router = Router();
  router.get("/oidc-providers", (_req, res) => {
    let hasAuthentik = false;
    try {
      hasAuthentik = loadPaperclipOidcConfig() !== null;
    } catch {
      hasAuthentik = false;
    }
    const providers = hasAuthentik
      ? [{ id: AUTHENTIK_PROVIDER_ID, displayName: "Authentik" }]
      : [];
    res.json({ providers });
  });
  return router;
}
