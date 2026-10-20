import { authSchema, type Db, users } from "@aipass/db";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { count } from "drizzle-orm";
import { config } from "./config.ts";

/**
 * Better Auth: admin and person logins (email + password, passkeys).
 * It is served at `/api/auth` on the *public* origin: the web app proxies
 * `/api/*` to this api, so cookies and passkeys belong to one origin.
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
          // The first account on a fresh install becomes the admin.
          before: async (user) => {
            const [row] = await db.select({ n: count() }).from(users);
            return { data: { ...user, role: (row?.n ?? 0) === 0 ? "admin" : "person" } };
          },
        },
      },
    },
    plugins: [passkey({ rpID: origin.hostname, rpName: "aipass", origin: config.publicUrl })],
    advanced: { cookiePrefix: "aipass" },
  });
}

export type Auth = ReturnType<typeof createAuth>;
