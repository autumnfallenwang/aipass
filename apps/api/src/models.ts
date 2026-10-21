/**
 * Model connections (S8, D16): any OpenAI-compatible chat endpoint. The admin
 * adds them, says where each sends what it's given, and picks one per agent.
 * Keys go in sealed and never come out.
 */
import { listModels, type ModelEndpoint, probeEndpoint } from "@aipass/chat";
import {
  agents,
  type Db,
  type ModelDataLocation,
  modelConnections,
  roles,
  seal,
  unseal,
  vaultKey,
  vaultKeys,
} from "@aipass/db";
import { eq, or } from "drizzle-orm";
import { Hono } from "hono";
import * as z from "zod";

type Connection = typeof modelConnections.$inferSelect;

const bindOf = (id: string) => `model|${id}`;

const BaseUrl = z
  .url({ protocol: /^https?$/ })
  .max(500)
  .transform((u) => u.replace(/\/+$/, ""));

const ConnectionBody = z.strictObject({
  name: z.string().trim().min(1).max(80),
  baseUrl: BaseUrl,
  apiKey: z.string().min(1).max(4000).optional(),
  dataLocation: z.enum(["network", "cloud"]),
});

const ConnectionPatch = z.strictObject({
  name: z.string().trim().min(1).max(80).optional(),
  baseUrl: BaseUrl.optional(),
  /** A new key, or null to remove it. */
  apiKey: z.string().min(1).max(4000).nullable().optional(),
  dataLocation: z.enum(["network", "cloud"]).optional(),
  enabled: z.boolean().optional(),
});

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "model"
  );
}

/** A connection as the admin sees it: never the key. */
export function shown(c: Connection) {
  const { apiKeySealed, ...rest } = c;
  return { ...rest, hasKey: Boolean(apiKeySealed) };
}

export function endpointOf(c: Connection): ModelEndpoint {
  return {
    baseUrl: c.baseUrl,
    apiKey: c.apiKeySealed ? unseal(vaultKeys(), c.apiKeySealed, bindOf(c.id)) : null,
  };
}

export const DATA_WORDS: Record<ModelDataLocation, string> = {
  network: "stays on your network",
  cloud: "goes to a cloud provider",
};

/**
 * The models an agent's chat may use right now: its model and fallback, if
 * their connections are on, and only those that keep data on the network when
 * the agent's role says so. `problem` says why there's nothing to use.
 */
export async function modelsForAgent(db: Db, agentId: string) {
  const [row] = await db
    .select({ agent: agents, networkOnly: roles.networkModelsOnly, roleName: roles.name })
    .from(agents)
    .innerJoin(roles, eq(agents.roleId, roles.id))
    .where(eq(agents.id, agentId));
  if (!row) return { primary: null, fallback: null, problem: "no such agent" };
  const { agent, networkOnly, roleName } = row;
  const ids = [agent.modelConnectionId, agent.fallbackConnectionId].filter((x): x is string =>
    Boolean(x),
  );
  const conns = ids.length
    ? await db
        .select()
        .from(modelConnections)
        .where(or(...ids.map((id) => eq(modelConnections.id, id))))
    : [];
  const pick = (id: string | null, model: string | null) => {
    const c = conns.find((x) => x.id === id);
    if (!c || !model || !c.enabled) return null;
    return { connection: c, model };
  };
  const primary = pick(agent.modelConnectionId, agent.model);
  const fallback = pick(agent.fallbackConnectionId, agent.fallbackModel);
  const allowed = (m: typeof primary) =>
    m && (!networkOnly || m.connection.dataLocation === "network");
  if (!primary && !fallback) {
    return { primary: null, fallback: null, problem: "no model is set up for this AI yet" };
  }
  const p = allowed(primary) ? primary : null;
  const f = allowed(fallback) ? fallback : null;
  if (!p && !f) {
    return {
      primary: null,
      fallback: null,
      problem: `the ${roleName} role only allows models that keep data on the clinic's network, and this AI's model doesn't`,
    };
  }
  return { primary: p ?? f, fallback: p ? f : null, problem: null };
}

export function adminModelRoutes(deps: { db: Db; fetch?: typeof fetch }) {
  const { db } = deps;
  const key = vaultKey();
  const app = new Hono();

  async function find(id: string) {
    const [c] = await db.select().from(modelConnections).where(eq(modelConnections.id, id));
    return c;
  }

  app.get("/model-connections", async (c) => {
    const rows = await db.select().from(modelConnections).orderBy(modelConnections.createdAt);
    const used = await db
      .select({
        id: agents.id,
        name: agents.name,
        primary: agents.modelConnectionId,
        fallback: agents.fallbackConnectionId,
      })
      .from(agents);
    return c.json(
      rows.map((r) => ({
        ...shown(r),
        usedBy: used.filter((a) => a.primary === r.id || a.fallback === r.id).map((a) => a.name),
      })),
    );
  });

  app.post("/model-connections", async (c) => {
    const body = ConnectionBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400);
    let id = slugify(body.data.name);
    for (let n = 2; await find(id); n++) id = `${slugify(body.data.name)}-${n}`;
    const [row] = await db
      .insert(modelConnections)
      .values({
        id,
        name: body.data.name,
        baseUrl: body.data.baseUrl,
        apiKeySealed: body.data.apiKey ? seal(key, body.data.apiKey, bindOf(id)) : null,
        dataLocation: body.data.dataLocation,
      })
      .returning();
    return c.json(row ? shown(row) : null, 201);
  });

  app.patch("/model-connections/:id", async (c) => {
    const body = ConnectionPatch.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400);
    const id = c.req.param("id");
    const { apiKey, ...rest } = body.data;
    const [row] = await db
      .update(modelConnections)
      .set({
        ...rest,
        ...(apiKey === undefined
          ? {}
          : { apiKeySealed: apiKey === null ? null : seal(key, apiKey, bindOf(id)) }),
      })
      .where(eq(modelConnections.id, id))
      .returning();
    return row ? c.json(shown(row)) : c.json({ error: "no such model connection" }, 404);
  });

  app.delete("/model-connections/:id", async (c) => {
    // Agents that used it are left with no model (the foreign key sets null).
    const [row] = await db
      .delete(modelConnections)
      .where(eq(modelConnections.id, c.req.param("id")))
      .returning({ id: modelConnections.id });
    return row ? c.body(null, 204) : c.json({ error: "no such model connection" }, 404);
  });

  app.get("/model-connections/:id/models", async (c) => {
    const conn = await find(c.req.param("id"));
    if (!conn) return c.json({ error: "no such model connection" }, 404);
    try {
      return c.json({ models: await listModels(endpointOf(conn), { fetch: deps.fetch }) });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
  });

  // The Test button: does it answer, which models, and does the chosen one call tools?
  app.post("/model-connections/:id/test", async (c) => {
    const conn = await find(c.req.param("id"));
    if (!conn) return c.json({ error: "no such model connection" }, 404);
    const body = z
      .strictObject({ model: z.string().min(1).max(200).optional() })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "expected {model?}" }, 400);
    try {
      return c.json(
        await probeEndpoint(endpointOf(conn), body.data.model ?? null, { fetch: deps.fetch }),
      );
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
  });

  return app;
}
