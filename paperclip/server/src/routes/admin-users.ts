import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { authUsers } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { assertInstanceAdmin } from "./authz.js";
import { setInstanceAdmin } from "../auth/oidc-bootstrap.js";
import { badRequest, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";

// POST /api/admin/users/:id/promote   — make user an instance_admin
// POST /api/admin/users/:id/demote    — revoke instance_admin
//
// Admin-only. Used by the operator to grant editor/code-server access to
// additional users after the first-login bootstrap. Self-demotion is allowed
// but discouraged — if you demote the last admin you lock yourself out and
// have to recover via the local-trusted bring-up.
export function adminUsersRoutes(db: Db): Router {
  const router = Router();

  router.post("/admin/users/:id/promote", async (req, res) => {
    assertInstanceAdmin(req);
    const userId = (req.params.id ?? "").trim();
    if (!userId) throw badRequest("user id is required");

    const exists = await db
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(eq(authUsers.id, userId))
      .then((rows) => rows[0] ?? null);
    if (!exists) throw notFound("user not found");

    await setInstanceAdmin(db, userId, true);
    logger.info({ userId, by: req.actor.userId }, "user promoted to instance_admin");
    res.json({ ok: true, userId, role: "admin" });
  });

  router.post("/admin/users/:id/demote", async (req, res) => {
    assertInstanceAdmin(req);
    const userId = (req.params.id ?? "").trim();
    if (!userId) throw badRequest("user id is required");

    await setInstanceAdmin(db, userId, false);
    logger.info({ userId, by: req.actor.userId }, "user demoted from instance_admin");
    res.json({ ok: true, userId, role: "user" });
  });

  return router;
}
