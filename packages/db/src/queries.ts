import { rulesToPermissions } from "@aipass/shared";
import { and, eq, or } from "drizzle-orm";
import type { Db } from "./index.ts";
import { agentClients, agents, grants, persons, roles } from "./schema.ts";

/**
 * Everything the gateway needs to decide one call, read fresh from the
 * database on every call (rule 5: live checks, so "Stop" works on the next
 * request).
 */
export async function loadCallContext(db: Db, agentId: string, personKey: string) {
  const [agentRow] = await db
    .select({ agent: agents, role: roles })
    .from(agents)
    .leftJoin(roles, eq(agents.roleId, roles.id))
    .where(eq(agents.id, agentId))
    .limit(1);
  // The pass's `sub` is the aipass person id (dev passes, token exchange) or
  // the person's login id (OAuth, S3). Accept either.
  const [person] = await db
    .select()
    .from(persons)
    .where(or(eq(persons.id, personKey), eq(persons.userId, personKey)))
    .limit(1);
  const [grant] =
    person && agentRow
      ? await db
          .select()
          .from(grants)
          .where(and(eq(grants.personId, person.id), eq(grants.agentId, agentId)))
          .limit(1)
      : [];
  const clients = agentRow
    ? await db
        .select({ clientId: agentClients.clientId })
        .from(agentClients)
        .where(eq(agentClients.agentId, agentId))
    : [];
  const role = agentRow?.role ?? null;
  return {
    /** OAuth clients the admin approved to connect as this agent. */
    allowedClients: clients.map((c) => c.clientId),
    agent: agentRow?.agent ?? null,
    role: role ? { ...role, permissions: rulesToPermissions(role.rules) } : null,
    person: person ?? null,
    grant: grant ?? null,
  };
}

export type CallContext = Awaited<ReturnType<typeof loadCallContext>>;
