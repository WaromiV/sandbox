-- Singleton row that records whether the "first-login wins admin" claim has
-- already happened. The OIDC sign-up hook in paperclip atomically claims this
-- row inside a conditional UPDATE — the first new user wins, every subsequent
-- new user just becomes a regular user. Idempotent across restarts.
--
-- The id = 1 CHECK + primary-key constraint together guarantee a single row.
CREATE TABLE IF NOT EXISTS "instance_admin_bootstrap" (
  "id" integer PRIMARY KEY CHECK ("id" = 1),
  "claimed" boolean NOT NULL DEFAULT false,
  "claimed_by_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "claimed_at" timestamp with time zone
);
--> statement-breakpoint
INSERT INTO "instance_admin_bootstrap" ("id", "claimed")
VALUES (1, false)
ON CONFLICT ("id") DO NOTHING;
