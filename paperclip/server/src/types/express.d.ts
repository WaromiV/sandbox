import "express";

type MembershipRow = {
  companyId: string;
  membershipRole: string | null;
  status: string;
};

type Actor = {
  type: "board" | "agent" | "none";
  source: "local_implicit" | "session" | "board_key" | "agent_key" | "agent_jwt" | "cloud_tenant" | "none";
  userId?: string;
  userName?: string | null;
  userEmail?: string | null;
  isInstanceAdmin?: boolean;
  companyIds?: string[];
  memberships?: MembershipRow[];
  keyId?: string;
  runId?: string;
  agentId?: string;
  companyId?: string;
};

declare global {
  namespace Express {
    interface Request {
      actor: Actor;
    }
  }
}
