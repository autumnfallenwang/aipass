import { randomBytes } from "node:crypto";
import {
  agents,
  type Db,
  fhirServers,
  grants,
  persons,
  seal,
  smartLaunches,
  unseal,
  vault,
  vaultKey,
} from "@aipass/db";
import { authorizeUrl, discoverSmart, exchangeCode, pkcePair } from "@aipass/fhir";
import { and, eq, gt, inArray } from "drizzle-orm";
import { Hono } from "hono";
import * as z from "zod";
import type { Auth } from "./auth.ts";
import { config } from "./config.ts";

/** SMART v2 scopes for a standalone patient launch: read the record, add readings. */
export const DEFAULT_SCOPE =
  "launch/patient openid fhirUser offline_access patient/*.rs patient/Observation.c patient/Provenance.c";

const ServerBody = z.strictObject({
  name: z.string().trim().min(1).max(80),
  baseUrl: z.url().transform((u) => u.replace(/\/$/, "")),
  clientId: z.string().trim().min(1).max(200),
  clientSecret: z.string().min(1).max(500).optional(),
  scope: z.string().trim().min(1).max(1000).optional(),
});

const LAUNCH_MINUTES = 10;

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "fhir-server"
  );
}

export const callbackUrl = () => `${config.publicUrl}/api/person/fhir/callback`;

/** Admin: FHIR servers other than aipass's own (S6). Secrets go in sealed and never come out. */
export function adminFhirServerRoutes(deps: { db: Db; fetch?: typeof fetch }) {
  const { db } = deps;
  const key = vaultKey();
  const app = new Hono();

  app.get("/fhir-servers", async (c) => {
    const rows = await db.select().from(fhirServers).orderBy(fhirServers.createdAt);
    return c.json(
      rows.map(({ clientSecretSealed, ...r }) => ({
        ...r,
        confidential: Boolean(clientSecretSealed),
      })),
    );
  });

  app.post("/fhir-servers", async (c) => {
    const body = ServerBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400);
    const { name, baseUrl, clientId, clientSecret, scope } = body.data;
    let endpoints: Awaited<ReturnType<typeof discoverSmart>>;
    try {
      endpoints = await discoverSmart(baseUrl, deps.fetch);
    } catch (err) {
      return c.json(
        { error: `couldn't read the server's SMART configuration: ${(err as Error).message}` },
        400,
      );
    }
    const id = slugify(name);
    const [row] = await db
      .insert(fhirServers)
      .values({
        id,
        name,
        baseUrl,
        ...endpoints,
        clientId,
        clientSecretSealed: clientSecret ? seal(key, clientSecret, `server|${id}`) : null,
        scope: scope ?? DEFAULT_SCOPE,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) return c.json({ error: "a server with that name or URL already exists" }, 409);
    const { clientSecretSealed, ...shown } = row;
    return c.json(
      { ...shown, confidential: Boolean(clientSecretSealed), redirectUri: callbackUrl() },
      201,
    );
  });

  for (const [verb, enabled] of [
    ["enable", true],
    ["disable", false],
  ] as const) {
    app.post(`/fhir-servers/:id/${verb}`, async (c) => {
      const [row] = await db
        .update(fhirServers)
        .set({ enabled })
        .where(eq(fhirServers.id, c.req.param("id")))
        .returning({ id: fhirServers.id, enabled: fhirServers.enabled });
      return row ? c.json(row) : c.json({ error: "no such server" }, 404);
    });
  }

  return app;
}

/**
 * The person's side: connect their record at an EHR with a SMART standalone
 * patient launch. The tokens go straight into the vault; the person sees only
 * "connected", and agents never see them at all.
 */
