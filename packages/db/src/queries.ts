import { rulesToPermissions } from "@aipass/shared";
import { and, eq, or } from "drizzle-orm";
import type { Db } from "./index.ts";
import { agentClients, agents, grants, patientContexts, persons, roles } from "./schema.ts";

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
  const [open] =
    person && agentRow
      ? await db
          .select({ patientRef: patientContexts.patientRef })
          .from(patientContexts)
          .where(and(eq(patientContexts.personId, person.id), eq(patientContexts.agentId, agentId)))
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
    /** The patient a staff member has open with this agent (S10), as `Patient/<id>`. */
    openPatient: open?.patientRef ?? null,
  };
}

/**
 * The `patient` a pass names (S10): a patient's own record, or the patient a
 * staff member has open with this agent. None when a staff member has nobody
 * open; the gateway then refuses "no patient selected".
 */
export async function passPatientOf(
  db: Db,
  person: { id: string; fhirRef: string },
  agentId: string,
): Promise<string | undefined> {
  const own = person.fhirRef.match(/^Patient\/(.+)$/)?.[1];
  if (own || !person.fhirRef.startsWith("Practitioner/")) return own;
  const [open] = await db
    .select({ patientRef: patientContexts.patientRef })
    .from(patientContexts)
    .where(and(eq(patientContexts.personId, person.id), eq(patientContexts.agentId, agentId)));
  return open?.patientRef.match(/^Patient\/(.+)$/)?.[1];
}

export type CallContext = Awaited<ReturnType<typeof loadCallContext>>;
