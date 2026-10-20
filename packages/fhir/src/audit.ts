import { agentDeviceId } from "@aipass/shared";
import type { Resource } from "./types.ts";

export const AIPASS_SYSTEM = "https://aipass.dev";

/** The AI agent as a FHIR Device. Created when the agent is registered. */
export function buildDevice(agent: {
  id: string;
  name: string;
  description?: string | null;
  status: "active" | "stopped";
}): Resource {
  return {
    resourceType: "Device",
    id: agentDeviceId(agent.id),
    identifier: [{ system: `${AIPASS_SYSTEM}/agent`, value: agent.id }],
    status: agent.status === "active" ? "active" : "inactive",
    deviceName: [{ name: agent.name, type: "user-friendly-name" }],
    type: {
      coding: [
        {
          system: "http://snomed.info/sct",
          code: "706689003",
          display: "Application program software",
        },
      ],
      text: "AI agent",
    },
    ...(agent.description ? { note: [{ text: agent.description }] } : {}),
  };
}

export type AuditInput = {
  /** ISO time the decision was made. */
  recorded: string;
  agent: { id: string; name: string };
  /** The person the agent acted for. Unknown when the pass itself was bad. */
  person: { ref: string; name: string } | null;
  /** The patient whose record was touched. */
  patientRef: string | null;
  interaction: "search-type" | "read" | "create" | "update" | "operation";
  /** e.g. `Observation?category=laboratory` */
  query?: string;
  outcome: "allow" | "refuse";
  /** The plain-English receipt sentence. */
  sentence: string;
  passJti: string | null;
  receiptId: string;
  /** Records returned or written. */
  targets?: string[];
};

const ACTION: Record<AuditInput["interaction"], string> = {
  // a proposal is recorded as an operation: nothing is written yet
  operation: "E",
  "search-type": "E",
  read: "R",
  create: "C",
  update: "U",
};

/**
 * One AuditEvent per request, refusals included. agent[0] is the AI (a
 * Device); agent[1] is the person it acted for, marked as the requestor.
 */
export function buildAuditEvent(a: AuditInput): Resource {
  const agents: unknown[] = [
    {
      type: {
        coding: [
          {
            system: "http://dicom.nema.org/resources/ontology/DCM",
            code: "110150",
            display: "Application",
          },
        ],
      },
      who: { reference: `Device/${agentDeviceId(a.agent.id)}`, display: a.agent.name },
      requestor: false,
      ...(a.passJti ? { policy: [`urn:aipass:pass:${a.passJti}`] } : {}),
    },
  ];
  if (a.person) {
    agents.push({ who: { reference: a.person.ref, display: a.person.name }, requestor: true });
  }
  const entity: unknown[] = [];
  if (a.patientRef) {
    entity.push({
      what: { reference: a.patientRef },
      type: {
        system: "http://terminology.hl7.org/CodeSystem/audit-entity-type",
        code: "1",
        display: "Person",
      },
      role: {
        system: "http://terminology.hl7.org/CodeSystem/object-role",
        code: "1",
        display: "Patient",
      },
    });
  }
  if (a.query) {
    entity.push({
      type: {
        system: "http://terminology.hl7.org/CodeSystem/audit-entity-type",
        code: "2",
        display: "System Object",
      },
      role: {
        system: "http://terminology.hl7.org/CodeSystem/object-role",
        code: "24",
        display: "Query",
      },
      query: Buffer.from(a.query, "utf8").toString("base64"),
      description: a.query,
    });
  }
  for (const t of a.targets ?? []) entity.push({ what: { reference: t } });

  return {
    resourceType: "AuditEvent",
    meta: { tag: [{ system: `${AIPASS_SYSTEM}/receipt`, code: a.receiptId }] },
    type: {
      system: "http://terminology.hl7.org/CodeSystem/audit-event-type",
      code: "rest",
      display: "RESTful Operation",
    },
    subtype: [{ system: "http://hl7.org/fhir/restful-interaction", code: a.interaction }],
    action: ACTION[a.interaction],
    recorded: a.recorded,
    outcome: a.outcome === "allow" ? "0" : "4",
    outcomeDesc: a.sentence,
    agent: agents,
    source: {
      observer: { display: "aipass gateway" },
      type: [
        {
          system: "http://terminology.hl7.org/CodeSystem/security-source-type",
          code: "4",
          display: "Application Server",
        },
      ],
    },
    entity,
  };
}

export type ProvenanceInput = {
  recorded: string;
  target: string;
  agent: { id: string; name: string };
  onBehalfOf: { ref: string; name: string };
  /** Who approved the change, when it's someone other than `onBehalfOf`. */
  approver?: { ref: string; name: string };
  approvalId: string;
  payloadHash: string;
};

/** Provenance for a write: the AI did it, for the person, with their approval. */
export function buildProvenance(p: ProvenanceInput): Resource {
  const approver = p.approver ?? p.onBehalfOf;
  return {
    resourceType: "Provenance",
    target: [{ reference: p.target }],
    recorded: p.recorded,
    activity: {
      coding: [
        { system: "http://terminology.hl7.org/CodeSystem/v3-DataOperation", code: "CREATE" },
      ],
    },
    agent: [
      {
        type: {
          coding: [
            {
              system: "http://terminology.hl7.org/CodeSystem/provenance-participant-type",
              code: "author",
            },
          ],
        },
        who: { reference: `Device/${agentDeviceId(p.agent.id)}`, display: p.agent.name },
        onBehalfOf: { reference: p.onBehalfOf.ref, display: p.onBehalfOf.name },
      },
      {
        type: {
          coding: [
            {
              system: "http://terminology.hl7.org/CodeSystem/provenance-participant-type",
              code: "verifier",
            },
          ],
        },
        who: { reference: approver.ref, display: approver.name },
      },
    ],
    entity: [
      {
        role: "source",
        what: {
          identifier: { system: `${AIPASS_SYSTEM}/approval`, value: p.approvalId },
          display: `approval ${p.approvalId} (sha256 ${p.payloadHash})`,
        },
      },
    ],
  };
}
