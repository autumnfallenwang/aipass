import type { CodeableConcept, Coding, Quantity, Reference, Resource } from "./types.ts";

/**
 * Compact, model-friendly views of the records an agent is allowed to see.
 * Only fields listed here leave the gateway; the raw FHIR resource does not.
 */
export type SimpleRecord = Record<string, string | number | undefined> & { ref: string };

function text(cc: unknown): string | undefined {
  const c = cc as CodeableConcept | undefined;
  return c?.text ?? c?.coding?.find((k: Coding) => k.display)?.display;
}

function firstText(arr: unknown): string | undefined {
  return Array.isArray(arr) ? text(arr[0]) : undefined;
}

function quantity(q: unknown): string | undefined {
  const v = q as Quantity | undefined;
  if (v?.value === undefined) return undefined;
  return v.unit ? `${v.value} ${v.unit}` : String(v.value);
}

function ref(r: Resource): string {
  return `${r.resourceType}/${r.id ?? "?"}`;
}

function observation(r: Resource): SimpleRecord {
  const comps =
    (r.component as { code?: CodeableConcept; valueQuantity?: Quantity }[] | undefined) ?? [];
  let value = quantity(r.valueQuantity) ?? (r.valueString as string | undefined);
  if (!value && comps.length) {
    const nums = comps.map((c) => c.valueQuantity?.value).filter((n) => n !== undefined);
    const unit = comps[0]?.valueQuantity?.unit;
    value = `${nums.join("/")}${unit ? ` ${unit}` : ""}`;
  }
  return {
    ref: ref(r),
    date: (r.effectiveDateTime as string | undefined) ?? (r.issued as string | undefined),
    test: text(r.code),
    value,
    status: r.status as string | undefined,
  };
}

function medication(r: Resource): SimpleRecord {
  const dosage = (r.dosageInstruction ?? r.dosage) as { text?: string }[] | undefined;
  return {
    ref: ref(r),
    medication: text(r.medicationCodeableConcept) ?? (r.medicationReference as Reference)?.display,
    dosage: dosage?.[0]?.text,
    status: r.status as string | undefined,
    since: (r.authoredOn as string | undefined) ?? (r.effectiveDateTime as string | undefined),
  };
}

function condition(r: Resource): SimpleRecord {
  return {
    ref: ref(r),
    condition: text(r.code),
    status: (r.clinicalStatus as CodeableConcept | undefined)?.coding?.[0]?.code,
    since: r.onsetDateTime as string | undefined,
    resolved: r.abatementDateTime as string | undefined,
  };
}

function appointment(r: Resource): SimpleRecord {
  return {
    ref: ref(r),
    what: firstText(r.serviceType) ?? (r.description as string | undefined),
    description: r.description as string | undefined,
    start: r.start as string | undefined,
    end: r.end as string | undefined,
    status: r.status as string | undefined,
  };
}

function decodeAttachments(r: Resource): string | undefined {
  const content = (r.content as { attachment?: { contentType?: string; data?: string } }[]) ?? [];
  for (const c of content) {
    const a = c.attachment;
    if (a?.data && (a.contentType ?? "").startsWith("text/plain")) {
      return Buffer.from(a.data, "base64").toString("utf8").slice(0, 2000);
    }
  }
  return undefined;
}

function documentReference(r: Resource): SimpleRecord {
  return {
    ref: ref(r),
    title: (r.description as string | undefined) ?? text(r.type),
    date: r.date as string | undefined,
    text: decodeAttachments(r),
  };
}

function patient(r: Resource): SimpleRecord {
  const name = (r.name as { given?: string[]; family?: string }[] | undefined)?.[0];
  const telecom = (r.telecom as { system?: string; value?: string }[] | undefined) ?? [];
  const address = (
    r.address as
      | { line?: string[]; city?: string; state?: string; postalCode?: string }[]
      | undefined
  )?.[0];
  return {
    ref: ref(r),
    name: name ? [...(name.given ?? []), name.family].filter(Boolean).join(" ") : undefined,
    phone: telecom.find((t) => t.system === "phone")?.value,
    email: telecom.find((t) => t.system === "email")?.value,
    birthDate: r.birthDate as string | undefined,
    gender: r.gender as string | undefined,
    address: address
      ? [...(address.line ?? []), address.city, address.state, address.postalCode]
          .filter(Boolean)
          .join(", ")
      : undefined,
    mrn: (r.identifier as { value?: string }[] | undefined)?.[0]?.value,
    maritalStatus: text(r.maritalStatus),
  };
}

export function simplify(r: Resource): SimpleRecord {
  let out: SimpleRecord;
  switch (r.resourceType) {
    case "Observation":
      out = observation(r);
      break;
    case "MedicationRequest":
    case "MedicationStatement":
      out = medication(r);
      break;
    case "Condition":
      out = condition(r);
      break;
    case "Appointment":
      out = appointment(r);
      break;
    case "DocumentReference":
      out = documentReference(r);
      break;
    case "Patient":
      out = patient(r);
      break;
    default:
      out = { ref: ref(r) };
  }
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}
