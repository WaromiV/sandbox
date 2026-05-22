// Helper for fetching a user's most recent Authentik id_token from the
// better-auth `account` table. Used by the editor-bridge proxy so it can
// forward Authorization: Bearer <id_token> to code-server when it runs in
// --auth oidc mode. Returning null is a normal outcome — email/password
// users have no id_token, and the proxy falls back to the HMAC bridge cookie
// in that case.

import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authAccounts } from "@paperclipai/db";
import { AUTHENTIK_PROVIDER_ID } from "./oidc-config.js";

export async function getLatestAuthentikIdToken(
  db: Db,
  userId: string,
): Promise<string | null> {
  const rows = await db
    .select({
      idToken: authAccounts.idToken,
      expiresAt: authAccounts.accessTokenExpiresAt,
    })
    .from(authAccounts)
    .where(
      and(
        eq(authAccounts.userId, userId),
        eq(authAccounts.providerId, AUTHENTIK_PROVIDER_ID),
      ),
    )
    .orderBy(desc(authAccounts.updatedAt))
    .limit(1);
  const row = rows[0];
  if (!row?.idToken) return null;
  // id_tokens are short-lived (5 min default in Authentik). If the row's
  // accessTokenExpiresAt has passed, the id_token is also stale — refusing
  // to forward it surfaces re-auth faster than letting code-server reject.
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;
  return row.idToken;
}
