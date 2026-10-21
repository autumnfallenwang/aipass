import { randomUUID } from "node:crypto";
import { aipassTarget, runChecks } from "@aipass/check";
import {
  agentClients,
  agents,
  CHAT_CLIENT_ID,
  CLAUDE_CODE_CLIENT_ID,
  type Db,
  fhirServers,
  modelConnections,
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
import { adminModelRoutes } from "./models.ts";
import { allowClient, disallowClient, syncAgentResource } from "./oauth.ts";
import { adminPeopleRoutes } from "./people.ts";

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
  /** Its agents may only use models that keep data on the network (S8). */
  networkModelsOnly: z.boolean().optional(),
});

const ModelId = z.string().trim().min(1).max(200);

const AgentBody = z.strictObject({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional().nullable(),
  roleId: z.string().min(1),
  /** Where its records live (S6); null for aipass's own FHIR server. */
  fhirServerId: z.string().min(1).nullable().optional(),
  /** Let Claude Code connect as this agent straight away. */
  allowClaudeCode: z.boolean().optional(),
  /** Let the built-in chat connect as this agent straight away (S8). */
  allowChat: z.boolean().optional(),
  /** The model the built-in chat uses for it, and a fallback (S8). */
  modelConnectionId: z.string().min(1).nullable().optional(),
  model: ModelId.nullable().optional(),
  fallbackConnectionId: z.string().min(1).nullable().optional(),
  fallbackModel: ModelId.nullable().optional(),
});

const ClientBody = z.strictObject({ clientId: z.string().trim().min(1).max(500) });

export function adminRoutes(deps: {
  db: Db;
  auth: Auth;
  fhir: FhirClient;
  fetch?: typeof fetch;
  /** How the api reaches model endpoints (tests pass a fake). */
  modelFetch?: typeof fetch;
  /** Re-reads aipass's registered FHIR server now (after an edit). */
  onFhirServerChanged?: () => Promise<void>;
}) {
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

  /** aipass's own server is every agent's default, stored as no server (null). */
  async function asServerChoice(id: string | null | undefined) {
    if (!id) return id;
    const [s] = await db
      .select({ kind: fhirServers.kind })
      .from(fhirServers)
      .where(eq(fhirServers.id, id));
    return s?.kind === "aipass" ? null : id;
  }

  /**
   * An agent's model settings make sense: each connection exists and has a
   * model chosen, and a role that keeps data on the network gets only models
   * that do (S8). The chat checks this again on every message.
   */
  async function checkModels(a: {
    roleId: string;
    modelConnectionId?: string | null;
    model?: string | null;
    fallbackConnectionId?: string | null;
    fallbackModel?: string | null;
  }): Promise<string | null> {
    const [role] = await db.select().from(roles).where(eq(roles.id, a.roleId));
    for (const [connId, model, what] of [
      [a.modelConnectionId, a.model, "model"],
      [a.fallbackConnectionId, a.fallbackModel, "fallback model"],
    ] as const) {
      if (!connId) continue;
      const [conn] = await db
        .select()
        .from(modelConnections)
        .where(eq(modelConnections.id, connId));
      if (!conn) return `no such model connection: ${connId}`;
      if (!model) return `choose which ${what} to use from ${conn.name}`;
      if (role?.networkModelsOnly && conn.dataLocation !== "network") {
        return `the ${role.name} role only allows models that keep data on the clinic's network, and ${conn.name} sends it to a cloud provider`;
      }
    }
    return null;
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
    const { allowClaudeCode, allowChat, ...fields } = body.data;
    const modelProblem = await checkModels({ ...fields, roleId: role.id });
    if (modelProblem) return c.json({ error: modelProblem }, 400);
    const [agent] = await db
      .insert(agents)
      .values({
        id,
        name: fields.name,
        description: fields.description ?? null,
        roleId: role.id,
        status: "active",
        fhirDeviceId: agentDeviceId(id),
        modelConnectionId: fields.modelConnectionId ?? null,
        model: fields.model ?? null,
        fallbackConnectionId: fields.fallbackConnectionId ?? null,
        fallbackModel: fields.fallbackModel ?? null,
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
    if (allowChat) await allowClient(db, id, CHAT_CLIENT_ID);
    return c.json({ ...agent, mcpUrl: agentUrl(config.gatewayUrl, id) }, 201);
  });

  app.patch("/agents/:id", async (c) => {
    const body = AgentBody.omit({ allowClaudeCode: true, allowChat: true })
      .partial()
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400);
    if (body.data.roleId) {
      const [role] = await db.select().from(roles).where(eq(roles.id, body.data.roleId));
      if (!role) return c.json({ error: "no such role" }, 400);
    }
    const [current] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, c.req.param("id")));
    if (!current) return c.json({ error: "no such agent" }, 404);
    const modelProblem = await checkModels({ ...current, ...body.data });
    if (modelProblem) return c.json({ error: modelProblem }, 400);
    if (body.data.fhirServerId !== undefined) {
      body.data.fhirServerId = await asServerChoice(body.data.fhirServerId);
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

  // ---------- people (S9): see people.ts ----------

  app.route("/", adminPeopleRoutes({ db, auth, fhir }));

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
      .select({ receipt: receipts, clientName: oauthClient.name })
      .from(receipts)
      .leftJoin(oauthClient, eq(receipts.clientId, oauthClient.clientId))
      .where(where.length ? and(...where) : sql`true`)
      .orderBy(desc(receipts.seq))
      .limit(limit);
    return c.json({
      items: rows.map(({ receipt: r, clientName }) => ({
        ...r,
        clientName: r.clientId ? (clientName ?? r.clientId) : null,
        auditEventUrl: r.auditEventId ? `${fhir.baseUrl}/AuditEvent/${r.auditEventId}` : null,
      })),
      nextBefore: rows.length === limit ? rows[rows.length - 1]?.receipt.seq : null,
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
  app.route(
    "/",
    adminFhirServerRoutes({
      db,
      fetch: deps.fetch,
      onAipassServerChanged: deps.onFhirServerChanged,
    }),
  );
  app.route("/", adminModelRoutes({ db, fetch: deps.modelFetch }));

  // ---------- health check (S4) ----------

  let checking = false;
  const viaInternalGateway: typeof fetch | undefined =
    config.gatewayInternalUrl === config.gatewayUrl
      ? undefined
      : (input, init) => {
          const u = String(input instanceof Request ? input.url : input);
          return fetch(
            u.startsWith(config.gatewayUrl)
              ? config.gatewayInternalUrl + u.slice(config.gatewayUrl.length)
              : input,
            init,
          );
        };

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
          // aipass's own FHIR server as registered (D18), where the audit log is
          fhirBaseUrl: fhir.baseUrl,
          fhirHeaders: fhir.credentialHeaders(),
          // the approval endpoints live on this api; no need to go through the web app
          publicUrl: config.apiUrl,
          // passes still name the public gateway URL; the calls may go another way
          fetch: viaInternalGateway,
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
    // The audience names the public gateway; the call may take the internal route.
    const res = await doFetch(`${config.gatewayInternalUrl}/internal/preview`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    return c.json(await res.json(), res.status as 200);
  });

  return app;
}
