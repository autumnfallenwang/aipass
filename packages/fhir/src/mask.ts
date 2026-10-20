import type { PatientField } from "@aipass/shared";
import type { Resource } from "./types.ts";

type Telecom = { system?: string; value?: string; use?: string };

/**
 * Returns a copy of a Patient holding only the fields the role allows.
 * Built up from an empty object, so a field we don't know about can never
 * slip through (fail closed).
 */
export function maskPatient(patient: Resource, fields: readonly PatientField[]): Resource {
  const out: Resource = { resourceType: "Patient", id: patient.id };
  const allow = new Set(fields);
  if (allow.has("name") && patient.name) out.name = patient.name;
  const telecom = (patient.telecom as Telecom[] | undefined) ?? [];
  const keptTelecom = telecom.filter(
    (t) =>
      (t.system === "phone" && allow.has("phone")) || (t.system === "email" && allow.has("email")),
  );
  if (keptTelecom.length) out.telecom = keptTelecom;
  if (allow.has("birthDate") && patient.birthDate) out.birthDate = patient.birthDate;
  if (allow.has("gender") && patient.gender) out.gender = patient.gender;
  if (allow.has("address") && patient.address) out.address = patient.address;
  if (allow.has("identifier") && patient.identifier) out.identifier = patient.identifier;
  if (allow.has("maritalStatus") && patient.maritalStatus)
    out.maritalStatus = patient.maritalStatus;
  return out;
}
