import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAuditEvent,
  buildDevice,
  buildProvenance,
  careTeamOf,
  FhirClient,
  groupOf,
  labelsOf,
  maskPatient,
  normaliseRef,
  patientRefsOf,
  type Resource,
  receiptSentence,
  simplify,
} from "../src/index.ts";

const bundle = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../fixtures/maria.json"), "utf8"),
) as { entry: { resource: Resource }[] };
const byId = new Map(bundle.entry.map((e) => [e.resource.id, e.resource]));
const get = (id: string): Resource => {
  const r = byId.get(id);
  if (!r) throw new Error(`fixture ${id} missing`);
  return r;
};

describe("groupOf", () => {
  it.each([
    ["maria-a1c-1", "labs"],
    ["maria-bp-1", "vitals"],
    ["maria-med-metformin", "medications"],
    ["maria-cond-diabetes", "conditions"],
    ["maria-appt-eye", "appointments"],
    ["maria", "demographics"],
    ["maria-note-therapy", "notes"],
  ])("%s → %s", (id, group) => {
    expect(groupOf(get(id))).toBe(group);
  });

  it("refuses an Observation with no lab/vital category", () => {
    expect(
      groupOf({ resourceType: "Observation", category: [{ coding: [{ code: "survey" }] }] }),
    ).toBeNull();
  });

  it("refuses an Observation claiming both lab and vital", () => {
    expect(
      groupOf({
        resourceType: "Observation",
        category: [{ coding: [{ code: "laboratory" }] }, { coding: [{ code: "vital-signs" }] }],
      }),
    ).toBeNull();
  });

  it("refuses resource types outside every group", () => {
    expect(groupOf({ resourceType: "Encounter" })).toBeNull();
    expect(groupOf({ resourceType: "Practitioner" })).toBeNull();
  });
});

describe("patient compartment", () => {
  it("normalises references", () => {
    expect(normaliseRef("Patient/maria")).toBe("Patient/maria");
    expect(normaliseRef("http://fhir.example/fhir/Patient/maria/_history/3")).toBe("Patient/maria");
    expect(normaliseRef("urn:uuid:1234")).toBeNull();
    expect(normaliseRef("#contained")).toBeNull();
  });

  it("finds Maria on her own records", () => {
    expect(patientRefsOf(get("maria-a1c-1"))).toEqual(["Patient/maria"]);
    expect(patientRefsOf(get("maria"))).toEqual(["Patient/maria"]);
    expect(patientRefsOf(get("maria-appt-eye"))).toEqual(["Patient/maria"]);
  });

  it("reports every patient on a shared appointment", () => {
    const appt: Resource = {
      resourceType: "Appointment",
      participant: [
        { actor: { reference: "Patient/maria" } },
        { actor: { reference: "Patient/john" } },
        { actor: { reference: "Practitioner/okafor" } },
      ],
    };
    expect(patientRefsOf(appt).sort()).toEqual(["Patient/john", "Patient/maria"]);
  });

  it("treats a non-patient subject as outside the compartment", () => {
    expect(
      patientRefsOf({ resourceType: "Observation", subject: { reference: "Group/g1" } }),
    ).toEqual(["Group/g1"]);
  });
});

describe("labels", () => {
  it("reads meta.security", () => {
    expect(labelsOf(get("maria-note-therapy")).map((l) => l.code)).toEqual(["PSY", "R"]);
    expect(labelsOf(get("maria-a1c-1"))).toEqual([]);
  });
});

describe("maskPatient", () => {
  it("keeps only name and phone for the Scheduling Assistant", () => {
    const masked = maskPatient(get("maria"), ["name", "phone"]);
    expect(Object.keys(masked).sort()).toEqual(["id", "name", "resourceType", "telecom"]);
    expect(masked.telecom).toEqual([{ system: "phone", value: "555-0142", use: "mobile" }]);
  });

  it("drops fields it doesn't know, even if asked", () => {
    const p: Resource = {
      resourceType: "Patient",
      id: "x",
      extension: [{ url: "secret" }],
      photo: [{}],
    };
    expect(maskPatient(p, ["name", "phone", "email", "birthDate", "gender", "address"])).toEqual({
      resourceType: "Patient",
      id: "x",
    });
  });
});

