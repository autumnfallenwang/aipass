/**
 * Defence in depth: even if the FHIR server returns more than was asked for
 * (an `_include`, a misconfigured search, a compromised upstream), nothing
 * outside the role's view leaves the gateway.
 */
import { type Bundle, FhirClient } from "@aipass/fhir";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, FHIR, type Harness } from "./harness.ts";

const UPSTREAM_SECRET = "Bearer upstream-secret-never-shown";
const seen: { url: string; authorization: string | null }[] = [];

const smuggled = [
  // John's lab
  {
    resourceType: "Observation",
    id: "smuggled-john",
    category: [{ coding: [{ code: "laboratory" }] }],
    code: { text: "JOHN-ONLY A1c" },
    subject: { reference: "Patient/john" },
    valueQuantity: { value: 9.9, unit: "%" },
  },
  // a lab with a mental-health label
  {
    resourceType: "Observation",
    id: "smuggled-psy",
    meta: {
      security: [{ system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "PSY" }],
    },
    category: [{ coding: [{ code: "laboratory" }] }],
    code: { text: "PSY-LABELLED lithium level" },
    subject: { reference: "Patient/maria" },
  },
  // another group pulled in by an include
  {
    resourceType: "Condition",
    id: "smuggled-condition",
    code: { text: "INCLUDED condition" },
    subject: { reference: "Patient/maria" },
  },
  // a type no group covers
  {
    resourceType: "Encounter",
    id: "smuggled-encounter",
    subject: { reference: "Patient/maria" },
    serviceType: { text: "ENCOUNTER-ONLY" },
  },
  // a label nobody recognises
  {
    resourceType: "Observation",
    id: "smuggled-unknown-label",
    meta: { security: [{ system: "https://example.org/x", code: "TOPSECRET" }] },
    category: [{ coding: [{ code: "laboratory" }] }],
    code: { text: "UNKNOWN-LABEL glucose" },
    subject: { reference: "Patient/maria" },
  },
];

const evilFetch: typeof fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  const headers = new Headers(init?.headers);
  seen.push({ url, authorization: headers.get("authorization") });
  const res = await fetch(input, init);
  if (!url.includes("/Observation?")) return res;
  const b = (await res.json()) as Bundle;
  b.entry = [
    ...(b.entry ?? []),
    ...smuggled.map((r) => ({ resource: r, search: { mode: "include" as const } })),
  ];
  return new Response(JSON.stringify(b), {
    status: 200,
    headers: { "content-type": "application/fhir+json" },
  });
};

let h: Harness;
beforeAll(async () => {
  h = await createHarness({
    fhir: new FhirClient({
      baseUrl: FHIR,
      fetch: evilFetch,
      headers: { authorization: UPSTREAM_SECRET },
    }),
  });
});
afterAll(async () => h?.close());
beforeEach(async () => {
  await h.reset();
  seen.length = 0;
});

describe("response filtering", () => {
  it("drops other patients, locked labels, other groups, unknown types and unknown labels", async () => {
    const s = await h.connect("diabetes-coach", await h.pass("diabetes-coach", "maria"));
    const r = await s.call("search_labs", { limit: 50 });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Hemoglobin A1c");
    for (const leak of [
      "JOHN-ONLY",
      "PSY-LABELLED",
      "INCLUDED condition",
      "ENCOUNTER-ONLY",
      "UNKNOWN-LABEL",
      "smuggled",
    ]) {
      expect(r.text).not.toContain(leak);
    }
    expect(r.text).toContain("5 record(s) were withheld");
    for (const reason of [
      "not Maria's record",
      "mental-health records are always private",
      "records outside this request are withheld",
      "records of an unrecognised type are withheld",
      "records with an unrecognised sensitivity label are withheld",
    ]) {
      expect(r.text).toContain(reason);
    }
    const receipt = await h.lastReceipt();
    expect(receipt?.withheld).toBe(5);
    await s.close();
  });

  it("never passes the agent's pass to FHIR, and never shows the gateway's FHIR credential", async () => {
    const pass = await h.pass("diabetes-coach", "maria");
    const s = await h.connect("diabetes-coach", pass);
    const r = await s.call("search_labs");
    await s.close();
    expect(seen.length).toBeGreaterThan(0);
    for (const call of seen) {
      expect(call.authorization).toBe(UPSTREAM_SECRET);
      expect(call.url).not.toContain(pass);
    }
    expect(r.text).not.toContain("upstream-secret");
  });
});
