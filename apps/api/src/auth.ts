import { authSchema, connections, type Db, persons, users } from "@aipass/db";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { oauthProvider } from "@better-auth/oauth-provider";
import { passkey } from "@better-auth/passkey";
import { sso } from "@better-auth/sso";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { jwt } from "better-auth/plugins";
import { and, count, eq, isNotNull } from "drizzle-orm";
import { config } from "./config.ts";
import { agentIdOfResource, linkPendingClient } from "./oauth.ts";
import { patientIdOf } from "./pass.ts";
import { TOKEN_EXCHANGE, tokenExchange } from "./token-exchange.ts";

export async function adminExists(db: Db): Promise<boolean> {
  const [row] = await db.select({ n: count() }).from(users).where(eq(users.role, "admin"));
  return (row?.n ?? 0) > 0;
}

/**
 * Better Auth on the public origin (D10):
 * - admin and person logins (email + password, passkeys);
 * - the OAuth authorization server AI clients use (S3). Its access token *is*
 *   the pass: `sub` = the person's login, `act.sub` = the agent, `aud` = that
 *   agent's gateway URL, 5 minutes.
 */
/**
 * Hosts Better Auth's SSO plugin refuses to fetch unless trusted: loopback,
 * private ranges and single-label (container) names. A hospital's internal
 * login lives on one of these; a public one (Google) needs no trust.
 */
export function isInternalHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "");
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    !h.includes(".") ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^(::1|f[cd][0-9a-f]{2}:)/i.test(h)
  );
}

export function createAuth(db: Db) {
  const origin = new URL(config.publicUrl);
  return betterAuth({
    appName: "aipass",
    baseURL: config.publicUrl,
    basePath: "/api/auth",
    secret: config.authSecret,
    // The public origin, plus enabled sign-in connections on internal hosts
    // (S6). Re-read on every request, so disabling a connection takes effect.
    trustedOrigins: async () => {
      try {
        const rows = await db
          .select({ issuer: connections.issuer })
          .from(connections)
          .where(and(eq(connections.enabled, true), isNotNull(connections.ssoProviderId)));
        const internal = rows
          .map((r) => new URL(r.issuer))
          .filter((u) => isInternalHost(u.hostname));
        return [config.publicUrl, ...internal.map((u) => u.origin)];
      } catch (err) {
        // No database yet (first start) or a bad row: trust only our own origin.
        console.error(`trusted origins: ${(err as Error).message}`);
        return [config.publicUrl];
      }
    },
    // Transactions on: the SSO plugin links accounts inside one (S6).
    database: drizzleAdapter(db, { provider: "pg", schema: authSchema, transaction: true }),
    emailAndPassword: { enabled: true, minPasswordLength: 10 },
    user: {
      additionalFields: {
        // "admin" runs the clinic's aipass; "person" is someone an agent acts for.
        role: { type: "string", required: false, defaultValue: "person", input: false },
      },
    },
    databaseHooks: {
      user: {
        create: {
          // The first account on an install with no admin becomes the admin.
          before: async (user) => ({
            data: { ...user, role: (await adminExists(db)) ? "person" : "admin" },
          }),
        },
      },
    },
    plugins: [
      passkey({ rpID: origin.hostname, rpName: "aipass", origin: config.publicUrl }),
      jwt(),
      oauthProvider({
        loginPage: "/login",
        consentPage: "/consent",
        scopes: ["openid", "profile", "email", "offline_access"],
        // MCP clients without a metadata document register themselves. A newly
        // registered app can't act as any agent until the admin allows it.
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationDefaultApplicationType: "infer",
        enforcePerClientResources: true,
        grantTypes: ["authorization_code", "refresh_token", "client_credentials", TOKEN_EXCHANGE],
        extensions: [
          tokenExchange(db),
          {
            claims: {
              accessToken: async ({ user, resources }) => {
                const agentIds = (resources ?? []).map(agentIdOfResource).filter(Boolean);
                if (agentIds.length !== 1 || !agentIds[0]) return {};
                const [person] = user
                  ? await db.select().from(persons).where(eq(persons.userId, user.id))
                  : [];
                const patient = person ? patientIdOf(person.fhirRef) : undefined;
                return { act: { sub: agentIds[0] }, ...(patient ? { patient } : {}) };
              },
            },
          },
        ],
      }),
      sso({
        // A connection is an identity provider the admin chose to trust, so
        // its email_verified claim counts (and is required, below).
        trustEmailVerified: true,
        // Someone signing in with a connected login (S6) is linked to their
        // existing aipass account, and only when the provider says the email
        // is verified.
        resolveUser: async (input, { database }) => {
          const { email, emailVerified } = input.providerUser;
          if (!emailVerified) {
            return {
              action: "reject",
              code: "email_not_verified",
              message: "your login provider hasn't verified your email",
            };
          }
          const existing = await database.findOne<{ id: string }>({
            model: "user",
            where: [{ field: "email", value: email.toLowerCase() }],
          });
          // No sign-up through a connection: logins come from the admin.
          return existing
            ? { action: "link", userId: existing.id, profile: "preserve" }
            : {
                action: "reject",
                code: "no_account",
                message: "ask your clinic's aipass admin to give you a login",
              };
        },
      }),
      cimd({
        fetchClientMetadataResource,
        onClientCreated: async ({ client }) => linkPendingClient(db, client.clientId),
      }),
    ],
    advanced: { cookiePrefix: "aipass" },
  });
}

export type Auth = ReturnType<typeof createAuth>;
