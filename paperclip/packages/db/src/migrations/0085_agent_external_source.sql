-- Adds columns that let paperclip mark agent rows as mirrored from
-- another system. The openclaw bridge populates these so agents listed
-- in paperclip's UI come straight from openclaw's `agents.list`.
--
-- Strictly additive: existing rows get NULL for both columns and behave
-- exactly as before. A partial unique index ensures that for openclaw-
-- sourced rows, externalAgentId is unique — preventing duplicate mirror
-- rows for the same openclaw slug.

ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "external_source" text;
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "external_agent_id" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agents_external_agent_id_unique"
  ON "agents" ("external_source", "external_agent_id")
  WHERE "external_source" IS NOT NULL AND "external_agent_id" IS NOT NULL;
