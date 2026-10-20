import type { PatientField, Permission, RoleRule } from "@aipass/shared";
import { agentDeviceId, rulesToPermissions } from "@aipass/shared";
import { inArray } from "drizzle-orm";
import { newId } from "./ids.ts";
import type { Db } from "./index.ts";
import { agentClients, agents, grants, persons, roles } from "./schema.ts";

const rule = (
  group: RoleRule["group"],
  read: boolean,
  propose = false,
  write = false,
): RoleRule => ({
  group,
  read,
  propose,
  write,
});

/** Claude Code's Client ID Metadata Document URL: the same for every install. */
export const CLAUDE_CODE_CLIENT_ID = "https://claude.ai/oauth/claude-code-client-metadata";

/** The Maria demo, used by every stage. */
export const DEMO = {
  roles: [
    {
      id: "diabetes-coach",
      name: "Diabetes Coach",
      description:
        "Helps a patient manage type 2 diabetes: labs, vitals, medications, conditions, visit notes, and name and age.",
      rules: [
        rule("labs", true, true),
        rule("vitals", true),
        rule("medications", true),
        rule("conditions", true),
        rule("notes", true),
        rule("demographics", true),
      ],
      patientFields: ["name", "birthDate", "gender"] as PatientField[],
    },
    {
      id: "scheduling-assistant",
      name: "Scheduling Assistant",
      description: "Books and reminds about appointments. Sees only name, phone and appointments.",
      rules: [rule("appointments", true), rule("demographics", true)],
      patientFields: ["name", "phone"] as PatientField[],
    },
  ],
  agents: [
    {
      id: "diabetes-coach",
      name: "Diabetes Coach",
      description: "An AI coach for people with type 2 diabetes.",
      roleId: "diabetes-coach",
    },
    {
      id: "scheduling-assistant",
      name: "Scheduling Assistant",
      description: "An AI that books and reminds about appointments.",
      roleId: "scheduling-assistant",
    },
  ],
  persons: [
    { id: "maria", displayName: "Maria Santos", fhirRef: "Patient/maria" },
    { id: "john", displayName: "John Carter", fhirRef: "Patient/john" },
  ],
};

export function demoGrants(): { personId: string; agentId: string; permissions: Permission[] }[] {
  const coach = DEMO.roles[0];
  const scheduling = DEMO.roles[1];
  if (!coach || !scheduling) throw new Error("demo roles missing");
  return [
    { personId: "maria", agentId: "diabetes-coach", permissions: rulesToPermissions(coach.rules) },
    {
      personId: "maria",
      agentId: "scheduling-assistant",
      permissions: rulesToPermissions(scheduling.rules),
    },
    { personId: "john", agentId: "diabetes-coach", permissions: ["labs:read"] },
  ];
}

/**
 * Seeds the demo. Without `reset` it only adds what's missing, so changes an
 * admin made are kept. With `reset` the demo rows go back to their starting state.
 */
export async function seedDemo(db: Db, opts: { reset?: boolean } = {}): Promise<void> {
  if (opts.reset) {
    await db.delete(grants).where(
      inArray(
        grants.agentId,
        DEMO.agents.map((a) => a.id),
      ),
    );
    await db.delete(agents).where(
      inArray(
        agents.id,
        DEMO.agents.map((a) => a.id),
      ),
    );
    await db.delete(roles).where(
      inArray(
        roles.id,
        DEMO.roles.map((r) => r.id),
      ),
    );
    await db.delete(persons).where(
      inArray(
        persons.id,
        DEMO.persons.map((p) => p.id),
      ),
    );
  }
  await db.insert(roles).values(DEMO.roles).onConflictDoNothing();
  await db
    .insert(agents)
    .values(
      DEMO.agents.map((a) => ({
        ...a,
        status: "active" as const,
        fhirDeviceId: agentDeviceId(a.id),
      })),
    )
    .onConflictDoNothing();
  await db.insert(persons).values(DEMO.persons).onConflictDoNothing();
  // The demo lets Claude Code connect as either agent.
  await db
    .insert(agentClients)
    .values(DEMO.agents.map((a) => ({ agentId: a.id, clientId: CLAUDE_CODE_CLIENT_ID })))
    .onConflictDoNothing();
  await db
    .insert(grants)
    .values(demoGrants().map((g) => ({ ...g, id: newId("grt"), status: "active" as const })))
    .onConflictDoNothing();
}
