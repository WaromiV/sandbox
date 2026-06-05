import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadPaperclipRunEnv } from "./paperclip-bridge-env.js";

const TOKEN_FILE = "paperclip-claimed-api-key.json";

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-env-test-"));
}

const VALID_TOKEN = {
  token: "pcp_aabbcc112233",
  agentId: "de243fea-d117-58d6-8463-5092fd45e92e",
  companyId: "034d5c1c-0158-42d1-b910-7eba16e35992",
  apiUrl: "http://localhost:3101",
  schema: "paperclip-claimed-api-key/v1",
};

describe("loadPaperclipRunEnv", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns PAPERCLIP_* vars when token file is present", async () => {
    await fs.writeFile(path.join(tmpDir, TOKEN_FILE), JSON.stringify(VALID_TOKEN), "utf8");
    const env = await loadPaperclipRunEnv(tmpDir);
    expect(env.PAPERCLIP_API_KEY).toBe(VALID_TOKEN.token);
    expect(env.PAPERCLIP_AGENT_ID).toBe(VALID_TOKEN.agentId);
    expect(env.PAPERCLIP_COMPANY_ID).toBe(VALID_TOKEN.companyId);
    expect(env.PAPERCLIP_API_URL).toBe(VALID_TOKEN.apiUrl);
  });

  it("returns empty object when file is absent", async () => {
    const env = await loadPaperclipRunEnv(tmpDir);
    expect(env).toEqual({});
  });

  it("returns empty object when workspaceDir is undefined", async () => {
    const env = await loadPaperclipRunEnv(undefined);
    expect(env).toEqual({});
  });

  it("returns empty object when workspaceDir is null", async () => {
    const env = await loadPaperclipRunEnv(null);
    expect(env).toEqual({});
  });

  it("returns empty object when file is not valid JSON", async () => {
    await fs.writeFile(path.join(tmpDir, TOKEN_FILE), "not-json", "utf8");
    const env = await loadPaperclipRunEnv(tmpDir);
    expect(env).toEqual({});
  });

  it("returns empty object when required fields are missing", async () => {
    await fs.writeFile(
      path.join(tmpDir, TOKEN_FILE),
      JSON.stringify({ token: "pcp_x", agentId: "abc" }),
      "utf8",
    );
    const env = await loadPaperclipRunEnv(tmpDir);
    expect(env).toEqual({});
  });

  it("does not include extra fields from the token file", async () => {
    await fs.writeFile(path.join(tmpDir, TOKEN_FILE), JSON.stringify(VALID_TOKEN), "utf8");
    const env = await loadPaperclipRunEnv(tmpDir);
    expect(Object.keys(env).sort()).toEqual(
      ["PAPERCLIP_AGENT_ID", "PAPERCLIP_API_KEY", "PAPERCLIP_API_URL", "PAPERCLIP_COMPANY_ID"].sort(),
    );
  });
});
