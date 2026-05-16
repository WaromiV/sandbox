import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { eq, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, agentApiKeys } from "@paperclipai/db";
import type { OpenclawAgent } from "./index.js";
import type { OpenclawBridgeConfig } from "./config.js";

/**
 * Stager: upserts a paperclip row + paperclip-issued token for every
 * openclaw agent, then writes the token JSON + paperclip skill into the
 * agent's openclaw workspace on disk.
 *
 * The stager runs after every successful roster fetch. It is idempotent:
 * - paperclip rows are upserted by (externalSource, externalAgentId)
 * - tokens are rotated only when the row has no live key yet
 * - workspace files are skipped when the content is already correct
 *
 * Constraint we work around: openclaw's `agents.files.set` RPC is
 * whitelisted to bootstrap/memory file names only. Skills + arbitrary
 * config files have to be written directly to disk. Since paperclip and
 * openclaw share a filesystem in every supported deployment topology
 * (single docker container in production, sibling processes in dev),
 * direct fs writes are the path of least resistance.
 */

export type StagerDeps = {
  db: Db;
  config: OpenclawBridgeConfig;
  /** Paperclip company id resolved by the bridge (auto-bootstrapped). */
  companyId: string;
  /** Where the paperclip skill source lives on this paperclip server. */
  skillSourcePath: string;
  /** Compute the workspace dir from the openclaw-reported agent. */
  resolveWorkspaceDir: (agent: OpenclawAgent) => string | null;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
};

export type StagerResult = {
  upserted: number;
  retired: number;
  tokensMinted: number;
  filesWritten: number;
};

const TOKEN_FILE_NAME = "paperclip-claimed-api-key.json";
const SKILL_DIR_REL = path.join("skills", "paperclip");
const SKILL_FILE_NAME = "SKILL.md";