describe("simplify", () => {
  it("summarises a lab", () => {
    expect(simplify(get("maria-a1c-3"))).toEqual({
      ref: "Observation/maria-a1c-3",
      date: "2026-09-28",
      test: "Hemoglobin A1c",
      value: "6.9 %",
      status: "final",
    });
  });

  it("joins blood pressure components", () => {
    expect(simplify(get("maria-bp-1")).value).toBe("134/84 mmHg");
  });

  it("decodes a plain-text note", () => {
    expect(simplify(get("maria-note-diabetes-visit")).text).toContain("A1c 6.9%");
  });

  it("summarises a masked patient without leaking hidden fields", () => {
    expect(simplify(maskPatient(get("maria"), ["name", "phone"]))).toEqual({
      ref: "Patient/maria",
      name: "Maria Elena Santos",
      phone: "555-0142",
    });
  });
});

describe("receipt sentences", () => {
  it("reads like a sentence when allowed", () => {
    expect(
      receiptSentence({
        decision: "allow",
        agentName: "Diabetes Coach",
        personName: "Maria Santos",
        action: "read",
        group: "conditions",
        count: 2,
        withheld: {
          count: 2,
          reasons: [
            "mental-health records are always private",
            "substance-use records are always private",
          ],
        },
      }),
    ).toBe(
      "Diabetes Coach read 2 conditions for Maria Santos. 2 records were withheld (mental-health records are always private; substance-use records are always private).",
    );
  });

  it("names the reason when refused", () => {
    expect(
      receiptSentence({
        decision: "refuse",
        agentName: "Scheduling Assistant",
        personName: "Maria Santos",
        action: "read",
        group: "labs",
        reason: "not in the Scheduling Assistant role",
      }),
    ).toBe(
      "REFUSED: Scheduling Assistant tried to read Maria Santos's lab results: not in the Scheduling Assistant role.",
    );
  });
});

describe("staff members (S10)", () => {
  it("receipts name the clinician the AI acted for, and the patient", () => {
    const base = { agentName: "Visit Assistant", personName: "Dr. Grace Lee", staff: true };
    expect(
      receiptSentence({
        ...base,
        patientName: "Maria Santos",
        decision: "allow",
        action: "read",
        group: "labs",
        count: 3,
      }),
    ).toBe("Visit Assistant read 3 lab results for Dr. Grace Lee (patient: Maria Santos).");
    expect(
      receiptSentence({
        ...base,
        patientName: null,
        decision: "refuse",
        action: "read",
        group: "labs",
        reason: "not one of Dr. Lee's patients",
      }),
    ).toBe(
      "REFUSED: Visit Assistant tried to read lab results for Dr. Grace Lee: not one of Dr. Lee's patients.",
    );
  });

  it("a care team counts only if it's active and names the clinician", async () => {
    const team = (id: string, patient: string, member: string, status = "active") => ({
      resource: {
        resourceType: "CareTeam",
        id,
        status,
        subject: { reference: patient },
        participant: [{ member: { reference: member } }],
      },
    });
    const answer = {
      resourceType: "Bundle",
      entry: [
        team("a", "Patient/maria", "Practitioner/lee"),
        team("b", "Patient/john", "Practitioner/someone-else"),
        team("c", "Patient/carlo", "Practitioner/lee", "inactive"),
        team("d", "Group/ward-3", "Practitioner/lee"),
        {
          resource: {
            resourceType: "Patient",
            id: "maria",
            name: [{ given: ["Maria"], family: "Santos" }],
            birthDate: "1971-03-14",
          },
        },
      ],
    };
    let asked = "";
    const fhir = new FhirClient({
      baseUrl: "http://fhir.test/fhir",
      fetch: async (url) => {
        asked = String(url);
        return new Response(JSON.stringify(answer), { status: 200 });
      },
    });
    expect(await careTeamOf(fhir, "Practitioner/lee")).toEqual([
      { ref: "Patient/maria", name: "Maria Santos", birthDate: "1971-03-14", gender: null },
    ]);
    expect(asked).toContain("participant=Practitioner%2Flee");
    expect(asked).toContain("status=active");
  });
});

