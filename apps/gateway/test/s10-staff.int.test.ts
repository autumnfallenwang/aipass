/**
 * S10 validation against real Postgres and HAPI: an agent acts for a staff
 * member, on the patient she has open (D21). Dr. Lee's care team is in
 * fixtures/staff/lee.json: Maria and Carlo are hers, John is not.
 * See docs/PLAN.md § S10.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { approvals, patientContexts, receipts } from "@aipass/db";
import type { Bundle, Resource } from "@aipass/fhir";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const CARLO = "b4900f5e-1c24-1150-fd26-6fbc83da8893";
const AGENT = "visit-assistant";
let h: Harness;

beforeAll(async () => {
  h = await createHarness();
  // Dr. Lee and her care teams (idempotent PUTs).
  const fixture = join(import.meta.dirname, "../../../fixtures/staff/lee.json");
  await h.fhir.transaction(JSON.parse(readFileSync(fixture, "utf8")) as Bundle);
});
afterAll(async () => {
  // Leave the shared synthetic FHIR server as the fixtures made it.
  const written = await h.fhir.search(
    "Observation",
    new URLSearchParams({
      patient: "Patient/maria",
      _tag: "https://aipass.dev/source|ai-proposed",
      _count: "100",
    }),
  );
  for (const e of written.entry ?? []) {
    const id = e.resource?.id ?? "";
    const provs = await h.fhir.search(
      "Provenance",
      new URLSearchParams({ target: `Observation/${id}` }),
    );
    for (const p of provs.entry ?? []) {
      await fetch(`${h.config.fhirBaseUrl}/Provenance/${p.resource?.id}`, { method: "DELETE" });
    }
    await fetch(`${h.config.fhirBaseUrl}/Observation/${id}`, { method: "DELETE" });
  }
  await h?.close();
});
beforeEach(async () => {
  await h.reset();
  await open("maria");
});

/** Dr. Lee opens a patient with the Visit Assistant (what the web UI does, after checking her care team). */
async function open(patient: string) {
  await h.db
    .insert(patientContexts)
    .values({ personId: "lee", agentId: AGENT, patientRef: `Patient/${patient}` })
    .onConflictDoUpdate({
      target: [patientContexts.personId, patientContexts.agentId],
      set: { patientRef: `Patient/${patient}` },
    });
}

/** A pass for Dr. Lee naming a patient (or none). */
async function lee(patient: string | null) {
  const claims = patient ? { patient } : { patient: undefined };
  return h.connect(AGENT, await h.pass(AGENT, "lee", { claims }));
}

async function auditEventFor(receiptId: string) {
  const [r] = await h.db.select().from(receipts).where(eq(receipts.id, receiptId));
  const ae = await h.fhir.read("AuditEvent", r?.auditEventId ?? "");
  return ae as unknown as {
    agent: { who: { reference: string }; requestor: boolean }[];
    entity: { what?: { reference?: string } }[];
  };
}

