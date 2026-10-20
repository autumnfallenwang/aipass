import { createHash } from "node:crypto";
import type { Group } from "@aipass/shared";
import canonicalize from "canonicalize";
import type { Resource } from "./types.ts";

/**
 * What an agent may propose (S5). The agent never sends FHIR JSON: it names a
 * measure and a value, and the gateway builds the resource, so what Maria
 * approves is exactly what gets written.
 */
export const MEASURES = {
  blood_glucose: {
    group: "labs",
    category: "laboratory",
    loinc: "2339-0",
    display: "Glucose [Mass/volume] in Blood",
    text: "Blood glucose",
    unit: "mg/dL",
    min: 20,
    max: 600,
  },
  body_weight: {
    group: "vitals",
    category: "vital-signs",
    loinc: "29463-7",
    display: "Body weight",
    text: "Body weight",
    unit: "kg",
    min: 1,
    max: 400,
  },
} as const satisfies Record<
  string,
  {
    group: Group;
    category: string;
    loinc: string;
    display: string;
    text: string;
    unit: string;
    min: number;
    max: number;
  }
>;

export type Measure = keyof typeof MEASURES;
export const MEASURE_NAMES = Object.keys(MEASURES) as Measure[];

export type ProposedChange = {
  measure: Measure;
  value: number;
  /** ISO date-time the reading was taken. */
  effective: string;
};

export class ProposalError extends Error {}

/** Builds the Observation that will be written, or throws when the change isn't valid. */
export function buildProposedObservation(change: ProposedChange, patientRef: string): Resource {
  const m = MEASURES[change.measure];
  if (!m) throw new ProposalError(`unknown measure "${change.measure}"`);
  if (!Number.isFinite(change.value) || change.value < m.min || change.value > m.max) {
    throw new ProposalError(`${m.text} must be between ${m.min} and ${m.max} ${m.unit}`);
  }
  const effective = new Date(change.effective);
  if (Number.isNaN(effective.getTime()))
    throw new ProposalError("effective must be an ISO date-time");
  if (effective.getTime() > Date.now() + 5 * 60_000)
    throw new ProposalError("effective can't be in the future");
  return {
    resourceType: "Observation",
    meta: { tag: [{ system: "https://aipass.dev/source", code: "ai-proposed" }] },
    status: "final",
    category: [
      {
        coding: [
          {
            system: "http://terminology.hl7.org/CodeSystem/observation-category",
            code: m.category,
          },
        ],
      },
    ],
    code: {
      coding: [{ system: "http://loinc.org", code: m.loinc, display: m.display }],
      text: m.text,
    },
    subject: { reference: patientRef },
    effectiveDateTime: effective.toISOString(),
    valueQuantity: {
      value: change.value,
      unit: m.unit,
      system: "http://unitsofmeasure.org",
      code: m.unit,
    },
  };
}

/** sha256 (hex) over the RFC 8785 canonical JSON of a resource. */
export function payloadHash(resource: Resource): string {
  const canonical = canonicalize(resource);
  if (canonical === undefined) throw new ProposalError("resource can't be canonicalised");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * The passkey challenge for one approval: sha256(payloadHash ‖ approvalId ‖ nonce).
 * An assertion over it can only approve this exact payload, for this approval.
 */
export function approvalChallenge(
  hash: string,
  approvalId: string,
  nonce: string,
): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(
    createHash("sha256").update(`${hash}|${approvalId}|${nonce}`, "utf8").digest(),
  );
}

/** "Blood glucose 130 mg/dL, measured 19 Oct 2026, 08:00 UTC". */
export function describeChange(change: ProposedChange): string {
  const m = MEASURES[change.measure];
  const when = new Date(change.effective).toUTCString().replace(/:\d\d GMT$/, " UTC");
  return `${m.text} ${change.value} ${m.unit}, measured ${when}`;
}
