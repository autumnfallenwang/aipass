import { randomUUID } from "node:crypto";
import { aipassTarget, runChecks } from "@aipass/check";
import {
  agentClients,
  agents,
  CLAUDE_CODE_CLIENT_ID,
  type Db,
  fhirServers,
  grants,
  newId,
  oauthClient,
  persons,
  receipts,
  roles,
  verifyReceiptChain,
} from "@aipass/db";
import { buildDevice, type FhirClient } from "@aipass/fhir";
import {
  AgentStatus,
  agentDeviceId,
  agentUrl,
  GROUPS,
  PatientField,
  Permission,
  RoleRule,
  rulesToPermissions,
} from "@aipass/shared";
import { and, count, desc, eq, inArray, lt, max, type SQL, sql } from "drizzle-orm";
import { Hono } from "hono";
import { SignJWT } from "jose";
import * as z from "zod";
import { adminApprovalRoutes } from "./approvals.ts";
import type { Auth } from "./auth.ts";
import { config, passIssuer } from "./config.ts";
import { adminConnectionRoutes } from "./connections.ts";
import { adminFhirServerRoutes } from "./fhir-servers.ts";
import { activeKey, PASS_ALG } from "./keys.ts";
import { allowClient, disallowClient, syncAgentResource } from "./oauth.ts";

type AdminEnv = { Variables: { adminId: string } };

/** `Sunrise Coach!` → `sunrise-coach`. */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "item"
  );
}

async function uniqueId(base: string, taken: (id: string) => Promise<boolean>): Promise<string> {
  let id = base;
  for (let n = 2; await taken(id); n++) id = `${base}-${n}`;
  return id;
}

const RoleBody = z.strictObject({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional().nullable(),
  rules: z.array(RoleRule).refine((rs) => new Set(rs.map((r) => r.group)).size === rs.length, {
    message: "each group appears once",
  }),
  patientFields: z.array(PatientField).refine((f) => new Set(f).size === f.length),
});

const AgentBody = z.strictObject({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional().nullable(),
  roleId: z.string().min(1),
  /** Where its records live (S6); null for aipass's own FHIR server. */
  fhirServerId: z.string().min(1).nullable().optional(),
  /** Let Claude Code connect as this agent straight away. */
  allowClaudeCode: z.boolean().optional(),
});

const ClientBody = z.strictObject({ clientId: z.string().trim().min(1).max(500) });

const LoginBody = z.strictObject({
  email: z.email(),
  password: z.string().min(10).max(200),
});

const PersonBody = z.strictObject({
  displayName: z.string().trim().min(1).max(120),
  fhirRef: z.string().regex(/^(Patient|Practitioner)\/[A-Za-z0-9\-.]{1,64}$/),
});

const GrantBody = z.strictObject({ permissions: z.array(Permission) });