function createTokenString(): string {
  return `pcp_${randomBytes(24).toString("hex")}`;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function writeFileIfChanged(
  filePath: string,
  content: string,
): Promise<boolean> {
  try {
    const existing = await fs.readFile(filePath, "utf8");
    if (existing === content) return false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  return true;
}

function buildAdapterConfig(
  config: OpenclawBridgeConfig,
  agent: OpenclawAgent,
  claimedApiKeyPath: string,
): Record<string, unknown> {
  return {
    url: config.url,
    authToken: config.token,
    sessionKeyStrategy: "issue",
    paperclipApiUrl: config.paperclipApiUrl,
    claimedApiKeyPath,
    // The adapter uses this to (a) pick a per-agent session key prefix
    // — `agent:<id>:paperclip:issue:<issue>` — and (b) tell openclaw
    // which agent to route the run to. Without this, openclaw rejects
    // with "agent X does not match session key agent Y".
    agentId: agent.id,
    payloadTemplate: {
      agentId: agent.id,
    },
    // The bridge owns this row — re-introducing an alternative adapter
    // would be overwritten on next sync. Marking it here so admin tools
    // can spot mirror rows at a glance.
    managedBy: "openclaw-bridge",
  };
}

function buildTokenJson(input: { token: string; agentId: string; companyId: string; apiUrl: string }): string {
  return (
    JSON.stringify(
      {
        token: input.token,
        agentId: input.agentId,
        companyId: input.companyId,
        apiUrl: input.apiUrl,
        issuedAt: new Date().toISOString(),
        // Keep the schema explicit so the adapter's reader can validate.
        schema: "paperclip-claimed-api-key/v1",
      },
      null,
      2,
    ) + "\n"
  );
}

export async function stageRoster(
  deps: StagerDeps,
  roster: OpenclawAgent[],
): Promise<StagerResult> {
  const log = deps.log ?? (() => {});
  const result: StagerResult = { upserted: 0, retired: 0, tokensMinted: 0, filesWritten: 0 };
  const seenPaperclipIds = new Set<string>();

  // Load the paperclip skill once.
  let skillContent: string | null = null;
  try {
    skillContent = await fs.readFile(deps.skillSourcePath, "utf8");
  } catch (err) {
    log("skill source missing — skipping skill staging", {
      path: deps.skillSourcePath,
      err: String(err),
    });
  }

  for (const agent of roster) {
    const paperclipId = agent.paperclipUuid;
    seenPaperclipIds.add(paperclipId);
    const workspaceDir = deps.resolveWorkspaceDir(agent);
    const tokenFsPath = workspaceDir ? path.join(workspaceDir, TOKEN_FILE_NAME) : null;
    // The adapter reads the token using its `claimedApiKeyPath` config field.
    // We point it at the absolute fs path so the adapter doesn't have to do
    // home-dir resolution. If the deployment runs paperclip in a separate
    // container, this string is still a host-local path that the openclaw
    // container shares via volume mount.
    const adapterConfig = buildAdapterConfig(
      deps.config,
      agent,
      tokenFsPath ?? `~/.openclaw/workspace/agents/${agent.id}/${TOKEN_FILE_NAME}`,
    );

    // Upsert the paperclip agents row.
    const existing = await deps.db
      .select({
        id: agents.id,
        externalAgentId: agents.externalAgentId,
        externalSource: agents.externalSource,
      })
      .from(agents)
      .where(
        and(eq(agents.externalSource, "openclaw"), eq(agents.externalAgentId, agent.id)),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);

    let upsertedId: string;
    if (existing) {
      // Transfer-on-conflict: if the bridge was previously configured for
      // a different company (or the operator switched OPENCLAW_MIRROR_*
      // env vars), move the row into the current target company.
      // companyId is set unconditionally so re-runs are idempotent.
      await deps.db
        .update(agents)
        .set({
          companyId: deps.companyId,
          name: agent.label,
          adapterType: "openclaw_gateway",
          adapterConfig,
          status: "idle",
          metadata: {
            externalSource: "openclaw",
            externalAgentId: agent.id,
            workspace: agent.workspace,
            model: agent.model,
            identity: agent.identity,
          },
          updatedAt: new Date(),
        })
        .where(eq(agents.id, existing.id));
      upsertedId = existing.id;
    } else {
      const inserted = await deps.db
        .insert(agents)
        .values({
          id: paperclipId,
          companyId: deps.companyId,
          name: agent.label,
          role: "agent",
          adapterType: "openclaw_gateway",
          adapterConfig,
          runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
          status: "idle",
          permissions: {},
          metadata: {
            externalSource: "openclaw",
            externalAgentId: agent.id,
            workspace: agent.workspace,
            model: agent.model,
            identity: agent.identity,
          },
          externalSource: "openclaw",
          externalAgentId: agent.id,
        })
        .returning({ id: agents.id })
        .then((rows) => rows[0]);
      upsertedId = inserted.id;
      result.upserted += 1;
    }

    // Mint a paperclip API key if none is live for this row.
    const liveKey = await deps.db
      .select({ id: agentApiKeys.id })
      .from(agentApiKeys)
      .where(and(eq(agentApiKeys.agentId, upsertedId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    let tokenForFs: string | null = null;
    if (!liveKey) {
      const token = createTokenString();
      await deps.db.insert(agentApiKeys).values({
        agentId: upsertedId,
        companyId: deps.companyId,
        name: "openclaw-bridge",
        keyHash: hashToken(token),
      });
      tokenForFs = token;
      result.tokensMinted += 1;
    }

    // Write token + skill to disk if workspace path is available.
    if (workspaceDir && tokenFsPath) {
      try {
        await fs.mkdir(workspaceDir, { recursive: true });
        if (tokenForFs) {
          await fs.writeFile(
            tokenFsPath,
            buildTokenJson({
              token: tokenForFs,
              agentId: upsertedId,
              companyId: deps.companyId,
              apiUrl: deps.config.paperclipApiUrl,
            }),
            "utf8",
          );
          // 0600 — the token is a bearer secret.
          await fs.chmod(tokenFsPath, 0o600);
          result.filesWritten += 1;
        } else {
          // Even when we didn't rotate, refresh the apiUrl/companyId
          // metadata next to the token so the adapter sees fresh values.
          try {
            const existingRaw = await fs.readFile(tokenFsPath, "utf8");
            const parsed = JSON.parse(existingRaw) as { token?: string };
            if (parsed.token) {
              await fs.writeFile(
                tokenFsPath,
                buildTokenJson({
                  token: parsed.token,
                  agentId: upsertedId,
                  companyId: deps.companyId,
                  apiUrl: deps.config.paperclipApiUrl,
                }),
                "utf8",
              );
              await fs.chmod(tokenFsPath, 0o600);
            }
          } catch {
            // First-run after a token already existed in DB — skip silently.
          }
        }
        if (skillContent) {
          const skillTarget = path.join(workspaceDir, SKILL_DIR_REL, SKILL_FILE_NAME);
          const wrote = await writeFileIfChanged(skillTarget, skillContent);
          if (wrote) result.filesWritten += 1;
        }
      } catch (err) {
        log("failed to stage workspace files", {
          agent: agent.id,
          dir: workspaceDir,
          err: String(err),
        });
      }
    }
  }

  // Retire openclaw-sourced rows that no longer appear in the roster.
  const allMirroredIds = await deps.db
    .select({ id: agents.id, status: agents.status })
    .from(agents)
    .where(eq(agents.externalSource, "openclaw"));
  for (const row of allMirroredIds) {
    if (seenPaperclipIds.has(row.id)) continue;
    if (row.status === "terminated") continue;
    await deps.db
      .update(agents)
      .set({
        status: "terminated",
        pauseReason: "openclaw-bridge: agent no longer present in openclaw roster",
        pausedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agents.id, row.id));
    result.retired += 1;
  }

  return result;
}
