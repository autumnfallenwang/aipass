import type { Group } from "@aipass/shared";
import type { CodeableConcept, Resource } from "./types.ts";

const OBSERVATION_CATEGORY = "http://terminology.hl7.org/CodeSystem/observation-category";

export type GroupQuery = {
  /** FHIR resource type to search. */
  resourceType: string;
  /** The search parameter that pins the patient. */
  patientParam: "patient" | "subject" | "_id" | "actor";
  /** Fixed parameters the gateway always adds. */
  fixed: Record<string, string>;
};

/** How each admin-facing group maps to FHIR searches. A group may need more than one. */
export const GROUP_QUERIES: Record<Group, readonly GroupQuery[]> = {
  labs: [
    {
      resourceType: "Observation",
      patientParam: "patient",
      fixed: { category: `${OBSERVATION_CATEGORY}|laboratory` },
    },
  ],
  vitals: [
    {
      resourceType: "Observation",
      patientParam: "patient",
      fixed: { category: `${OBSERVATION_CATEGORY}|vital-signs` },
    },
  ],
  medications: [
    { resourceType: "MedicationRequest", patientParam: "patient", fixed: {} },
    { resourceType: "MedicationStatement", patientParam: "patient", fixed: {} },
  ],
  conditions: [{ resourceType: "Condition", patientParam: "patient", fixed: {} }],
  appointments: [{ resourceType: "Appointment", patientParam: "actor", fixed: {} }],
  demographics: [{ resourceType: "Patient", patientParam: "_id", fixed: {} }],
  notes: [{ resourceType: "DocumentReference", patientParam: "patient", fixed: {} }],
};

function hasCategory(c: unknown, code: string): boolean {
  if (!Array.isArray(c)) return false;
  return (c as CodeableConcept[]).some((cc) =>
    cc.coding?.some(
      (k) => k.code === code && (k.system === undefined || k.system === OBSERVATION_CATEGORY),
    ),
  );
}

/**
 * Which group a returned record belongs to, judged from the record itself
 * (never from the query that fetched it). Null means "fits no group": refused.
 */
export function groupOf(r: Resource): Group | null {
  switch (r.resourceType) {
    case "Observation": {
      const lab = hasCategory(r.category, "laboratory");
      const vital = hasCategory(r.category, "vital-signs");
      if (lab && !vital) return "labs";
      if (vital && !lab) return "vitals";
      return null;
    }
    case "MedicationRequest":
    case "MedicationStatement":
      return "medications";
    case "Condition":
      return "conditions";
    case "Appointment":
      return "appointments";
    case "Patient":
      return "demographics";
    case "DocumentReference":
      return "notes";
    default:
      return null;
  }
}
