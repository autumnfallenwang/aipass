/**
 * Trims a Synthea patient bundle down to the resource types aipass uses and
 * rewrites it as an idempotent transaction (PUT with fixed ids).
 *
 *   pnpm tsx scripts/trim-synthea.ts <synthea-bundle.json> <out.json>
 *
 * See fixtures/README.md for the exact Synthea command and seed.
 */
import { readFileSync, writeFileSync } from "node:fs";

type Resource = { resourceType: string; id: string; [k: string]: unknown };
type Entry = { fullUrl?: string; resource: Resource };

const DROP_FIELDS = [
  "text",
  "encounter",
  "requester",
  "performer",
  "recorder",
  "asserter",
  "author",
  "custodian",
  "context",
  "hasMember",
  "derivedFrom",
  "reasonReference",
  "insurance",
  "managingOrganization",
  "generalPractitioner",
];

const LIMITS: Record<string, number> = {
  Observation: 12,
  Condition: 10,
  MedicationRequest: 5,
  DocumentReference: 2,
};

function effective(r: Resource): string {
  const v =
    r.effectiveDateTime ?? r.onsetDateTime ?? r.authoredOn ?? r.date ?? r.recordedDate ?? "";
  return String(v);
}

function observationCategory(r: Resource): string | undefined {
  const cats = r.category as { coding?: { code?: string }[] }[] | undefined;
  return cats?.[0]?.coding?.[0]?.code;
}

function main(): void {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error("usage: trim-synthea.ts <in.json> <out.json>");
    process.exit(2);
  }
  const bundle = JSON.parse(readFileSync(input, "utf8")) as { entry: Entry[] };
  const patient = bundle.entry.find((e) => e.resource.resourceType === "Patient")?.resource;
  if (!patient) throw new Error("no Patient in bundle");
  const patientRef = `Patient/${patient.id}`;

  const keep: Resource[] = [patient];
  for (const type of Object.keys(LIMITS)) {
    let rs = bundle.entry.map((e) => e.resource).filter((r) => r.resourceType === type);
    if (type === "Observation") {
      rs = rs.filter((r) => ["laboratory", "vital-signs"].includes(observationCategory(r) ?? ""));
    }
    if (type === "MedicationRequest") rs = rs.filter((r) => r.medicationCodeableConcept);
    rs.sort((a, b) => effective(b).localeCompare(effective(a)));
    keep.push(...rs.slice(0, LIMITS[type]));
  }

  const entries = keep.map((r) => {
    const copy: Resource = structuredClone(r);
    for (const f of DROP_FIELDS) delete copy[f];
    for (const f of ["subject", "patient"]) {
      if (copy[f]) copy[f] = { reference: patientRef };
    }
    copy.meta = {
      tag: [{ system: "https://aipass.dev/fixture", code: "synthetic" }],
    };
    return {
      resource: copy,
      request: { method: "PUT", url: `${copy.resourceType}/${copy.id}` },
    };
  });

  const out = {
    resourceType: "Bundle",
    id: `aipass-fixture-synthea-${patient.id}`,
    type: "transaction",
    entry: entries,
  };
  writeFileSync(output, `${JSON.stringify(out, null, 2)}\n`);
  console.info(`${output}: ${entries.length} resources for ${patientRef}`);
}

main();
