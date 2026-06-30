import type { Issue } from "@paperclipai/shared";
import { api } from "./client";

export type MyChat = Issue & { companyName: string | null; companyPrefix: string | null };

export type InstanceActivityEntry = {
  id: string;
  companyId: string;
  companyName: string | null;
  actorType: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown> | null;
  createdAt: string;
};

export const meApi = {
  /** This user's chats across every company they belong to. */
  issues: (limit = 100) => api.get<MyChat[]>(`/me/issues?limit=${limit}`),
  /** Provision/start this user's personal workspace container. */
  ensureWorkspace: () =>
    api.post<{ ready: boolean; editorPath?: string; error?: string }>(`/me/workspace/ensure`, {}),
  /** Cross-company audit timeline (instance admin only). */
  instanceActivity: (limit = 100) =>
    api.get<InstanceActivityEntry[]>(`/instance/activity?limit=${limit}`),
};
