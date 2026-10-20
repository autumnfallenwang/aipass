export {
  AIPASS_SYSTEM,
  type AuditInput,
  buildAuditEvent,
  buildDevice,
  buildProvenance,
} from "./audit.ts";
export { FhirClient, type FhirClientOptions, FhirError } from "./client.ts";
export { normaliseRef, patientRefsOf } from "./compartment.ts";
export { GROUP_QUERIES, type GroupQuery, groupOf } from "./groups.ts";
export { maskPatient } from "./mask.ts";
export { receiptSentence, type SentenceInput } from "./sentence.ts";
export { type SimpleRecord, simplify } from "./simplify.ts";
export type {
  Bundle,
  BundleEntry,
  Coding,
  OperationOutcome,
  Reference,
  Resource,
} from "./types.ts";

import type { Resource } from "./types.ts";

/** `meta.security` codings, or [] when there are none. */
export function labelsOf(r: Resource): { system?: string; code?: string }[] {
  return r.meta?.security ?? [];
}
