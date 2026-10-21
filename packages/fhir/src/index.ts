export {
  AIPASS_SYSTEM,
  type AuditInput,
  type AuditTarget,
  buildAuditEvent,
  buildDevice,
  buildProvenance,
} from "./audit.ts";
export { type CarePatient, careTeamOf, humanName } from "./care.ts";
export { FhirClient, type FhirClientOptions, FhirError } from "./client.ts";
export { normaliseRef, patientRefsOf } from "./compartment.ts";
export { loadFixtures } from "./fixtures.ts";
export { GROUP_QUERIES, type GroupQuery, groupOf } from "./groups.ts";
export { smartLauncherFhirUrl } from "./launcher.ts";
export { maskPatient } from "./mask.ts";
export {
  approvalChallenge,
  buildProposedObservation,
  describeChange,
  MEASURE_NAMES,
  MEASURES,
  type Measure,
  ProposalError,
  type ProposedChange,
  payloadHash,
} from "./proposal.ts";
export { receiptSentence, type SentenceInput } from "./sentence.ts";
export { type SimpleRecord, simplify } from "./simplify.ts";
export {
  authorizeUrl,
  discoverSmart,
  exchangeCode,
  pkcePair,
  refreshTokens,
  type SmartClient,
  type SmartEndpoints,
  SmartError,
  type SmartTokens,
} from "./smart.ts";
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
