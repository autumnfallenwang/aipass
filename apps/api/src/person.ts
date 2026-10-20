import {
  agentClients,
  agents,
  type Db,
  grants,
  newId,
  oauthClient,
  persons,
  receipts,
  roles,
} from "@aipass/db";
import { Permission, rulesToPermissions } from "@aipass/shared";
import { and, desc, eq, max } from "drizzle-orm";
import { Hono } from "hono";
import * as z from "zod";
import type { Auth } from "./auth.ts";
import { config } from "./config.ts";
import { agentIdOfResource, revokeRefreshTokens } from "./oauth.ts";

type PersonEnv = { Variables: { userId: string } };

/**
 * The person's side (S3): the consent page an AI's OAuth login lands on, and
 * "My AIs", where a person sees and revokes what each AI may do for them.
 */
export function personRoutes(deps: { db: Db; auth: Auth }) {
  const { db, auth } = deps;
  const app = new Hono<PersonEnv>();

  app.use("*", async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: "sign in first" }, 401);
    c.set("userId", session.user.id);
    await next();
  });

  async function personOf(userId: string) {
    const [p] = await db.select().from(persons).where(eq(persons.userId, userId));
    return p ?? null;
  }

  async function agentWithCeiling(agentId: string) {
    const [row] = await db
      .select({ agent: agents, role: roles })
      .from(agents)
      .innerJoin(roles, eq(agents.roleId, roles.id))
      .where(eq(agents.id, agentId));
    return row
      ? { ...row.agent, roleName: row.role.name, ceiling: rulesToPermissions(row.role.rules) }
      : null;
  }

  // What the consent page shows: which AI, for whom, within what ceiling.
  app.get("/consent/context", async (c) => {
    const clientId = c.req.query("client_id") ?? "";
    const agentId = agentIdOfResource(c.req.query("resource") ?? "");
    if (!agentId)
      return c.json({ error: "this sign-in doesn't name one of the clinic's agents" }, 400);
    const agent = await agentWithCeiling(agentId);
    if (!agent) return c.json({ error: "no such agent" }, 404);
    const person = await personOf(c.get("userId"));
    const [approved] = await db
      .select()
      .from(agentClients)
      .where(and(eq(agentClients.agentId, agentId), eq(agentClients.clientId, clientId)));
    const [client] = await db
      .select({ name: oauthClient.name })
      .from(oauthClient)
      .where(eq(oauthClient.clientId, clientId));
    const [grant] = person
      ? await db
          .select()
          .from(grants)
          .where(and(eq(grants.personId, person.id), eq(grants.agentId, agentId)))
      : [];
    return c.json({
      orgName: config.orgName,
      agent: {
        id: agent.id,
        name: agent.name,
        description: agent.description,
        status: agent.status,
        roleName: agent.roleName,
      },
      client: { id: clientId, name: client?.name ?? clientId, approved: Boolean(approved) },
      person: person ? { displayName: person.displayName } : null,
      ceiling: agent.ceiling,
      granted: grant?.status === "active" ? grant.permissions : null,
    });
  });

  // The person's "yes", saved as their grant before the OAuth consent completes.
  app.post("/consent/grant", async (c) => {
    const body = z
      .strictObject({
        agentId: z.string(),
        clientId: z.string(),
        permissions: z.array(Permission).min(1),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "choose at least one thing this AI may do" }, 400);
    const person = await personOf(c.get("userId"));
    if (!person) return c.json({ error: "your account isn't linked to a patient record yet" }, 403);
    const agent = await agentWithCeiling(body.data.agentId);
    if (agent?.status !== "active") {
      return c.json({ error: "this agent isn't available" }, 403);
    }
    const [approved] = await db
      .select()
      .from(agentClients)
      .where(
        and(eq(agentClients.agentId, agent.id), eq(agentClients.clientId, body.data.clientId)),
      );
    if (!approved) return c.json({ error: `this app isn't approved to act as ${agent.name}` }, 403);
    // A person can agree to less than the clinic allows, never more.
    const outside = body.data.permissions.filter((p) => !agent.ceiling.includes(p));
    if (outside.length)
      return c.json({ error: `not allowed by the clinic: ${outside.join(", ")}` }, 400);
    const [grant] = await db
      .insert(grants)
      .values({
        id: newId("grt"),
        personId: person.id,
        agentId: agent.id,
        permissions: body.data.permissions,
        status: "active",
      })
      .onConflictDoUpdate({
        target: [grants.personId, grants.agentId],
        set: {
          permissions: body.data.permissions,
          status: "active",
          revokedAt: null,
          grantedAt: new Date(),
        },
      })
      .returning();
    return c.json(grant);
  });

  // "My AIs": every AI that may act for me, what it may do, what it did lately.
  app.get("/ais", async (c) => {
    const person = await personOf(c.get("userId"));
    if (!person) return c.json({ person: null, ais: [] });
    const rows = await db
      .select({ grant: grants, agent: agents, role: roles })
      .from(grants)
      .innerJoin(agents, eq(grants.agentId, agents.id))
      .innerJoin(roles, eq(agents.roleId, roles.id))
      .where(eq(grants.personId, person.id));
    const ais = await Promise.all(
      rows.map(async ({ grant, agent, role }) => {
        const ceiling = rulesToPermissions(role.rules);
        const recent = await db
          .select({ ts: receipts.ts, decision: receipts.decision, sentence: receipts.sentence })
          .from(receipts)
          .where(
            and(
              eq(receipts.personId, person.id),
              eq(receipts.agentId, agent.id),
              eq(receipts.mode, "live"),
            ),
          )
          .orderBy(desc(receipts.seq))
          .limit(5);
        const [last] = await db
          .select({ last: max(receipts.ts) })
          .from(receipts)
          .where(
            and(
              eq(receipts.personId, person.id),
              eq(receipts.agentId, agent.id),
              eq(receipts.mode, "live"),
            ),
          );
        return {
          agentId: agent.id,
          name: agent.name,
          description: agent.description,
          agentStatus: agent.status,
          grantStatus: grant.status,
          ceiling,
          permissions: grant.permissions,
          effective:
            grant.status === "active" ? ceiling.filter((p) => grant.permissions.includes(p)) : [],
          grantedAt: grant.grantedAt,
          revokedAt: grant.revokedAt,
          lastActivity: last?.last ?? null,
          recent,
        };
      }),
    );
    return c.json({ person: { displayName: person.displayName }, ais });
  });

  app.put("/ais/:agentId", async (c) => {
    const body = z
      .strictObject({ permissions: z.array(Permission) })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "expected {permissions}" }, 400);
    const person = await personOf(c.get("userId"));
    const agent = await agentWithCeiling(c.req.param("agentId"));
    if (!person || !agent) return c.json({ error: "not found" }, 404);
    const outside = body.data.permissions.filter((p) => !agent.ceiling.includes(p));
    if (outside.length)
      return c.json({ error: `not allowed by the clinic: ${outside.join(", ")}` }, 400);
    const [grant] = await db
      .update(grants)
      .set({ permissions: body.data.permissions })
      .where(
        and(
          eq(grants.personId, person.id),
          eq(grants.agentId, agent.id),
          eq(grants.status, "active"),
        ),
      )
      .returning();
    if (!grant) return c.json({ error: "no active permission to change" }, 404);
    return c.json(grant);
  });

  // Revoke: the AI's next call is refused, and its refresh tokens stop working.
  app.post("/ais/:agentId/revoke", async (c) => {
    const person = await personOf(c.get("userId"));
    if (!person) return c.json({ error: "not found" }, 404);
    const agentId = c.req.param("agentId");
    const [grant] = await db
      .update(grants)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(and(eq(grants.personId, person.id), eq(grants.agentId, agentId)))
      .returning();
    if (!grant) return c.json({ error: "not found" }, 404);
    const refreshTokensRevoked = await revokeRefreshTokens(db, c.get("userId"), agentId);
    return c.json({ ...grant, refreshTokensRevoked });
  });

  return app;
}
