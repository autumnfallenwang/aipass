import { randomUUID } from "node:crypto";
import { agents, type Db, grants, newId, passKeys, persons, roles } from "@aipass/db";
import {
  ACTIONS,
  agentDeviceId,
  agentUrl,
  GROUPS,
  type Permission,
  permission,
} from "@aipass/shared";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { type CryptoKey, generateKeyPair, importJWK, type JWK, SignJWT } from "jose";
import { callTool } from "../mcp.ts";
import type { AuditRecord, Credential, CredentialRequest, Outcome, Target } from "../types.ts";

export type AipassTargetOptions = {
  db: Db;
  gatewayUrl: string;
  /** The issuer of passes the api signs itself (its API_URL). */
  passIssuer: string;
  fhirBaseUrl: string;
  version?: string;
  /** How to reach the gateway (in-process tests pass the app's fetch). */
  fetch?: typeof fetch;
  /** Which synthetic person the probes act for. Must have a `Patient/…` record with the fixtures. */
  person?: string;
};

const ALL_READS: Permission[] = GROUPS.map((g) => permission(g, "read"));
const EVERYTHING: Permission[] = GROUPS.flatMap((g) => ACTIONS.map((a) => permission(g, a)));

/** The two probe agents the check registers for itself, and removes afterwards. */
export const CHECK_AGENTS = {
  all: { id: "health-check-all", name: "Health check (all groups)", roleId: "health-check-all" },
  labs: { id: "health-check-labs", name: "Health check (labs only)", roleId: "health-check-labs" },
};

/**
 * The aipass gateway as a check target. White-box: it signs passes with the
 * api's own key and flips agent and grant state in the database, so every
 * probe runs, including stop and revoke.
 */
