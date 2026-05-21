import { boolean, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";

// Singleton row (id=1) that tracks whether the first OIDC sign-in has already
// promoted itself to instance_admin. The conditional UPDATE in the OIDC hook
// makes "first user wins" race-safe even under concurrent sign-ups.
export const instanceAdminBootstrap = pgTable("instance_admin_bootstrap", {
  id: integer("id").primaryKey(),
  claimed: boolean("claimed").notNull().default(false),
  claimedByUserId: text("claimed_by_user_id").references(() => authUsers.id, {
    onDelete: "set null",
  }),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
});
