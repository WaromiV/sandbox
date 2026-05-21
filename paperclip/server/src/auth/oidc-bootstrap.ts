import type { Db } from "@paperclipai/db";
import { instanceAdminBootstrap, instanceUserRoles } from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import { logger } from "../middleware/logger.js";

// Race-safe first-login-wins admin promotion.
//
// Runs from better-auth's databaseHooks.user.create.after — i.e., once per
// newly-created user. Whoever calls this first atomically claims the bootstrap
// row (singleton id=1, claimed=false → claimed=true with their userId). The
// conditional UPDATE ... WHERE claimed=false short-circuits any later caller,
// so two simultaneous OIDC sign-ups can both run this safely and exactly one
// becomes admin.
//
// If this hook throws, better-auth's after-hooks (1.5+) swallow it post-commit
// — the user still exists, just doesn't get admin. We log loudly so an
// operator can promote them manually via /api/admin/users/:id/promote.
export async function maybeClaimFirstAdmin(
  db: Db,
  userId: string,
): Promise<{ claimed: boolean }> {
  try {
    const rows = await db.execute(sql`
      UPDATE "instance_admin_bootstrap"
         SET "claimed" = true,
             "claimed_by_user_id" = ${userId},
             "claimed_at" = NOW()
       WHERE "id" = 1 AND "claimed" = false
       RETURNING "claimed_by_user_id"
    `);

    // db.execute returns the driver-specific shape. node-postgres returns
    // { rows: [...] }; postgres.js returns the array directly. Handle both.
    const updatedRows = Array.isArray(rows)
      ? rows
      : ((rows as { rows?: unknown[] }).rows ?? []);
    if (updatedRows.length === 0) {
      logger.debug({ userId }, "instance_admin_bootstrap already claimed");
      return { claimed: false };
    }

    await db
      .insert(instanceUserRoles)
      .values({ userId, role: "instance_admin" })
      .onConflictDoNothing({
        target: [instanceUserRoles.userId, instanceUserRoles.role],
      });

    logger.info(
      { userId },
      "Promoted first OIDC user to instance_admin via bootstrap claim",
    );
    return { claimed: true };
  } catch (err) {
    logger.error(
      { err, userId },
      "First-admin bootstrap failed — promote manually via /api/admin/users/:id/promote",
    );
    return { claimed: false };
  }
}

// Used by /api/admin/users/:id/promote and /api/admin/users/:id/demote.
export async function setInstanceAdmin(
  db: Db,
  userId: string,
  isAdmin: boolean,
): Promise<void> {
  if (isAdmin) {
    await db
      .insert(instanceUserRoles)
      .values({ userId, role: "instance_admin" })
      .onConflictDoNothing({
        target: [instanceUserRoles.userId, instanceUserRoles.role],
      });
  } else {
    await db
      .delete(instanceUserRoles)
      .where(
        and(
          eq(instanceUserRoles.userId, userId),
          eq(instanceUserRoles.role, "instance_admin"),
        ),
      );
  }
}
