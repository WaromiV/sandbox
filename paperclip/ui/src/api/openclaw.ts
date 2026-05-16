import { api } from "./client";

export type OpenclawBridgeStatus = {
  enabled: boolean;
  ready?: boolean;
  fetchedAtMs?: number;
  agentCount?: number;
  /** Paperclip company id the bridge writes into. UI focuses on this one. */
  companyId?: string | null;
};

export type OpenclawAgent = {
  id: string;
  label: string;
  workspace: string | null;
  model: { primary?: string; fallbacks?: string[] } | null;
  identity: {
    name?: string;
    theme?: string;
    emoji?: string;
    avatar?: string;
    avatarUrl?: string;
  } | null;
  paperclipUuid: string;
};

export type OpenclawRoster = {
  fetchedAtMs: number;
  defaultId: string | null;
  agents: OpenclawAgent[];
};

export const openclawApi = {
  status: () => api.get<OpenclawBridgeStatus>("/openclaw/status"),
  agents: () => api.get<OpenclawRoster>("/openclaw/agents"),
};
