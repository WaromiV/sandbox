import { Router } from "express";
import type { OpenclawBridge } from "../services/openclaw-bridge/index.js";

/**
 * Routes that surface the openclaw bridge to paperclip's web UI.
 *
 * `GET /api/openclaw/agents` is the canonical agent picker source —
 * the paperclip frontend reads from here instead of the legacy
 * `GET /api/companies/:companyId/agents` once the picker is rewired.
 */
export function openclawRoutes(bridge: OpenclawBridge | null): Router {
  const router = Router();

  router.get("/agents", async (_req, res) => {
    if (!bridge) {
      res.status(503).json({
        error: "openclaw_bridge_disabled",
        message:
          "OpenClaw bridge is not configured. Set OPENCLAW_GATEWAY_URL, OPENCLAW_GATEWAY_TOKEN, and OPENCLAW_MIRROR_COMPANY_ID on the paperclip server.",
      });
      return;
    }
    const roster = bridge.getRoster();
    if (!bridge.isReady()) {
      // Try one synchronous refresh before reporting empty, so the
      // first UI page-load doesn't return [].
      try {
        const next = await bridge.refreshNow();
        res.json({
          fetchedAtMs: next.fetchedAtMs,
          defaultId: next.defaultId,
          agents: next.agents,
        });
        return;
      } catch (err) {
        res.status(502).json({
          error: "openclaw_unreachable",
          message: String((err as Error)?.message ?? err),
        });
        return;
      }
    }
    res.json({
      fetchedAtMs: roster.fetchedAtMs,
      defaultId: roster.defaultId,
      agents: roster.agents,
    });
  });

  // UI uses this to decide whether to show "New Agent" affordances. When
  // the bridge is on, openclaw owns identity and paperclip's UI hides
  // the create/edit/delete buttons.
  router.get("/status", (_req, res) => {
    if (!bridge) {
      res.json({ enabled: false });
      return;
    }
    const roster = bridge.getRoster();
    res.json({
      enabled: true,
      ready: bridge.isReady(),
      fetchedAtMs: roster.fetchedAtMs,
      agentCount: roster.agents.length,
      // UI uses this to auto-select the bridge-managed company on first
      // load and to skip paperclip's onboarding flow when bridge is on.
      companyId: bridge.getCompanyId(),
    });
  });

  router.post("/agents/sync", async (_req, res) => {
    if (!bridge) {
      res.status(503).json({ error: "openclaw_bridge_disabled" });
      return;
    }
    try {
      const next = await bridge.refreshNow();
      res.json({
        fetchedAtMs: next.fetchedAtMs,
        defaultId: next.defaultId,
        count: next.agents.length,
      });
    } catch (err) {
      res.status(502).json({
        error: "openclaw_sync_failed",
        message: String((err as Error)?.message ?? err),
      });
    }
  });

  return router;
}