describe("FHIR builders", () => {
  it("builds the agent's Device", () => {
    const d = buildDevice({ id: "diabetes-coach", name: "Diabetes Coach", status: "active" });
    expect(d).toMatchObject({
      resourceType: "Device",
      id: "aipass-agent-diabetes-coach",
      status: "active",
    });
  });

  it("builds an AuditEvent naming both the AI and the person", () => {
    const ae = buildAuditEvent({
      recorded: "2026-10-19T12:00:00Z",
      agent: { id: "diabetes-coach", name: "Diabetes Coach" },
      person: { ref: "Patient/maria", name: "Maria Santos" },
      patientRef: "Patient/maria",
      interaction: "search-type",
      query: "DocumentReference?patient=Patient/maria",
      outcome: "refuse",
      sentence: "REFUSED: …",
      passJti: "jti-1",
      receiptId: "r1",
    });
    const agents = ae.agent as {
      who: { reference: string };
      requestor: boolean;
      policy?: string[];
    }[];
    expect(agents[0]).toMatchObject({
      who: { reference: "Device/aipass-agent-diabetes-coach" },
      requestor: false,
      policy: ["urn:aipass:pass:jti-1"],
    });
    expect(agents[1]).toMatchObject({ who: { reference: "Patient/maria" }, requestor: true });
    expect(ae.outcome).toBe("4");
  });

  it("builds a Provenance with onBehalfOf", () => {
    const p = buildProvenance({
      recorded: "2026-10-19T12:00:00Z",
      target: "Observation/new",
      agent: { id: "diabetes-coach", name: "Diabetes Coach" },
      onBehalfOf: { ref: "Patient/maria", name: "Maria Santos" },
      approvalId: "a1",
      payloadHash: "abc",
    });
    const agents = p.agent as { who: { reference: string }; onBehalfOf?: { reference: string } }[];
    expect(agents[0]).toMatchObject({
      who: { reference: "Device/aipass-agent-diabetes-coach" },
      onBehalfOf: { reference: "Patient/maria" },
    });
  });
});

describe("FhirClient", () => {
  it("refuses to follow a link to another server", async () => {
    const c = new FhirClient({
      baseUrl: "http://fhir.local/fhir",
      fetch: () => Promise.reject(new Error("no")),
    });
    expect(c.owns("http://fhir.local/fhir?_getpages=x")).toBe(true);
    expect(c.owns("http://fhir.local/fhirx/Patient")).toBe(false);
    expect(c.owns("http://evil.example/fhir?_getpages=x")).toBe(false);
    await expect(c.page("http://evil.example/fhir?_getpages=x")).rejects.toThrow(/outside/);
  });
});

describe("FhirClient.repoint", () => {
  it("sends the next request to the new server, with the new credential", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(url),
        auth: new Headers(init?.headers).get("authorization"),
      });
      return new Response(JSON.stringify({ resourceType: "Patient", id: "p" }), { status: 200 });
    }) as typeof fetch;
    const c = new FhirClient({
      baseUrl: "http://one.example/fhir",
      headers: { authorization: "Bearer one" },
      fetch: fetchFn,
    });
    await c.read("Patient", "p");
    c.repoint({ baseUrl: "http://two.example/fhir/", headers: { authorization: "Bearer two" } });
    await c.read("Patient", "p");
    expect(seen).toEqual([
      { url: "http://one.example/fhir/Patient/p", auth: "Bearer one" },
      { url: "http://two.example/fhir/Patient/p", auth: "Bearer two" },
    ]);
    expect(c.baseUrl).toBe("http://two.example/fhir");
    expect(c.credentialHeaders()).toEqual({ authorization: "Bearer two" });
    // It only talks to the server it points at now.
    expect(c.owns("http://one.example/fhir/Patient/p")).toBe(false);
  });
});