export function adminRoutes(deps: { db: Db; auth: Auth; fhir: FhirClient; fetch?: typeof fetch }) {
  const { db, auth, fhir } = deps;
  const doFetch = deps.fetch ?? fetch;
  const app = new Hono<AdminEnv>();

  // Every admin route needs a signed-in admin.
  app.use("*", async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: "sign in first" }, 401);
    if ((session.user as { role?: string }).role !== "admin") {
      return c.json({ error: "admins only" }, 403);
    }
    c.set("adminId", session.user.id);
    await next();
  });

  // ---------- agents ----------

  async function serverExists(id: string) {
    const [hit] = await db
      .select({ id: fhirServers.id })
      .from(fhirServers)
      .where(eq(fhirServers.id, id));
    return Boolean(hit);
  }

  async function listAgents() {
    const rows = await db
      .select({ agent: agents, roleName: roles.name })
      .from(agents)
      .leftJoin(roles, eq(agents.roleId, roles.id))
      .orderBy(agents.createdAt);
    const activity = await db
      .select({ agentId: receipts.agentId, last: max(receipts.ts) })
      .from(receipts)
      .where(eq(receipts.mode, "live"))
      .groupBy(receipts.agentId);
    const last = new Map(activity.map((a) => [a.agentId, a.last]));
    return rows.map(({ agent, roleName }) => ({
      ...agent,
      roleName,
      mcpUrl: agentUrl(config.gatewayUrl, agent.id),
      lastActivity: last.get(agent.id) ?? null,
    }));
  }

  app.get("/agents", async (c) => c.json(await listAgents()));

  app.post("/agents", async (c) => {
    const body = AgentBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400);
    const [role] = await db.select().from(roles).where(eq(roles.id, body.data.roleId));
    if (!role) return c.json({ error: "no such role" }, 400);
    if (body.data.fhirServerId && !(await serverExists(body.data.fhirServerId))) {
      return c.json({ error: "no such FHIR server" }, 400);
    }
    const id = await uniqueId(slugify(body.data.name), async (x) => {
      const [hit] = await db.select({ id: agents.id }).from(agents).where(eq(agents.id, x));
      return Boolean(hit);
    });
    const { allowClaudeCode, ...fields } = body.data;
    const [agent] = await db
      .insert(agents)
      .values({
        id,
        name: fields.name,
        description: fields.description ?? null,
        roleId: role.id,
        status: "active",
        fhirDeviceId: agentDeviceId(id),
        createdBy: c.get("adminId"),
      })
      .returning();
    try {
      // The AI exists in the FHIR record as a Device, so audit events can name it.
      await fhir.update(
        buildDevice({ id, name: fields.name, description: fields.description, status: "active" }),
      );
    } catch (err) {
      await db.delete(agents).where(eq(agents.id, id));
      return c.json(
        { error: `couldn't create the agent's FHIR Device: ${(err as Error).message}` },
        502,
      );
    }
    // The agent's gateway URL becomes an OAuth resource AI apps can ask tokens for.
    await syncAgentResource(db, { id, name: fields.name });
    if (allowClaudeCode) await allowClient(db, id, CLAUDE_CODE_CLIENT_ID);
    return c.json({ ...agent, mcpUrl: agentUrl(config.gatewayUrl, id) }, 201);
  });

  app.patch("/agents/:id", async (c) => {
    const body = AgentBody.omit({ allowClaudeCode: true })
      .partial()
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400);
    if (body.data.roleId) {
      const [role] = await db.select().from(roles).where(eq(roles.id, body.data.roleId));
      if (!role) return c.json({ error: "no such role" }, 400);
    }
    if (body.data.fhirServerId && !(await serverExists(body.data.fhirServerId))) {
      return c.json({ error: "no such FHIR server" }, 400);
    }
    const [agent] = await db
      .update(agents)
      .set(body.data)
      .where(eq(agents.id, c.req.param("id")))
      .returning();
    if (!agent) return c.json({ error: "no such agent" }, 404);
    if (body.data.name) await syncAgentResource(db, agent);
    return c.json(agent);
  });

  // ---------- which AI apps may connect as an agent ----------

  app.get("/agents/:id/clients", async (c) => {
    const rows = await db
      .select({ clientId: agentClients.clientId, createdAt: agentClients.createdAt })
      .from(agentClients)
      .where(eq(agentClients.agentId, c.req.param("id")));
    const known = rows.length
      ? await db
          .select({ clientId: oauthClient.clientId, name: oauthClient.name })
          .from(oauthClient)
          .where(
            inArray(
              oauthClient.clientId,
              rows.map((r) => r.clientId),
            ),
          )
      : [];
    return c.json(
      rows.map((r) => {
        const k = known.find((x) => x.clientId === r.clientId);
        return { ...r, name: k?.name ?? null, seen: Boolean(k) };
      }),
    );
  });

  app.post("/agents/:id/clients", async (c) => {
    const body = ClientBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "expected {clientId}" }, 400);
    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, c.req.param("id")));
    if (!agent) return c.json({ error: "no such agent" }, 404);
    await syncAgentResource(db, agent);
    await allowClient(db, agent.id, body.data.clientId);
    return c.json({ agentId: agent.id, clientId: body.data.clientId }, 201);
  });

  app.delete("/agents/:id/clients", async (c) => {
    const clientId = c.req.query("clientId");
    if (!clientId) return c.json({ error: "expected ?clientId=" }, 400);
    await disallowClient(db, c.req.param("id"), clientId);
    return c.body(null, 204);
  });

  // AI apps that registered themselves (DCR) or were discovered from a metadata document (CIMD).
  app.get("/oauth-clients", async (c) => {
    const rows = await db
      .select({
        clientId: oauthClient.clientId,
        name: oauthClient.name,
        clientDiscoveryId: oauthClient.clientDiscoveryId,
        createdAt: oauthClient.createdAt,
      })
      .from(oauthClient)
      .orderBy(desc(oauthClient.createdAt));
    return c.json(
      rows.map((r) => ({ ...r, kind: r.clientDiscoveryId ? "metadata document" : "registered" })),
    );
  });

  for (const [verb, status] of [
    ["stop", "stopped"],
    ["resume", "active"],
  ] as const) {
    app.post(`/agents/:id/${verb}`, async (c) => {
      const [agent] = await db
        .update(agents)
        .set({ status: AgentStatus.parse(status) })
        .where(eq(agents.id, c.req.param("id")))
        .returning();
      if (!agent) return c.json({ error: "no such agent" }, 404);
      // Best effort: the gateway reads status from the database, so Stop works
      // even if this FHIR update fails.
      fhir.update(buildDevice({ ...agent, status })).catch((err: Error) => {
        console.error(`Device status update failed for ${agent.id}: ${err.message}`);
      });
      return c.json(agent);
    });
  }

  // ---------- roles ----------

  app.get("/roles", async (c) => {
    const rows = await db.select().from(roles).orderBy(roles.createdAt);
    const used = await db
      .select({ roleId: agents.roleId, n: count() })
      .from(agents)
      .groupBy(agents.roleId);
    const n = new Map(used.map((u) => [u.roleId, u.n]));
    return c.json(
      rows.map((r) => ({
        ...r,
        permissions: rulesToPermissions(r.rules),
        agentCount: n.get(r.id) ?? 0,
      })),
    );
  });

  app.get("/roles/:id", async (c) => {
    const [role] = await db
      .select()
      .from(roles)
      .where(eq(roles.id, c.req.param("id")));
    if (!role) return c.json({ error: "no such role" }, 404);
    return c.json({ ...role, permissions: rulesToPermissions(role.rules) });
  });

  app.post("/roles", async (c) => {
    const body = RoleBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400);
    const id = await uniqueId(slugify(body.data.name), async (x) => {
      const [hit] = await db.select({ id: roles.id }).from(roles).where(eq(roles.id, x));
      return Boolean(hit);
    });
    const [role] = await db
      .insert(roles)
      .values({ id, ...body.data, description: body.data.description ?? null })
      .returning();
    return c.json(role, 201);
  });

  app.put("/roles/:id", async (c) => {
    const body = RoleBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400);
    const [role] = await db
      .update(roles)
      .set({ ...body.data, description: body.data.description ?? null })
      .where(eq(roles.id, c.req.param("id")))
      .returning();
    if (!role) return c.json({ error: "no such role" }, 404);
    return c.json(role);
  });

  app.delete("/roles/:id", async (c) => {
    const [used] = await db
      .select({ n: count() })
      .from(agents)
      .where(eq(agents.roleId, c.req.param("id")));
    if ((used?.n ?? 0) > 0) return c.json({ error: "agents still use this role" }, 409);
    const gone = await db
      .delete(roles)
      .where(eq(roles.id, c.req.param("id")))
      .returning();
    return gone.length ? c.body(null, 204) : c.json({ error: "no such role" }, 404);
  });

  // ---------- people and their grants ----------

  app.get("/persons", async (c) => {
    const ps = await db.select().from(persons).orderBy(persons.displayName);
    const gs = await db
      .select({ grant: grants, agentName: agents.name })
      .from(grants)
      .innerJoin(agents, eq(grants.agentId, agents.id));
    return c.json(
      ps.map((p) => ({
        ...p,
        grants: gs
          .filter((g) => g.grant.personId === p.id)
          .map((g) => ({ ...g.grant, agentName: g.agentName })),
      })),
    );
  });

  app.post("/persons", async (c) => {
    const body = PersonBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400);
    const id = await uniqueId(slugify(body.data.displayName), async (x) => {
      const [hit] = await db.select({ id: persons.id }).from(persons).where(eq(persons.id, x));
      return Boolean(hit);
    });
    const [person] = await db
      .insert(persons)
      .values({ id, ...body.data })
      .returning();
    return c.json(person, 201);
  });

  // Gives a test person a login, so they can consent and see "My AIs".
  app.post("/persons/:id/login", async (c) => {
    const body = LoginBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "expected {email, password (10+ characters)}" }, 400);
    const [person] = await db
      .select()
      .from(persons)
      .where(eq(persons.id, c.req.param("id")));
    if (!person) return c.json({ error: "no such person" }, 404);
    if (person.userId) return c.json({ error: "this person already has a login" }, 409);
    try {
      const { user } = await auth.api.signUpEmail({
        body: { name: person.displayName, email: body.data.email, password: body.data.password },
      });
      await db.update(persons).set({ userId: user.id }).where(eq(persons.id, person.id));
      return c.json({ personId: person.id, email: body.data.email }, 201);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.put("/persons/:id/grants/:agentId", async (c) => {
    const body = GrantBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400);
    const personId = c.req.param("id");
    const agentId = c.req.param("agentId");
    const [grant] = await db
      .insert(grants)
      .values({
        id: newId("grt"),
        personId,
        agentId,
        permissions: body.data.permissions,
        status: "active",
      })
      .onConflictDoUpdate({
        target: [grants.personId, grants.agentId],
        set: { permissions: body.data.permissions, status: "active", revokedAt: null },
      })
      .returning()
      .catch(() => []);
    if (!grant) return c.json({ error: "no such person or agent" }, 404);
    return c.json(grant);
  });

  for (const verb of ["revoke", "restore"] as const) {
    app.post(`/persons/:id/grants/:agentId/${verb}`, async (c) => {
      const [grant] = await db
        .update(grants)
        .set(
          verb === "revoke"
            ? { status: "revoked", revokedAt: new Date() }
            : { status: "active", revokedAt: null },
        )
        .where(
          and(eq(grants.personId, c.req.param("id")), eq(grants.agentId, c.req.param("agentId"))),
        )
        .returning();
      if (!grant) return c.json({ error: "no such grant" }, 404);
      return c.json(grant);
    });
  }

  // ---------- activity ----------

  app.get("/receipts", async (c) => {
    const q = c.req.query();
    const where: SQL[] = [];
    if (q.agent) where.push(eq(receipts.agentId, q.agent));
    if (q.person) where.push(eq(receipts.personId, q.person));
    if (q.decision === "allow" || q.decision === "refuse")
      where.push(eq(receipts.decision, q.decision));
    if (q.mode !== "all") where.push(eq(receipts.mode, q.mode === "preview" ? "preview" : "live"));
    if (q.before) where.push(lt(receipts.seq, Number(q.before)));
    const limit = Math.min(Math.max(Number(q.limit ?? 50) || 50, 1), 200);
    const rows = await db
      .select()
      .from(receipts)
      .where(where.length ? and(...where) : sql`true`)
      .orderBy(desc(receipts.seq))
      .limit(limit);
    return c.json({
      items: rows.map((r) => ({
        ...r,
        auditEventUrl: r.auditEventId ? `${config.fhirBaseUrl}/AuditEvent/${r.auditEventId}` : null,
      })),
      nextBefore: rows.length === limit ? rows[rows.length - 1]?.seq : null,
    });
  });

  app.get("/receipts/verify", async (c) => {
    const broken = await verifyReceiptChain(db);
    return c.json({ intact: broken === null, brokenAt: broken });
  });

  app.get("/overview", async (c) => {
    const [a] = await db
      .select({
        active: sql<number>`count(*) filter (where ${agents.status} = 'active')`.mapWith(Number),
        stopped: sql<number>`count(*) filter (where ${agents.status} = 'stopped')`.mapWith(Number),
      })
      .from(agents);
    const [r] = await db
      .select({
        allowed: sql<number>`count(*) filter (where ${receipts.decision} = 'allow')`.mapWith(
          Number,
        ),
        refused: sql<number>`count(*) filter (where ${receipts.decision} = 'refuse')`.mapWith(
          Number,
        ),
      })
      .from(receipts)
      .where(and(eq(receipts.mode, "live"), sql`${receipts.ts} > now() - interval '24 hours'`));
    const [p] = await db.select({ n: count() }).from(persons);
    return c.json({ agents: a, last24h: r, persons: p?.n ?? 0, groups: GROUPS });
  });

  app.route("/", adminApprovalRoutes({ db }));
  app.route("/", adminConnectionRoutes({ db, auth, fetch: deps.fetch }));
  app.route("/", adminFhirServerRoutes({ db, fetch: deps.fetch }));

  // ---------- health check (S4) ----------

  let checking = false;
  app.post("/check", async (c) => {
    if (checking) return c.json({ error: "a health check is already running" }, 409);
    checking = true;
    try {
      await activeKey(db); // the probes sign passes with the api's own key
      const report = await runChecks(
        aipassTarget({
          db,
          gatewayUrl: config.gatewayUrl,
          passIssuer: passIssuer(),
          fhirBaseUrl: config.fhirBaseUrl,
          // the approval endpoints live on this api; no need to go through the web app
          publicUrl: config.apiUrl,
          version: process.env.npm_package_version ?? "dev",
        }),
        { command: "pnpm check" },
      );
      return c.json(report);
    } finally {
      checking = false;
    }
  });

  // ---------- preview as this role ----------

  app.post("/preview", async (c) => {
    const body = z
      .union([
        z.strictObject({ roleId: z.string().min(1), personId: z.string().min(1) }),
        z.strictObject({ agentId: z.string().min(1), personId: z.string().min(1) }),
      ])
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "expected {roleId or agentId, personId}" }, 400);
    const { kid, key } = await activeKey(db);
    const token = await new SignJWT({ preview: body.data })
      .setProtectedHeader({ alg: PASS_ALG, kid })
      .setIssuer(passIssuer())
      .setSubject(c.get("adminId"))
      .setAudience(`${config.gatewayUrl}/internal/preview`)
      .setIssuedAt()
      .setExpirationTime("60s")
      .setJti(randomUUID())
      .sign(key);
    const res = await doFetch(`${config.gatewayUrl}/internal/preview`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    return c.json(await res.json(), res.status as 200);
  });

  return app;
}
