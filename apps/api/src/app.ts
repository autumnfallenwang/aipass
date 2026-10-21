import type { Db } from "@aipass/db";
import type { FhirClient } from "@aipass/fhir";
import { clientAddress } from "@aipass/shared";
import {
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
} from "@better-auth/oauth-provider";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { secureHeaders } from "hono/secure-headers";
import * as z from "zod";
import { adminRoutes } from "./admin.ts";
import { approvalRoutes } from "./approvals.ts";
import { type Auth, adminExists, CLIENT_IP_HEADER } from "./auth.ts";
import { personChatRoutes } from "./chat.ts";
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
  /** How the api reaches model endpoints (tests pass a fake model). */
  modelFetch?: typeof fetch;
  /** How the built-in chat reaches aipass's own token endpoint (tests pass this app's request). */
  selfFetch?: typeof fetch;
  /** Re-reads aipass's registered FHIR server now (after an edit on the admin page). */
  onFhirServerChanged?: () => Promise<void>;
};

export function createApp(deps: ApiDeps) {
  const { db, auth } = deps;
  const app = new Hono();
  // Security headers on every response (S7). HSTS only takes effect over
  // HTTPS, which the adopter terminates in front of aipass.
  app.use(
    "*",
    secureHeaders({
      strictTransportSecurity: "max-age=31536000",
      referrerPolicy: "no-referrer",
      xFrameOptions: "DENY",
    }),
  );

  // CSRF (S7, ASVS V3.5): browsers send Origin with every POST, PUT, PATCH
  // and DELETE, so a state change from any other site is refused. Callers that
  // aren't browsers (no Origin) are still checked by their session.
  const ownOrigin = new URL(config.publicUrl).origin;
  const sameOriginOnly: MiddlewareHandler = async (c, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      const o = c.req.header("origin");
      const site = c.req.header("sec-fetch-site");
      if ((o && o !== ownOrigin) || site === "cross-site" || site === "same-site") {
        return c.json({ error: "cross-site request refused" }, 403);
      }
    }
    await next();
  };
  app.use("/api/admin/*", sameOriginOnly);
  app.use("/api/person/*", sameOriginOnly);

  // Security events (S7, ASVS V16): every admin change, as one JSON line.
  app.use("/api/admin/*", async (c, next) => {
    await next();
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      console.info(
        JSON.stringify({
          event: "admin_change",
          admin: (c.get as (k: string) => unknown)("adminId") ?? null,
          method: c.req.method,
          path: c.req.path,
          status: c.res.status,
        }),
      );
    }
  });

  app.get("/health", (c) => c.json({ status: "ok", service: "aipass-api" }));

  app.get("/.well-known/jwks.json", async (c) => {
    c.header("cache-control", "public, max-age=60");
    return c.json(await publicJwks(db));
  });

  // Better Auth: sign-up, sign-in, sessions, passkeys, and the OAuth server for AI apps.
  app.on(["GET", "POST"], "/api/auth/*", async (c) => {
    // Managing SSO providers is the admin's job, through Connections; Better
    // Auth would let any signed-in person register one. Sign-in callbacks pass.
    const path = c.req.path;
    if (path.startsWith("/api/auth/sso/") && !path.startsWith("/api/auth/sso/callback/")) {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      const role = (session?.user as { role?: string } | undefined)?.role;
      if (role !== "admin") return c.json({ error: "admins only" }, 403);
    }
    // Rate limits key on the client's address, which we work out ourselves
    // (the socket, or a trusted proxy's X-Forwarded-For), never what the client says.
    const headers = new Headers(c.req.raw.headers);
    headers.set(
      CLIENT_IP_HEADER,
      clientAddress(deps.remoteAddr?.(c), c.req.header("x-forwarded-for"), config.trustedProxies),
    );
    return auth.handler(new Request(c.req.raw, { headers }));
  });

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

  app.route(
    "/api/admin",
    adminRoutes({
      db,
      auth,
      fhir: deps.fhir,
      fetch: deps.fetch,
      modelFetch: deps.modelFetch,
      onFhirServerChanged: deps.onFhirServerChanged,
    }),
  );
  app.route("/api/connections", publicConnectionRoutes({ db }));
  app.route("/api/person/fhir", personFhirRoutes({ db, auth, fetch: deps.fetch }));
  // approvals and the chat before the general person routes: all live under /api/person
  app.route("/api/person/approvals", approvalRoutes({ db, auth, fhir: deps.fhir }));
  app.route(
    "/api/person/chat",
    personChatRoutes({
      db,
      auth,
      fetch: deps.fetch,
      fhir: deps.fhir,
      modelFetch: deps.modelFetch,
      selfFetch: deps.selfFetch,
    }),
  );
  app.route("/api/person", personRoutes({ db, auth, fhir: deps.fhir }));

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
