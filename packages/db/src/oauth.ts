import { agentUrl, PASS_MAX_SECONDS } from "@aipass/shared";
import { and, arrayContains, eq, isNull } from "drizzle-orm";
import { oauthClient, oauthClientResource, oauthRefreshToken, oauthResource } from "./auth.ts";
import { newId } from "./ids.ts";
import type { Db } from "./index.ts";
import { agentClients, agents } from "./schema.ts";

/**
 * Each agent is its own OAuth protected resource (D9): its gateway URL is the
 * RFC 8707 `resource` a client asks a token for, and the token's audience.
 */
export function resourceOf(gatewayUrl: string, agentId: string): string {
  return agentUrl(gatewayUrl, agentId);
}

/** `http://gateway/agents/diabetes-coach/mcp` → `diabetes-coach`. Anything else → null. */
export function agentIdOfResource(gatewayUrl: string, resource: string): string | null {
  const prefix = `${gatewayUrl.replace(/\/$/, "")}/agents/`;
  if (!resource.startsWith(prefix) || !resource.endsWith("/mcp")) return null;
  const id = resource.slice(prefix.length, -"/mcp".length);
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(id) ? id : null;
}

/** Makes sure Better Auth knows the agent's resource, with a 5-minute access token. */
export async function syncAgentResource(
  db: Db,
  gatewayUrl: string,
  agent: { id: string; name: string },
): Promise<void> {
  const now = new Date();
  await db
    .insert(oauthResource)
    .values({
      id: newId("res"),
      identifier: resourceOf(gatewayUrl, agent.id),
      name: agent.name,
      accessTokenTtl: PASS_MAX_SECONDS,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: oauthResource.identifier,
      set: { name: agent.name, accessTokenTtl: PASS_MAX_SECONDS, updatedAt: now },
    });
}

/**
 * Lets an AI app (OAuth client) connect as an agent. Better Auth's own link
 * can only be written once the client exists; a CIMD client such as Claude
 * Code only appears on its first visit, so `linkPendingClient` finishes the job then.
 */
export async function allowClient(
  db: Db,
  gatewayUrl: string,
  agentId: string,
  clientId: string,
): Promise<void> {
  await db.insert(agentClients).values({ agentId, clientId }).onConflictDoNothing();
  await linkPendingClient(db, gatewayUrl, clientId);
}

export async function disallowClient(
  db: Db,
  gatewayUrl: string,
  agentId: string,
  clientId: string,
): Promise<void> {
  await db
    .delete(agentClients)
    .where(and(eq(agentClients.agentId, agentId), eq(agentClients.clientId, clientId)));
  await db
    .delete(oauthClientResource)
    .where(
      and(
        eq(oauthClientResource.clientId, clientId),
        eq(oauthClientResource.resourceId, resourceOf(gatewayUrl, agentId)),
      ),
    );
}

/** Writes Better Auth's client↔resource links for every agent this client is allowed to act as. */
export async function linkPendingClient(
  db: Db,
  gatewayUrl: string,
  clientId: string,
): Promise<void> {
  const [client] = await db
    .select({ clientId: oauthClient.clientId })
    .from(oauthClient)
    .where(eq(oauthClient.clientId, clientId));
  if (!client) return;
  const rows = await db
    .select({ agent: agents })
    .from(agentClients)
    .innerJoin(agents, eq(agentClients.agentId, agents.id))
    .where(eq(agentClients.clientId, clientId));
  for (const { agent } of rows) {
    await syncAgentResource(db, gatewayUrl, agent);
    await db
      .insert(oauthClientResource)
      .values({
        id: newId("ocr"),
        clientId,
        resourceId: resourceOf(gatewayUrl, agent.id),
        createdAt: new Date(),
      })
      .onConflictDoNothing();
  }
}

/** On startup: every agent has its resource, every approved client its link. */
export async function syncOAuth(db: Db, gatewayUrl: string): Promise<void> {
  for (const agent of await db.select().from(agents)) {
    await syncAgentResource(db, gatewayUrl, agent);
  }
  const clients = await db.selectDistinct({ clientId: agentClients.clientId }).from(agentClients);
  for (const c of clients) await linkPendingClient(db, gatewayUrl, c.clientId);
}

/** Revokes every refresh token a person gave any app for this agent. */
export async function revokeRefreshTokens(
  db: Db,
  gatewayUrl: string,
  userId: string,
  agentId: string,
): Promise<number> {
  const rows = await db
    .update(oauthRefreshToken)
    .set({ revoked: new Date() })
    .where(
      and(
        eq(oauthRefreshToken.userId, userId),
        arrayContains(oauthRefreshToken.resources, [resourceOf(gatewayUrl, agentId)]),
        isNull(oauthRefreshToken.revoked),
      ),
    )
    .returning({ id: oauthRefreshToken.id });
  return rows.length;
}

/**
 * The built-in chat (S8): an ordinary public OAuth client (PKCE, no secret),
 * approved per agent in `agent_clients` like any other app, so its passes come
 * from the person's consent and the gateway checks it on every call.
 */
export const CHAT_CLIENT_ID = "aipass-chat";
export const CHAT_CLIENT_NAME = "aipass chat (built-in)";

/** Where the chat's sign-in comes back to: the public origin, which proxies `/api/*` (D10). */
export const chatCallbackUrl = (publicUrl: string) =>
  `${publicUrl.replace(/\/$/, "")}/api/person/chat/callback`;

/**
 * Makes sure the built-in chat is a registered OAuth client that redirects to
 * this install, linked to every agent the admin allowed it for.
 */
export async function ensureChatClient(
  db: Db,
  gatewayUrl: string,
  publicUrl: string,
): Promise<void> {
  const now = new Date();
  const fields = {
    name: CHAT_CLIENT_NAME,
    redirectUris: [chatCallbackUrl(publicUrl)],
    tokenEndpointAuthMethod: "none",
    applicationType: "web",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    scopes: ["openid", "offline_access"],
    requirePKCE: true,
    skipConsent: false,
    disabled: false,
    updatedAt: now,
  };
  await db
    .insert(oauthClient)
    .values({ id: CHAT_CLIENT_ID, clientId: CHAT_CLIENT_ID, createdAt: now, ...fields })
    .onConflictDoUpdate({ target: oauthClient.clientId, set: fields });
  await linkPendingClient(db, gatewayUrl, CHAT_CLIENT_ID);
}
