import { Router, raw } from "express";
import type { Db } from "@paperclipai/db";
import { handleBackChannelLogout } from "../auth/oidc-back-channel-logout.js";

// POST /api/auth/oidc/back-channel-logout
//
// Receives the application/x-www-form-urlencoded logout_token Authentik
// sends when a user logs out of the IdP. We must mount this BEFORE the
// better-auth catch-all so the catch-all does not claim the path.
//
// Per the OIDC Back-Channel Logout 1.0 spec:
//   - The request is POST application/x-www-form-urlencoded.
//   - The body has a single `logout_token` parameter (a signed JWT).
//   - Responses: 200 on success, 400 with {error, error_description} on
//     validation failure. The body shape is normative.
//
// Cache-Control: no-store is required so the response is never cached.
export function oidcBackChannelLogoutRoutes(db: Db): Router {
  const router = Router();
  router.post(
    "/oidc/back-channel-logout",
    raw({ type: "application/x-www-form-urlencoded", limit: "16kb" }),
    async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Pragma", "no-cache");
      const rawBody = Buffer.isBuffer(req.body)
        ? req.body.toString("utf8")
        : typeof req.body === "string"
          ? req.body
          : "";
      const params = new URLSearchParams(rawBody);
      const logoutToken = params.get("logout_token") ?? undefined;
      const result = await handleBackChannelLogout(db, logoutToken);
      res.status(result.status).json(result.body);
    },
  );
  return router;
}
