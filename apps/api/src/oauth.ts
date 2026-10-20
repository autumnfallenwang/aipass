/**
 * The OAuth helpers from `@aipass/db`, bound to this install's gateway URL.
 * Each agent's gateway URL is its OAuth resource (D9).
 */
import * as o from "@aipass/db";
import { config } from "./config.ts";

const g = () => config.gatewayUrl;

export const resourceOf = (agentId: string) => o.resourceOf(g(), agentId);
export const agentIdOfResource = (resource: string) => o.agentIdOfResource(g(), resource);
export const syncAgentResource = (db: o.Db, agent: { id: string; name: string }) =>
  o.syncAgentResource(db, g(), agent);
export const allowClient = (db: o.Db, agentId: string, clientId: string) =>
  o.allowClient(db, g(), agentId, clientId);
export const disallowClient = (db: o.Db, agentId: string, clientId: string) =>
  o.disallowClient(db, g(), agentId, clientId);
export const linkPendingClient = (db: o.Db, clientId: string) =>
  o.linkPendingClient(db, g(), clientId);
export const syncOAuth = (db: o.Db) => o.syncOAuth(db, g());
export const revokeRefreshTokens = (db: o.Db, userId: string, agentId: string) =>
  o.revokeRefreshTokens(db, g(), userId, agentId);
