import { authSchema, type Db, persons, users } from "@aipass/db";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { oauthProvider } from "@better-auth/oauth-provider";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { jwt } from "better-auth/plugins";
import { count, eq } from "drizzle-orm";
import { config } from "./config.ts";
import { agentIdOfResource, linkPendingClient } from "./oauth.ts";
import { patientIdOf } from "./pass.ts";

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
export function createAuth(db: Db) {
  const origin = new URL(config.publicUrl);
  return betterAuth({
    appName: "aipass",
    baseURL: config.publicUrl,
    basePath: "/api/auth",
    secret: config.authSecret,
    trustedOrigins: [config.publicUrl],
    database: drizzleAdapter(db, { provider: "pg", schema: authSchema }),
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
        extensions: [
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
      cimd({
        fetchClientMetadataResource,
        onClientCreated: async ({ client }) => linkPendingClient(db, client.clientId),
      }),
    ],
    advanced: { cookiePrefix: "aipass" },
  });
}

export type Auth = ReturnType<typeof createAuth>;