export function personFhirRoutes(deps: { db: Db; auth: Auth; fetch?: typeof fetch }) {
  const { db, auth } = deps;
  const key = vaultKey();
  const app = new Hono<{ Variables: { personId: string } }>();
  const back = (q: Record<string, string>) =>
    `${config.publicUrl}/my-ais?${new URLSearchParams(q)}`;

  app.use("*", async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: "sign in first" }, 401);
    const [person] = await db.select().from(persons).where(eq(persons.userId, session.user.id));
    if (!person) return c.json({ error: "this login isn't anyone's" }, 403);
    c.set("personId", person.id);
    await next();
  });

  // Servers my AIs read from, and whether I've connected my record there.
  app.get("/", async (c) => {
    const personId = c.get("personId");
    const used = await db
      .selectDistinct({ serverId: agents.fhirServerId })
      .from(grants)
      .innerJoin(agents, eq(grants.agentId, agents.id))
      .where(eq(grants.personId, personId));
    const ids = used.map((u) => u.serverId).filter((x): x is string => Boolean(x));
    if (ids.length === 0) return c.json([]);
    const servers = await db
      .select()
      .from(fhirServers)
      .where(and(inArray(fhirServers.id, ids), eq(fhirServers.enabled, true)));
    const links = await db.select().from(vault).where(eq(vault.personId, personId));
    return c.json(
      servers.map((s) => {
        const link = links.find((l) => l.serverId === s.id);
        return {
          id: s.id,
          name: s.name,
          connected: Boolean(link),
          connectedAt: link?.connectedAt ?? null,
        };
      }),
    );
  });

  app.get("/:id/connect", async (c) => {
    const [server] = await db
      .select()
      .from(fhirServers)
      .where(and(eq(fhirServers.id, c.req.param("id")), eq(fhirServers.enabled, true)));
    if (!server) return c.json({ error: "no such server" }, 404);
    const state = randomBytes(24).toString("base64url");
    const { verifier, challenge } = pkcePair();
    await db.insert(smartLaunches).values({
      state,
      personId: c.get("personId"),
      serverId: server.id,
      codeVerifier: verifier,
      expiresAt: new Date(Date.now() + LAUNCH_MINUTES * 60_000),
    });
    return c.redirect(
      authorizeUrl({
        authorizeUrl: server.authorizeUrl,
        clientId: server.clientId,
        redirectUri: callbackUrl(),
        scope: server.scope,
        state,
        codeChallenge: challenge,
        aud: server.baseUrl,
      }),
    );
  });

  app.get("/callback", async (c) => {
    const state = c.req.query("state") ?? "";
    // Single use: the launch is gone whatever happens next.
    const [launch] = await db
      .delete(smartLaunches)
      .where(and(eq(smartLaunches.state, state), gt(smartLaunches.expiresAt, new Date())))
      .returning();
    if (!launch || launch.personId !== c.get("personId")) {
      return c.redirect(
        back({ connect_error: "that sign-in link expired or isn't yours; try again" }),
      );
    }
    const [server] = await db.select().from(fhirServers).where(eq(fhirServers.id, launch.serverId));
    if (!server?.enabled) return c.redirect(back({ connect_error: "that server is switched off" }));
    const error = c.req.query("error");
    const code = c.req.query("code");
    if (error || !code) {
      return c.redirect(back({ connect_error: `${server.name} said no (${error ?? "no code"})` }));
    }
    let tokens: Awaited<ReturnType<typeof exchangeCode>>;
    try {
      tokens = await exchangeCode(
        {
          tokenUrl: server.tokenUrl,
          clientId: server.clientId,
          clientSecret: server.clientSecretSealed
            ? unseal(key, server.clientSecretSealed, `server|${server.id}`)
            : null,
        },
        { code, redirectUri: callbackUrl(), codeVerifier: launch.codeVerifier },
        deps.fetch,
      );
    } catch (err) {
      console.error(`SMART code exchange with ${server.id} failed: ${(err as Error).message}`);
      return c.redirect(back({ connect_error: `${server.name} didn't complete the sign-in` }));
    }
    // The patient is pinned here, from the launch, once.
    if (!tokens.patient) {
      return c.redirect(back({ connect_error: `${server.name} didn't say whose record this is` }));
    }
    const bind = `${launch.personId}|${server.id}`;
    const sealed = seal(
      key,
      JSON.stringify({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        scope: tokens.scope,
      }),
      bind,
    );
    const expiresAt = new Date(Date.now() + (tokens.expires_in ?? 300) * 1000);
    await db
      .insert(vault)
      .values({
        personId: launch.personId,
        serverId: server.id,
        patientId: tokens.patient,
        tokensSealed: sealed,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: [vault.personId, vault.serverId],
        set: {
          patientId: tokens.patient,
          tokensSealed: sealed,
          expiresAt,
          connectedAt: new Date(),
        },
      });
    return c.redirect(back({ connected: server.id }));
  });

  app.post("/:id/disconnect", async (c) => {
    await db
      .delete(vault)
      .where(and(eq(vault.personId, c.get("personId")), eq(vault.serverId, c.req.param("id"))));
    return c.json({ ok: true });
  });

  return app;
}
