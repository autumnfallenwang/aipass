import { agentClients, agents, connections, type Db, persons, users } from "@aipass/db";
import type { OAuthProviderExtension } from "@better-auth/oauth-provider";
import { APIError } from "better-auth/api";
import { and, eq } from "drizzle-orm";
import { createRemoteJWKSet, decodeJwt, errors, type JWTVerifyGetKey, jwtVerify } from "jose";
import { agentIdOfResource } from "./oauth.ts";

export const TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";
const ACCESS_TOKEN = "urn:ietf:params:oauth:token-type:access_token";
const SUBJECT_TOKEN_TYPES = new Set([
  ACCESS_TOKEN,
  "urn:ietf:params:oauth:token-type:id_token",
  "urn:ietf:params:oauth:token-type:jwt",
]);
/**
 * Claims we refuse in a subject token rather than guess at: an `act` means it
 * is already a delegated token (we allow one hop, like SMART Permission
 * Tickets); `may_act` would let it nominate actors; `cnf` binds it to a key we
 * can't check here.
 */
const REFUSED_CLAIMS = ["act", "may_act", "cnf"];

function oauthError(
  error: string,
  description: string,
  status: "BAD_REQUEST" | "UNAUTHORIZED" = "BAD_REQUEST",
) {
  return new APIError(status, { error, error_description: description });
}

/**
 * RFC 8693 token exchange for headless agents (S6). The agent authenticates as
 * itself (the actor) and presents the person's token from a trusted identity
 * provider (the subject). The result is an aipass pass: `sub` = the person's
 * login, `act.sub` = the agent, `aud` = that agent's gateway URL, 5 minutes.
 * Everything that isn't clearly right is refused.
 */
export function tokenExchange(db: Db): OAuthProviderExtension {
  const keySets = new Map<string, JWTVerifyGetKey>();
  const keysFor = (jwksUri: string) => {
    let k = keySets.get(jwksUri);
    if (!k) {
      k = createRemoteJWKSet(new URL(jwksUri));
      keySets.set(jwksUri, k);
    }
    return k;
  };

  return {
    metadata: () => ({ token_exchange_subject_token_types_supported: [...SUBJECT_TOKEN_TYPES] }),
    grants: {
      [TOKEN_EXCHANGE]: async ({ ctx, provider }) => {
        const body = (ctx.body ?? {}) as Record<string, unknown>;

        // 1. The actor: the agent's own client credentials. A public client can't act.
        let client: Awaited<ReturnType<typeof provider.authenticateClient>>["client"];
        try {
          ({ client } = await provider.authenticateClient());
        } catch {
          throw oauthError(
            "invalid_client",
            "the agent must authenticate as itself",
            "UNAUTHORIZED",
          );
        }
        if (!client.tokenEndpointAuthMethod || client.tokenEndpointAuthMethod === "none") {
          throw oauthError(
            "invalid_client",
            "a public client can't act for anyone: authenticate the agent",
            "UNAUTHORIZED",
          );
        }
        if (body.actor_token) {
          throw oauthError(
            "invalid_request",
            "authenticate the agent as the client; actor_token isn't accepted",
          );
        }

        // 2. The subject: the person's token, from an enabled connection, for us.
        const subjectToken = typeof body.subject_token === "string" ? body.subject_token : "";
        const subjectType =
          typeof body.subject_token_type === "string" ? body.subject_token_type : "";
        if (!subjectToken) throw oauthError("invalid_request", "subject_token is required");
        if (!SUBJECT_TOKEN_TYPES.has(subjectType)) {
          throw oauthError("invalid_request", `unsupported subject_token_type "${subjectType}"`);
        }
        if (body.requested_token_type && body.requested_token_type !== ACCESS_TOKEN) {
          throw oauthError("invalid_request", "only access tokens can be requested");
        }
        let iss: string | undefined;
        try {
          iss = decodeJwt(subjectToken).iss;
        } catch {
          throw oauthError("invalid_grant", "subject_token isn't a JWT");
        }
        const [conn] = iss
          ? await db
              .select()
              .from(connections)
              .where(and(eq(connections.issuer, iss), eq(connections.enabled, true)))
          : [];
        if (!conn) throw oauthError("invalid_grant", `untrusted issuer: ${iss ?? "none"}`);
        let claims: Record<string, unknown>;
        try {
          ({ payload: claims } = await jwtVerify(subjectToken, keysFor(conn.jwksUri), {
            issuer: conn.issuer,
            audience: conn.audience,
            clockTolerance: 10,
          }));
        } catch (err) {
          if (err instanceof errors.JWTClaimValidationFailed && err.claim === "aud") {
            throw oauthError(
              "invalid_grant",
              `the subject token isn't for aipass (aud must include "${conn.audience}")`,
            );
          }
          if (err instanceof errors.JWTExpired)
            throw oauthError("invalid_grant", "the subject token expired");
          throw oauthError("invalid_grant", "the subject token didn't verify");
        }
        const refused = REFUSED_CLAIMS.filter((c) => c in claims);
        if (refused.length) {
          throw oauthError(
            "invalid_grant",
            `the subject token carries claims aipass doesn't accept: ${refused.join(", ")}`,
          );
        }

        // 3. Which person: a verified email that belongs to an aipass login with a person.
        if (claims.email_verified !== true || typeof claims.email !== "string") {
          throw oauthError("invalid_grant", "the subject token has no verified email");
        }
        const [user] = await db
          .select()
          .from(users)
          .where(eq(users.email, claims.email.toLowerCase()));
        const [person] = user
          ? await db.select().from(persons).where(eq(persons.userId, user.id))
          : [];
        if (!user || !person)
          throw oauthError("invalid_grant", "nobody in aipass matches this identity");

        // 4. Which agent: the resource, an agent this client may act as.
        const resource = Array.isArray(body.resource) ? body.resource[0] : body.resource;
        const agentId = typeof resource === "string" ? agentIdOfResource(resource) : null;
        if (!agentId || typeof resource !== "string") {
          throw oauthError("invalid_target", "resource must be one agent's gateway URL");
        }
        const [allowed] = await db
          .select()
          .from(agentClients)
          .innerJoin(agents, eq(agentClients.agentId, agents.id))
          .where(
            and(eq(agentClients.agentId, agentId), eq(agentClients.clientId, client.clientId)),
          );
        if (!allowed)
          throw oauthError("invalid_target", `this client isn't approved to act as ${agentId}`);

        const issued = await provider.issueTokens({
          client,
          scopes: [],
          user: user as never,
          resources: [resource],
        });
        return { ...issued, issued_token_type: ACCESS_TOKEN } as typeof issued;
      },
    },
  };
}
