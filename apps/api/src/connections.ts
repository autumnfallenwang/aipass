import { agents, connections, type Db } from "@aipass/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import * as z from "zod";
import type { Auth } from "./auth.ts";
import { config } from "./config.ts";
import { allowClient } from "./oauth.ts";
import { TOKEN_EXCHANGE } from "./token-exchange.ts";

const ConnectionBody = z.strictObject({
  name: z.string().trim().min(1).max(80),
  issuer: z.url().transform((u) => u.replace(/\/$/, "")),
  /** The `aud` subject tokens must carry for exchange here. */
  audience: z.string().trim().min(1).max(200),
  /** Optional: a client registered at the provider, so people and admins can sign in with it. */
  clientId: z.string().trim().min(1).optional(),
  clientSecret: z.string().min(1).optional(),
});

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "connection"
  );
}

/** The sign-in buttons the login page offers (anyone may ask). */
export function publicConnectionRoutes(deps: { db: Db }) {
  const app = new Hono();
  app.get("/", async (c) => {
    const rows = await deps.db.select().from(connections).where(eq(connections.enabled, true));
    return c.json(
      rows
        .filter((r) => r.ssoProviderId)
        .map((r) => ({ name: r.name, providerId: r.ssoProviderId })),
    );
  });
  return app;
}

/** Admin: trusted identity providers, and credentials for headless agents (S6). */
export function adminConnectionRoutes(deps: { db: Db; auth: Auth; fetch?: typeof fetch }) {
  const { db, auth } = deps;
  const doFetch = deps.fetch ?? fetch;
  const app = new Hono();

  app.get("/connections", async (c) =>
    c.json(await db.select().from(connections).orderBy(connections.createdAt)),
  );

  app.post("/connections", async (c) => {
    const body = ConnectionBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400);
    const { name, issuer, audience, clientId, clientSecret } = body.data;
    // Discovery is the only way in: the issuer must say where its keys are.
    let jwksUri: string;
    try {
      // No redirects: the issuer answers for itself or not at all.
      const res = await doFetch(`${issuer}/.well-known/openid-configuration`, {
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
      const meta = (await res.json()) as { issuer?: string; jwks_uri?: string };
      if (!res.ok || meta.issuer?.replace(/\/$/, "") !== issuer || !meta.jwks_uri) {
        return c.json({ error: "the issuer's discovery document doesn't match it" }, 400);
      }
      jwksUri = meta.jwks_uri;
    } catch (err) {
      console.error(`connection discovery for ${issuer} failed: ${(err as Error).message}`);
      return c.json({ error: "couldn't read the issuer's discovery document" }, 400);
    }
    const id = slugify(name);
    const ssoProviderId = clientId ? id : null;
    const [row] = await db
      .insert(connections)
      .values({ id, name, issuer, jwksUri, audience, ssoProviderId, enabled: true })
      .onConflictDoNothing()
      .returning();
    if (!row) return c.json({ error: "a connection with that name or issuer already exists" }, 409);
    if (clientId) {
      // Through the HTTP handler rather than auth.api, so the trusted origins
      // (which now include this issuer, if it's internal) are re-read.
      const res = await auth.handler(
        new Request(`${config.publicUrl}/api/auth/sso/register`, {
          method: "POST",
          headers: {
            cookie: c.req.header("cookie") ?? "",
            origin: config.publicUrl,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            providerId: id,
            issuer,
            domain: `${id}.connection.aipass`,
            oidcConfig: {
              clientId,
              clientSecret,
              discoveryEndpoint: `${issuer}/.well-known/openid-configuration`,
              scopes: ["openid", "email", "profile"],
              pkce: true,
            },
          }),
        }),
      );
      if (!res.ok) {
        await db.delete(connections).where(eq(connections.id, id));
        const err = (await res.json().catch(() => ({}))) as { message?: string };
        return c.json({ error: `couldn't set up sign-in: ${err.message ?? res.status}` }, 400);
      }
    }
    return c.json(row, 201);
  });

  for (const [verb, enabled] of [
    ["enable", true],
    ["disable", false],
  ] as const) {
    app.post(`/connections/:id/${verb}`, async (c) => {
      const [row] = await db
        .update(connections)
        .set({ enabled })
        .where(eq(connections.id, c.req.param("id")))
        .returning();
      return row ? c.json(row) : c.json({ error: "no such connection" }, 404);
    });
  }

  // A headless agent's own credentials, for token exchange. The secret is shown once.
  app.post("/agents/:id/headless-client", async (c) => {
    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, c.req.param("id")));
    if (!agent) return c.json({ error: "no such agent" }, 404);
    let created: { client_id: string; client_secret?: string };
    try {
      created = (await auth.api.adminCreateOAuthClient({
        headers: c.req.raw.headers,
        body: {
          client_name: `${agent.name} (headless)`,
          token_endpoint_auth_method: "client_secret_basic",
          grant_types: [TOKEN_EXCHANGE],
        },
      })) as typeof created;
    } catch (err) {
      const body = (err as { body?: { error_description?: string } }).body;
      return c.json({ error: body?.error_description ?? "couldn't create the client" }, 400);
    }
    await allowClient(db, agent.id, created.client_id);
    return c.json({ clientId: created.client_id, clientSecret: created.client_secret }, 201);
  });

  return app;
}