export function aipassTarget(o: AipassTargetOptions): Target {
  const person = o.person ?? "maria";
  const { db } = o;
  const fhir = o.fhirBaseUrl.replace(/\/$/, "");

  async function signingKey(): Promise<{ kid: string; key: CryptoKey }> {
    const [row] = await db.select().from(passKeys).where(isNull(passKeys.retiredAt)).limit(1);
    if (!row) throw new Error("the api has no signing key yet (start the api once)");
    return { kid: row.kid, key: (await importJWK(row.privateJwk as JWK, "ES256")) as CryptoKey };
  }

  const toolFor = (type: string, category?: string): string | null => {
    if (type === "Observation") {
      if (category === "laboratory") return "search_labs";
      if (category === "vital-signs") return "search_vitals";
      return null;
    }
    return (
      {
        Condition: "list_conditions",
        MedicationRequest: "list_medications",
        DocumentReference: "get_notes",
        Appointment: "list_appointments",
        Patient: "get_patient_summary",
      }[type] ?? null
    );
  };

  const urlOf = (cred: Credential) => agentUrl(o.gatewayUrl, CHECK_AGENTS[cred?.agent ?? "all"].id);

  return {
    name: "aipass gateway",
    version: o.version ?? "dev",
    capabilities: {
      credentials: true,
      partialAccess: true,
      adminStop: true,
      personRevoke: true,
      audit: true,
    },

    async setup() {
      const [p] = await db.select().from(persons).where(eq(persons.id, person));
      if (!p) throw new Error(`no person "${person}" (load the fixtures and seed the demo)`);
      await this.teardown?.();
      await db.insert(roles).values([
        {
          id: CHECK_AGENTS.all.roleId,
          name: "Health check (all groups)",
          rules: GROUPS.map((group) => ({ group, read: true, propose: false, write: false })),
          patientFields: ["name"],
        },
        {
          // Shows birth date for demographics, so a demographics leak is visible.
          id: CHECK_AGENTS.labs.roleId,
          name: "Health check (labs only)",
          rules: [{ group: "labs", read: true, propose: false, write: false }],
          patientFields: ["birthDate"],
        },
      ]);
      await db.insert(agents).values(
        Object.values(CHECK_AGENTS).map((a) => ({
          id: a.id,
          name: a.name,
          roleId: a.roleId,
          status: "active" as const,
          fhirDeviceId: agentDeviceId(a.id),
          description: "Registered by the aipass health check; removed when it finishes.",
        })),
      );
      // The labs agent's grant is wider than its role on purpose, so only the
      // role ceiling stands between it and the rest of the record.
      await db.insert(grants).values([
        {
          id: newId("grt"),
          personId: person,
          agentId: CHECK_AGENTS.all.id,
          permissions: ALL_READS,
          status: "active",
        },
        {
          id: newId("grt"),
          personId: person,
          agentId: CHECK_AGENTS.labs.id,
          permissions: EVERYTHING,
          status: "active",
        },
      ]);
      for (const a of Object.values(CHECK_AGENTS)) {
        await fetch(`${fhir}/Device/${agentDeviceId(a.id)}`, {
          method: "PUT",
          headers: { "content-type": "application/fhir+json" },
          body: JSON.stringify({
            resourceType: "Device",
            id: agentDeviceId(a.id),
            status: "active",
            deviceName: [{ name: a.name, type: "user-friendly-name" }],
            type: { text: "AI agent" },
          }),
        });
      }
    },

    async teardown() {
      const ids = Object.values(CHECK_AGENTS).map((a) => a.id);
      await db.delete(grants).where(inArray(grants.agentId, ids));
      await db.delete(agents).where(inArray(agents.id, ids));
      await db.delete(roles).where(
        inArray(
          roles.id,
          Object.values(CHECK_AGENTS).map((a) => a.roleId),
        ),
      );
    },

    async credential(req: CredentialRequest): Promise<Credential> {
      const agent: "all" | "labs" =
        req.groups?.length === 1 && req.groups[0] === "labs" ? "labs" : "all";
      const agentId = CHECK_AGENTS[agent].id;
      const now = Math.floor(Date.now() / 1000);
      let { kid, key } = await signingKey();
      if (req.variant === "forged") key = (await generateKeyPair("ES256")).privateKey;
      const iat = req.variant === "expired" ? now - 900 : now;
      const bearer = await new SignJWT({
        act: { sub: agentId },
        patient: req.variant === "other_patient" ? "john" : person,
      })
        .setProtectedHeader({ alg: "ES256", kid, typ: "at+jwt" })
        .setIssuer(o.passIssuer)
        .setSubject(person)
        .setAudience(
          req.variant === "wrong_audience"
            ? "https://other-service.example/fhir"
            : agentUrl(o.gatewayUrl, agentId),
        )
        .setIssuedAt(iat)
        .setExpirationTime(iat + 300)
        .setJti(randomUUID())
        .sign(key);
      return { bearer, agent };
    },

    async read(cred, type, id): Promise<Outcome> {
      if (type !== "DocumentReference")
        return { status: "refused", text: `no tool reads a ${type} by id` };
      return callTool(urlOf(cred), cred?.bearer, "get_notes", { id }, o.fetch);
    },

    async search(cred, type, query): Promise<Outcome> {
      const tool = toolFor(type, query.category);
      if (!tool) return { status: "refused", text: `no tool searches ${type}` };
      // aipass takes the patient from the pass, never from the request.
      return callTool(urlOf(cred), cred?.bearer, tool, { ...query.extra }, o.fetch);
    },

    async stopAgent() {
      await db.update(agents).set({ status: "stopped" }).where(eq(agents.id, CHECK_AGENTS.all.id));
    },
    async resumeAgent() {
      await db.update(agents).set({ status: "active" }).where(eq(agents.id, CHECK_AGENTS.all.id));
    },
    async revokeGrant() {
      await db
        .update(grants)
        .set({ status: "revoked", revokedAt: new Date() })
        .where(and(eq(grants.personId, person), eq(grants.agentId, CHECK_AGENTS.all.id)));
    },
    async restoreGrant() {
      await db
        .update(grants)
        .set({ status: "active", revokedAt: null })
        .where(and(eq(grants.personId, person), eq(grants.agentId, CHECK_AGENTS.all.id)));
    },

    async auditSince(since: Date): Promise<AuditRecord[]> {
      const q = new URLSearchParams({
        agent: `Device/${agentDeviceId(CHECK_AGENTS.all.id)}`,
        date: `ge${since.toISOString()}`,
        _count: "50",
      });
      const res = await fetch(`${fhir}/AuditEvent?${q}`, {
        headers: { accept: "application/fhir+json" },
      });
      const bundle = (await res.json()) as {
        entry?: {
          resource: {
            outcome?: string;
            outcomeDesc?: string;
            agent?: { who?: { reference?: string }; requestor?: boolean }[];
          };
        }[];
      };
      return (bundle.entry ?? []).map(({ resource: r }) => ({
        outcome: r.outcome === "0" ? "success" : "failure",
        agents: (r.agent ?? []).map((a) => ({
          ref: a.who?.reference ?? "",
          requestor: a.requestor === true,
        })),
        description: r.outcomeDesc ?? "",
      }));
    },
  };
}
