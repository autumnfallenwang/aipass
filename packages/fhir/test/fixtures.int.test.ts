import { describe, expect, it } from "vitest";

const base = process.env.FHIR_BASE_URL ?? "http://127.0.0.1:8080/fhir";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${base}/${path}`, { headers: { accept: "application/fhir+json" } });
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

type Bundle = { total?: number; entry?: { resource: { id: string } }[] };

describe("fixtures in the FHIR server", () => {
  it("has Maria", async () => {
    const maria = await get<{ name: { given: string[] }[] }>("Patient/maria");
    expect(maria.name[0]?.given[0]).toBe("Maria");
  });

  it("finds the PSY-labelled therapy note by _security", async () => {
    const b = await get<Bundle>(
      "DocumentReference?patient=Patient/maria&_security=http://terminology.hl7.org/CodeSystem/v3-ActCode|PSY",
    );
    expect(b.entry?.map((e) => e.resource.id)).toEqual(["maria-note-therapy"]);
  });

  it("finds the ETH-labelled substance-use condition by _security", async () => {
    const b = await get<Bundle>(
      "Condition?patient=Patient/maria&_security=http://terminology.hl7.org/CodeSystem/v3-ActCode|ETH",
    );
    expect(b.entry?.map((e) => e.resource.id)).toEqual(["maria-cond-alcohol"]);
  });

  it("has the two Synthea patients", async () => {
    const b = await get<Bundle>("Patient?_tag=https://aipass.dev/fixture|synthetic&_summary=count");
    expect(b.total).toBe(4);
  });
});