describe("S10: an agent acts for a staff member, on the patient she has open", () => {
  it("Dr. Lee reads Maria's labs; the receipt and AuditEvent name them both", async () => {
    const s = await lee("maria");
    const r = await s.call("search_labs", { code: "4548-4" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("for Maria Elena Santos, the patient Dr. Grace Lee has open");
    expect(r.text).toContain("6.9 %");

    const receipt = await h.lastReceipt();
    expect(receipt).toMatchObject({
      decision: "allow",
      agentId: AGENT,
      personId: "lee",
      target: "Patient/maria",
    });
    expect(receipt?.sentence).toBe(
      "Visit Assistant read 3 lab results for Dr. Grace Lee (patient: Maria Elena Santos).",
    );
    const ae = await auditEventFor(receipt?.id ?? "");
    expect(ae.agent[1]).toMatchObject({
      who: { reference: "Practitioner/lee" },
      requestor: true,
    });
    expect(ae.entity.map((e) => e.what?.reference)).toContain("Patient/maria");
    await s.close();
  });

  it("another patient's record: REFUSE 'not the patient in context'", async () => {
    const s = await lee("maria");
    const r = await s.call("get_notes", { id: "john-note-1" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("REFUSED: not the patient in context.");
    expect((await h.lastReceipt())?.sentence).toBe(
      "REFUSED: Visit Assistant tried to read visit notes for Dr. Grace Lee (patient: Maria Elena Santos): not the patient in context.",
    );
    await s.close();
  });

  it("Maria's therapy note (PSY): REFUSE, and her antidepressant is withheld", async () => {
    const s = await lee("maria");
    const note = await s.call("get_notes", { id: "maria-note-therapy" });
    expect(note.text).toContain("REFUSED: mental-health records are always private.");
    const meds = await s.call("list_medications");
    expect(meds.isError).toBe(false);
    expect(meds.text).toContain("Metformin");
    expect(meds.text).not.toContain("ertraline");
    expect(meds.text).toContain(
      "1 record(s) were withheld: mental-health records are always private",
    );
    await s.close();
  });

  it("a pass for a patient who isn't in her care: REFUSE, without naming them", async () => {
    const s = await lee("john");
    const r = await s.call("search_labs");
    expect(r.text).toContain("REFUSED: not one of Dr. Lee's patients.");
    expect(r.text).not.toContain("John");
    expect((await h.lastReceipt())?.sentence).toBe(
      "REFUSED: Visit Assistant tried to read lab results for Dr. Grace Lee: not one of Dr. Lee's patients.",
    );
    await s.close();
  });

  it("no patient open: REFUSE 'no patient selected'", async () => {
    const s = await lee(null);
    expect((await s.call("search_labs")).text).toContain("REFUSED: no patient selected.");
    await s.close();
  });

  it("switching patient: an old pass for the previous patient is refused on its next call", async () => {
    const maria = await lee("maria");
    const carlo = await lee(CARLO);
    expect((await carlo.call("list_conditions")).text).toContain(
      "REFUSED: Dr. Lee has another patient open now.",
    );
    await open(CARLO);
    const now = await carlo.call("list_conditions");
    expect(now.isError).toBe(false);
    expect(now.text).toContain("the patient Dr. Grace Lee has open");
    expect((await maria.call("search_labs")).text).toContain(
      "REFUSED: Dr. Lee has another patient open now.",
    );
    await maria.close();
    await carlo.close();
  });

  it("a patient who leaves her care is refused on the next call", async () => {
    const team = {
      resourceType: "CareTeam",
      id: "lee-john-test",
      status: "active",
      subject: { reference: "Patient/john" },
      participant: [{ member: { reference: "Practitioner/lee" } }],
    } as Resource;
    await h.fhir.update(team);
    try {
      await open("john");
      const s = await lee("john");
      expect((await s.call("search_labs")).isError).toBe(false);
      await h.fhir.update({ ...team, status: "inactive" });
      expect((await s.call("search_labs")).text).toContain(
        "REFUSED: not one of Dr. Lee's patients.",
      );
      await s.close();
    } finally {
      await fetch(`${h.config.fhirBaseUrl}/CareTeam/${team.id}`, { method: "DELETE" });
    }
  });

  it("a reading she proposes waits for her own passkey, then says who it was for", async () => {
    const s = await lee("maria");
    const p = await s.call("propose_observation", { measure: "blood_glucose", value: 118 });
    expect(p.isError).toBe(false);
    expect(p.text).toContain("Dr. Grace Lee must approve it with their passkey");
    const id = p.text.match(/apr_[0-9a-f-]{36}/)?.[0] ?? "";
    const [row] = await h.db.select().from(approvals).where(eq(approvals.id, id));
    expect(row).toMatchObject({ personId: "lee", approverPersonId: "lee" });
    expect(
      (row?.payload as { subject?: { reference?: string } } | undefined)?.subject?.reference,
    ).toBe("Patient/maria");

    // Her passkey approval (S5) is tested elsewhere; here the row is approved directly.
    await h.db
      .update(approvals)
      .set({ status: "approved", approvedAt: new Date() })
      .where(eq(approvals.id, id));
    const args = JSON.parse(p.text.match(/exactly: (\{.*\})/)?.[1] ?? "{}");
    const c = await s.call("commit_change", args);
    expect(c.isError).toBe(false);
    const ref = c.text.match(/Observation\/[A-Za-z0-9-]+/)?.[0] ?? "";
    const prov = await h.fhir.search(
      "Provenance",
      new URLSearchParams({ target: ref, _count: "1" }),
    );
    const agentsOf = (prov.entry?.[0]?.resource?.agent ?? []) as {
      onBehalfOf?: { reference?: string };
    }[];
    expect(agentsOf[0]?.onBehalfOf?.reference).toBe("Practitioner/lee");
    const obs = await h.fhir.read("Observation", ref.split("/")[1] ?? "");
    expect((obs?.subject as { reference?: string } | undefined)?.reference).toBe("Patient/maria");
    expect((await h.lastReceipt())?.sentence).toContain(
      "for Dr. Grace Lee (patient: Maria Elena Santos).",
    );
    await s.close();
  });

  it("checking the care team on every call costs little (the S10 prediction)", async () => {
    const coach = await h.connect("diabetes-coach", await h.pass("diabetes-coach", "maria"));
    const staff = await lee("maria");
    const time = async (s: typeof coach) => {
      const ms: number[] = [];
      for (let i = 0; i < 15; i++) {
        const t = performance.now();
        await s.call("list_conditions");
        ms.push(performance.now() - t);
      }
      return ms.sort((a, b) => a - b)[7] ?? 0;
    };
    await time(coach);
    const patient = await time(coach);
    const clinician = await time(staff);
    console.info(
      `S10 median list_conditions: patient ${patient.toFixed(1)} ms, staff ${clinician.toFixed(1)} ms`,
    );
    expect(clinician - patient).toBeLessThan(25);
    await coach.close();
    await staff.close();
  });
});
