/**
 * Per-user ("me") + instance-wide surfaces for the unified worker UI:
 *   GET  /api/me/issues          — this user's chats across all their companies
 *   POST /api/me/workspace/ensure — start this user's workspace container
 *   GET  /api/instance/activity  — cross-company audit timeline (admin only)
 */
import { Router } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, companies } from "@paperclipai/db";
import { issueService } from "../services/index.js";
import { ensureUserContainer } from "../services/workspace-containers/manager.js";
import { assertBoard, assertInstanceAdmin } from "./authz.js";
import { forbidden } from "../errors.js";

function clampLimit(raw: unknown, def: number, max: number): number {
  const n = typeof raw === "string" && /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : def;
  return Math.min(max, Math.max(1, n));
}

export function meRoutes(db: Db): Router {
  const router = Router();
  const issues = issueService(db);

  // "My chats": issues this user created, is assigned to, commented on, or
  // read — aggregated across every company they belong to. Newest first.
  router.get("/me/issues", async (req, res) => {
    assertBoard(req);
    const userId = req.actor.userId;
    if (!userId) throw forbidden("Board user required");
    const companyIds = req.actor.companyIds ?? [];
    const limit = clampLimit(req.query.limit, 100, 500);

    const companyInfo = new Map<string, { name: string; issuePrefix: string }>();
    if (companyIds.length > 0) {
      const rows = await db
        .select({ id: companies.id, name: companies.name, issuePrefix: companies.issuePrefix })
        .from(companies)
        .where(inArray(companies.id, companyIds));
      for (const row of rows) companyInfo.set(row.id, { name: row.name, issuePrefix: row.issuePrefix });
    }

    const merged: Array<Record<string, unknown>> = [];
    for (const companyId of companyIds) {
      const info = companyInfo.get(companyId);
      const list = await issues.list(companyId, { touchedByUserId: userId, limit: 200 });
      for (const issue of list) {
        merged.push({ ...issue, companyName: info?.name ?? null, companyPrefix: info?.issuePrefix ?? null });
      }
    }
    merged.sort((a, b) => {
      const at = new Date(String(a.updatedAt ?? a.createdAt ?? 0)).getTime();
      const bt = new Date(String(b.updatedAt ?? b.createdAt ?? 0)).getTime();
      return bt - at;
    });
    res.json(merged.slice(0, limit));
  });

  // Provision/start the caller's personal workspace container ahead of the
  // editor iframe loading. Idempotent.
  router.post("/me/workspace/ensure", async (req, res) => {
    assertBoard(req);
    const userId = req.actor.userId;
    if (!userId) throw forbidden("Board user required");
    try {
      await ensureUserContainer(userId, req.actor.userEmail ?? null);
      res.json({ ready: true, editorPath: "/editor/" });
    } catch (err) {
      res.status(502).json({ ready: false, error: (err as Error).message });
    }
  });

  // Cross-company audit timeline. With everyone an instance_admin, the audit
  // log is the load-bearing control — this surfaces it. Admin only.
  router.get("/instance/activity", async (req, res) => {
    assertInstanceAdmin(req);
    const limit = clampLimit(req.query.limit, 100, 500);
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId : null;
    const where = companyId ? eq(activityLog.companyId, companyId) : undefined;
    const rows = await db
      .select({
        id: activityLog.id,
        companyId: activityLog.companyId,
        companyName: companies.name,
        actorType: activityLog.actorType,
        actorId: activityLog.actorId,
        action: activityLog.action,
        entityType: activityLog.entityType,
        entityId: activityLog.entityId,
        details: activityLog.details,
        createdAt: activityLog.createdAt,
      })
      .from(activityLog)
      .leftJoin(companies, eq(activityLog.companyId, companies.id))
      .where(where ? and(where) : undefined)
      .orderBy(desc(activityLog.createdAt))
      .limit(limit);
    res.json(rows);
  });

  return router;
}
