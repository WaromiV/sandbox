import { Router } from "express";
import { assertAuthenticated } from "./authz.js";

// GET /api/access/role
//
// Returns the caller's effective role for cross-service authz. Code-server
// (Phase C) and openclaw (Phase D) call this after they validate an
// Authentik-issued id_token to decide whether to grant admin access — keeps
// paperclip as the single source of truth for role even though every service
// independently validates the id_token.
//
//   { role: "admin" | "user", userId, email, source }
//
// "admin" maps onto the existing instance_admin boolean. Anything else
// authenticated is "user". Unauthenticated requests get 401.
export function accessRoleRoutes(): Router {
  const router = Router();
  router.get("/role", (req, res) => {
    assertAuthenticated(req);
    const a = req.actor;

    const isAdmin =
      a.type === "board" &&
      (a.source === "local_implicit" || a.isInstanceAdmin === true);

    if (a.type === "board") {
      res.json({
        role: isAdmin ? "admin" : "user",
        userId: a.userId ?? null,
        email: a.userEmail ?? null,
        source: a.source,
      });
      return;
    }

    // Agent tokens get "user" — never admin via agent identity.
    res.json({
      role: "user",
      userId: null,
      email: null,
      source: a.source,
    });
  });
  return router;
}
