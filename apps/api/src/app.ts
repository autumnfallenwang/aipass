import type { Db } from "@aipass/db";
import type { FhirClient } from "@aipass/fhir";
import {
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
} from "@better-auth/oauth-provider";
import { type Context, Hono } from "hono";
import * as z from "zod";
import { adminRoutes } from "./admin.ts";
import { approvalRoutes } from "./approvals.ts";
import { type Auth, adminExists } from "./auth.ts";
import { config } from "./config.ts";
import { publicConnectionRoutes } from "./connections.ts";
import { personFhirRoutes } from "./fhir-servers.ts";
import { publicJwks } from "./keys.ts";
import { mintPass, PassError } from "./pass.ts";
import { personRoutes } from "./person.ts";

function isLoopback(addr: string | undefined): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

export type ApiDeps = {
  db: Db;
  auth: Auth;
  fhir: FhirClient;
  remoteAddr?: (c: Context) => string | undefined;
  /** How the api reaches the gateway (tests pass the gateway app's fetch). */
  fetch?: typeof fetch;
};

export function createApp(deps: ApiDeps) {
  const { db, auth } = deps;
  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok", service: "aipass-api" }));

  app.get("/.well-known/jwks.json", async (c) => {
    c.header("cache-control", "public, max-age=60");
    return c.json(await publicJwks(db));
  });

  // Better Auth: sign-up, sign-in, sessions, passkeys, and the OAuth server for AI apps.
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  // RFC 8414 / OIDC discovery for the issuer `<public origin>/api/auth` (the web
  // app passes these paths through, D10).
  const asMetadata = oauthProviderAuthServerMetadata(auth);
  const oidcMetadata = oauthProviderOpenIdConfigMetadata(auth);
  app.get("/.well-known/oauth-authorization-server/api/auth", (c) => asMetadata(c.req.raw));
  app.get("/.well-known/openid-configuration/api/auth", (c) => oidcMetadata(c.req.raw));

  // Whether this install still needs its first (admin) account.
  app.get("/api/setup", async (c) => c.json({ needsAdmin: !(await adminExists(db)) }));

  app.get("/api/me", async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: "not signed in" }, 401);
    const u = session.user as typeof session.user & { role?: string };
    return c.json({ id: u.id, name: u.name, email: u.email, role: u.role ?? "person" });
  });

  app.route("/api/admin", adminRoutes({ db, auth, fhir: deps.fhir, fetch: deps.fetch }));
  app.route("/api/connections", publicConnectionRoutes({ db }));
  app.route("/api/person/fhir", personFhirRoutes({ db, auth, fetch: deps.fetch }));
  // approvals before the general person routes: both live under /api/person
  app.route("/api/person/approvals", approvalRoutes({ db, auth }));
  app.route("/api/person", personRoutes({ db, auth }));

  // Dev passes (S1): only when AIPASS_DEV_PASSES=1, and only from this machine.
  app.post("/dev/passes", async (c) => {
    if (!config.devPasses) return c.json({ error: "dev passes are disabled" }, 404);
    if (!isLoopback(deps.remoteAddr?.(c))) return c.json({ error: "loopback only" }, 403);
    const body = z
      .object({
        agent: z.string(),
        person: z.string(),
        ttl: z.number().int().positive().optional(),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "expected {agent, person, ttl?}" }, 400);
    try {
      const pass = await mintPass(db, {
        agentId: body.data.agent,
        personId: body.data.person,
        ttlSeconds: body.data.ttl,
      });
      return c.json(pass);
    } catch (err) {
      if (err instanceof PassError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  return app;
}
