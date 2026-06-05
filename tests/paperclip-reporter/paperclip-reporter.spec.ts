import { test, expect, request as pwRequest } from "@playwright/test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const PAPERCLIP = process.env.PAPERCLIP_URL ?? "http://127.0.0.1:3101";
const OPENCLAW_WORKSPACE =
  process.env.OPENCLAW_WORKSPACE ??
  join(import.meta.dirname, "../../.openclaw/workspace");
const TEST_AGENT_ID = process.env.TEST_AGENT_ID ?? "flow-dev";
const SKILL_PATH = join(import.meta.dirname, "../../openclaw/skills/paperclip/SKILL.md");
const AGENTS_WORKSPACE = join(OPENCLAW_WORKSPACE, "agents");

/**
 * Resolve the workspace dir for a given agent id.
 * Named agents live under `agents/<id>/`; the sentinel id "main" (or any id
 * not found under `agents/`) falls back to the root workspace dir when the
 * root has a token file (default single-agent setup).
 */
function agentWorkspaceDir(agentId: string): string {
  const perAgent = join(AGENTS_WORKSPACE, agentId);
  if (existsSync(join(perAgent, "paperclip-claimed-api-key.json"))) return perAgent;
  // Only fall back to root for the explicit "main" id — avoids false positives
  // where multiple named agents all resolve to the same root token file.
  if (agentId === "main" && existsSync(join(OPENCLAW_WORKSPACE, "paperclip-claimed-api-key.json"))) {
    return OPENCLAW_WORKSPACE;
  }
  return perAgent;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function readAgentToken(agentId: string): { token: string; agentId: string; companyId: string; apiUrl: string } | null {
  const tokenPath = join(agentWorkspaceDir(agentId), "paperclip-claimed-api-key.json");
  if (!existsSync(tokenPath)) return null;
  try {
    return JSON.parse(readFileSync(tokenPath, "utf8"));
  } catch {
    return null;
  }
}

async function isPaperclipReachable(): Promise<boolean> {
  try {
    const ctx = await pwRequest.newContext({ baseURL: PAPERCLIP });
    const res = await ctx.get("/healthz", { timeout: 3000 });
    await ctx.dispose();
    return res.ok();
  } catch {
    return false;
  }
}

// ── tests ─────────────────────────────────────────────────────────────────────

test.describe("Paperclip skill — bundled in openclaw", () => {
  test("SKILL.md exists at openclaw/skills/paperclip/SKILL.md", () => {
    expect(existsSync(SKILL_PATH), `Missing: ${SKILL_PATH}`).toBe(true);
  });

  test("SKILL.md has required frontmatter fields", () => {
    const content = readFileSync(SKILL_PATH, "utf8");
    expect(content).toContain("name: paperclip");
    expect(content).toContain("PAPERCLIP_API_KEY");
  });

  test("SKILL.md documents the key API endpoints", () => {
    const content = readFileSync(SKILL_PATH, "utf8");
    expect(content).toContain("/api/agents/me");
    expect(content).toContain("/api/companies/");
    expect(content).toContain("createdByAgentId");
  });
});

test.describe("Staged token files — openclaw-bridge", () => {
  test("agent workspace has a staged token file", () => {
    const tokenPath = join(agentWorkspaceDir(TEST_AGENT_ID), "paperclip-claimed-api-key.json");
    expect(
      existsSync(tokenPath),
      `No token file for agent "${TEST_AGENT_ID}" at ${tokenPath}. Run the stack with OPENCLAW_GATEWAY_URL set.`,
    ).toBe(true);
  });

  test("staged token file has required fields", () => {
    const data = readAgentToken(TEST_AGENT_ID);
    if (!data) {
      test.skip();
      return;
    }
    expect(data.token).toMatch(/^pcp_[0-9a-f]+$/);
    expect(data.agentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(data.companyId).toMatch(/^[0-9a-f-]{36}$/);
    expect(data.apiUrl).toMatch(/^https?:\/\//);
    expect(data.schema ?? "paperclip-claimed-api-key/v1").toBe("paperclip-claimed-api-key/v1");
  });

  test("staged skill file exists in agent workspace", () => {
    const skillPath = join(agentWorkspaceDir(TEST_AGENT_ID), "skills", "paperclip", "SKILL.md");
    expect(
      existsSync(skillPath),
      `No staged skill for agent "${TEST_AGENT_ID}" at ${skillPath}. Run the stack with OPENCLAW_GATEWAY_URL set.`,
    ).toBe(true);
  });
});

test.describe("Paperclip API — token authenticates as correct agent", () => {
  test.beforeEach(async () => {
    const reachable = await isPaperclipReachable();
    if (!reachable) test.skip();
  });

  test("GET /api/agents/me returns the mirrored agent for the staged token", async ({ request }) => {
    const data = readAgentToken(TEST_AGENT_ID);
    if (!data) {
      test.skip();
      return;
    }

    const ctx = await pwRequest.newContext({ baseURL: PAPERCLIP });
    const res = await ctx.get("/api/agents/me", {
      headers: { Authorization: `Bearer ${data.token}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    await ctx.dispose();

    expect(body.id).toBe(data.agentId);
    expect(typeof body.name).toBe("string");
  });
});

test.describe("Reporter identity — issue createdByAgentId", () => {
  test.beforeEach(async () => {
    const reachable = await isPaperclipReachable();
    if (!reachable) test.skip();
  });

  test("issue created with staged token records the agent as reporter", async () => {
    const data = readAgentToken(TEST_AGENT_ID);
    if (!data) {
      test.skip();
      return;
    }

    const ctx = await pwRequest.newContext({ baseURL: PAPERCLIP });

    // Create an issue using the staged per-agent token.
    const createRes = await ctx.post(`/api/companies/${data.companyId}/issues`, {
      headers: {
        Authorization: `Bearer ${data.token}`,
        "Content-Type": "application/json",
      },
      data: {
        title: `[reporter-test] ${TEST_AGENT_ID} ${Date.now()}`,
        description: "Automated reporter identity test — safe to delete.",
        status: "cancelled",
        priority: "low",
      },
    });
    expect(createRes.status(), `Create issue failed: ${await createRes.text()}`).toBe(201);

    const issue = await createRes.json() as Record<string, unknown>;
    const issueId = issue.id as string;
    expect(typeof issueId).toBe("string");

    // Verify the reporter is set to this agent's Paperclip UUID.
    expect(issue.createdByAgentId).toBe(data.agentId);
    expect(issue.createdByUserId).toBeNull();

    // Clean up — issue is already cancelled so it won't pollute the board.
    await ctx.dispose();
  });

  test("issue list shows reporter for multiple agents independently", async () => {
    // Verify two different agents produce different createdByAgentId values.
    const agentIds = ["flow-dev", "tech-lead", "main"].filter((id) => {
      const tokenPath = join(agentWorkspaceDir(id), "paperclip-claimed-api-key.json");
      return existsSync(tokenPath);
    });
    if (agentIds.length < 2) {
      test.skip();
      return;
    }

    const createdAgentIds = new Set<string>();
    for (const agentId of agentIds) {
      const data = readAgentToken(agentId);
      if (!data) continue;

      const ctx = await pwRequest.newContext({ baseURL: PAPERCLIP });
      const res = await ctx.post(`/api/companies/${data.companyId}/issues`, {
        headers: {
          Authorization: `Bearer ${data.token}`,
          "Content-Type": "application/json",
        },
        data: {
          title: `[reporter-test-multi] ${agentId} ${Date.now()}`,
          status: "cancelled",
          priority: "low",
        },
      });
      if (res.status() === 201) {
        const issue = await res.json() as Record<string, unknown>;
        await ctx.dispose();
        expect(issue.createdByAgentId).toBe(data.agentId);
        createdAgentIds.add(issue.createdByAgentId as string);
      } else {
        await ctx.dispose();
      }
    }

    // Each agent must produce a distinct createdByAgentId.
    expect(createdAgentIds.size).toBe(agentIds.filter((id) => readAgentToken(id)).length);
  });
});
