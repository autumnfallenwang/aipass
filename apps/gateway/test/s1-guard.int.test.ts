/**
 * S1 validation table, row by row, against real Postgres and HAPI FHIR.
 * See docs/PLAN.md § S1.
 */
import { agents, grants, receipts, verifyReceiptChain } from "@aipass/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, GATEWAY, type Harness } from "./harness.ts";

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.close();
});
beforeEach(async () => {
  await h.reset();
});

async function auditEventFor(receiptId: string) {
  const [r] = await h.db.select().from(receipts).where(eq(receipts.id, receiptId));
  expect(r?.auditEventId).toBeTruthy();
  const ae = await h.fhir.read("AuditEvent", r?.auditEventId ?? "");
  expect(ae).not.toBeNull();
  return ae as unknown as {
    outcome: string;
    outcomeDesc: string;
    agent: { who: { reference: string }; requestor: boolean; policy?: string[] }[];
  };
}

describe("S1: the guard, read-only", () => {
  it("Coach → Maria's labs: ALLOW, with a receipt and an AuditEvent", async () => {
    const s = await h.connect("diabetes-coach", await h.pass("diabetes-coach", "maria"));
    const r = await s.call("search_labs", { code: "4548-4" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Hemoglobin A1c");
    expect(r.text).toContain("6.9 %");
    expect(r.text).not.toContain("Patient/john");

    const receipt = await h.lastReceipt();
    expect(receipt).toMatchObject({
      decision: "allow",
      agentId: "diabetes-coach",
      personId: "maria",
    });
    expect(receipt?.sentence).toBe("Diabetes Coach read 3 lab results for Maria Santos.");
    const ae = await auditEventFor(receipt?.id ?? "");
    expect(ae.outcome).toBe("0");
    await s.close();
  });

  it("Coach → Maria's therapy note (PSY): REFUSE 'mental-health records are always private'", async () => {
    const s = await h.connect("diabetes-coach", await h.pass("diabetes-coach", "maria"));
    const r = await s.call("get_notes", { id: "maria-note-therapy" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("REFUSED: mental-health records are always private.");
    expect(r.text).not.toContain("Therapy session");
    expect((await h.lastReceipt())?.rule).toBe(6);

    // Listing notes shows the visit note, never the therapy note.
    const list = await s.call("get_notes");
    expect(list.text).toContain("Diabetes follow-up visit note");
    expect(list.text).not.toContain("Therapy session");
    expect(list.text).not.toContain("SYNTHETIC TEST DATA");
    expect(list.text).toContain(
      "1 record(s) were withheld: mental-health records are always private",
    );
    await s.close();
  });

  it("Coach → Maria's conditions: depression and alcohol history are withheld", async () => {
    const s = await h.connect("diabetes-coach", await h.pass("diabetes-coach", "maria"));
    const r = await s.call("list_conditions");
    expect(r.text).toContain("Type 2 diabetes");
    expect(r.text).toContain("High blood pressure");
    expect(r.text).not.toContain("Depression");
    expect(r.text).not.toContain("Alcohol");
    expect(r.text).toContain("mental-health records are always private");
    expect(r.text).toContain("substance-use records are always private");
    const meds = await s.call("list_medications");
    expect(meds.text).toContain("Metformin");
    expect(meds.text).not.toContain("Sertraline");
    await s.close();
  });

  it("Scheduling → Maria's labs: REFUSE 'not in the Scheduling Assistant role'", async () => {
    const s = await h.connect(
      "scheduling-assistant",
      await h.pass("scheduling-assistant", "maria"),
    );
    const r = await s.call("search_labs");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("REFUSED: not in the Scheduling Assistant role.");
    expect((await h.lastReceipt())?.rule).toBe(3);
    await s.close();
  });

  it("Scheduling → Maria's patient summary: ALLOW, name + phone only", async () => {
    const s = await h.connect(
      "scheduling-assistant",
      await h.pass("scheduling-assistant", "maria"),
    );
    const r = await s.call("get_patient_summary");
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Maria Elena Santos");
    expect(r.text).toContain("555-0142");
    for (const hidden of [
      "1972-03-14",
      "maria.santos@example.org",
      "Harbor View",
      "SC-100234",
      "female",
    ]) {
      expect(r.text).not.toContain(hidden);
    }
    // and the appointments, minus the PSY-labelled therapy session
    const appts = await s.call("list_appointments");
    expect(appts.text).toContain("Diabetes follow-up");
    expect(appts.text).toContain("Diabetic eye exam");
    expect(appts.text).not.toContain("Therapy");
    await s.close();
  });

  it("Coach → John's record with a pass for Maria: REFUSE 'not Maria's record'", async () => {
    const s = await h.connect("diabetes-coach", await h.pass("diabetes-coach", "maria"));
    const direct = await s.call("get_notes", { id: "john-note-1" });
    expect(direct.isError).toBe(true);
    expect(direct.text).toContain("REFUSED: not Maria's record.");
    expect(direct.text).not.toContain("Annual physical");
    await s.close();

    // A pass whose patient pin disagrees with its person is not honoured either.
    const forged = await h.pass("diabetes-coach", "maria", { claims: { patient: "john" } });
    const s2 = await h.connect("diabetes-coach", forged);
    const r = await s2.call("search_labs");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("REFUSED: not Maria's record.");
    expect(r.text).not.toContain("9.4");
    await s2.close();
  });

  it("Coach stopped, then calls again: REFUSE 'agent stopped by admin' on the next call", async () => {
    const s = await h.connect("diabetes-coach", await h.pass("diabetes-coach", "maria"));
    expect((await s.call("search_labs")).isError).toBe(false);
    await h.db.update(agents).set({ status: "stopped" }).where(eq(agents.id, "diabetes-coach"));
    const r = await s.call("search_labs");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("REFUSED: agent stopped by admin.");
    expect((await h.lastReceipt())?.rule).toBe(2);
    await s.close();
  });

  it("Grant revoked, then calls again: REFUSE 'Maria hasn't agreed'", async () => {
    const s = await h.connect("diabetes-coach", await h.pass("diabetes-coach", "maria"));
    expect((await s.call("search_vitals")).isError).toBe(false);
    await h.db
      .update(grants)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(and(eq(grants.personId, "maria"), eq(grants.agentId, "diabetes-coach")));
    const r = await s.call("search_vitals");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("REFUSED: Maria hasn't agreed to vital signs.");
    expect((await h.lastReceipt())?.rule).toBe(4);
    await s.close();
  });

  it("Grant without vitals: REFUSE 'Maria hasn't agreed to vital signs'; labs still work", async () => {
    await h.db
      .update(grants)
      .set({ permissions: ["labs:read"] })
      .where(and(eq(grants.personId, "maria"), eq(grants.agentId, "diabetes-coach")));
    const s = await h.connect("diabetes-coach", await h.pass("diabetes-coach", "maria"));
    expect((await s.call("search_vitals")).text).toContain(
      "REFUSED: Maria hasn't agreed to vital signs.",
    );
    expect((await s.call("search_labs")).isError).toBe(false);
    await s.close();
  });

  describe("expired / wrong-aud / tampered / missing pass: 401 + PRM pointer", () => {
    const url = `${GATEWAY}/agents/diabetes-coach/mcp`;
    const prm = `${GATEWAY}/.well-known/oauth-protected-resource/agents/diabetes-coach/mcp`;
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

    async function post(auth?: string) {
      return h.appFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(auth ? { authorization: auth } : {}),
        },
        body,
      });
    }

    const cases: [string, () => Promise<string | undefined>, string][] = [
      ["missing", async () => undefined, "missing"],
      ["not a bearer token", async () => "Basic abc", "malformed"],
      [
        "expired",
        async () =>
          `Bearer ${await h.pass("diabetes-coach", "maria", { iat: Math.floor(Date.now() / 1000) - 600 })}`,
        "expired",
      ],
      [
        "wrong audience (another agent's door)",
        async () =>
          `Bearer ${await h.pass("diabetes-coach", "maria", { claims: { aud: `${GATEWAY}/agents/scheduling-assistant/mcp` } })}`,
        "wrong audience",
      ],
      [
        "pass for a different agent",
        async () =>
          `Bearer ${await h.pass("scheduling-assistant", "maria", { claims: { aud: url } })}`,
        "issued to a different agent",
      ],
      [
        "signed by an unknown key",
        async () => `Bearer ${await h.pass("diabetes-coach", "maria", { key: h.wrongKey })}`,
        "bad signature",
      ],
      [
        "tampered payload",
        async () => {
          const t = await h.pass("diabetes-coach", "maria");
          const [hd, , sig] = t.split(".");
          const original = JSON.parse(Buffer.from(t.split(".")[1] ?? "", "base64url").toString());
          const payload = Buffer.from(JSON.stringify({ ...original, patient: "john" })).toString(
            "base64url",
          );
          return `Bearer ${hd}.${payload}.${sig}`;
        },
        "bad signature",
      ],
      [
        "untrusted issuer",
        async () =>
          `Bearer ${await h.pass("diabetes-coach", "maria", { claims: { iss: "https://evil.example" } })}`,
        "untrusted issuer",
      ],
      [
        "lives longer than 5 minutes",
        async () => `Bearer ${await h.pass("diabetes-coach", "maria", { ttl: 3600 })}`,
        "lifetime too long",
      ],
      [
        "no actor",
        async () =>
          `Bearer ${await h.pass("diabetes-coach", "maria", { claims: { act: undefined } })}`,
        "missing claims",
      ],
    ];

    it.each(cases)("%s", async (_name, auth, error) => {
      const res = await post(await auth());
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain(`resource_metadata="${prm}"`);
      expect(((await res.json()) as { error_description: string }).error_description).toBe(error);
      const r = await h.lastReceipt();
      expect(r).toMatchObject({ decision: "refuse", rule: 1, code: "pass_invalid" });
      expect(r?.reason).toBe(`no valid pass (${error})`);
    });

    it("serves the Protected Resource Metadata it points to", async () => {
      const res = await h.appFetch(prm);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        resource: url,
        authorization_servers: h.config.authorizationServers,
      });
    });

    it("404s for an agent that doesn't exist", async () => {
      const res = await h.appFetch(`${GATEWAY}/agents/nobody/mcp`, { method: "POST", body });
      expect(res.status).toBe(404);
    });
  });

  it("_include / $everything style arguments are refused before reaching FHIR", async () => {
    const s = await h.connect("diabetes-coach", await h.pass("diabetes-coach", "maria"));
    for (const args of [
      { code: "4548-4&_include=*" },
      { code: "4548-4", _include: "Observation:patient" },
      { since: "2020-01-01&_revinclude=*" },
    ]) {
      const r = await s.call("search_labs", args);
      expect(r.isError).toBe(true);
      expect(r.text).not.toContain("Hemoglobin");
    }
    const notes = await s.call("get_notes", { id: "maria/$everything" });
    expect(notes.isError).toBe(true);
    await s.close();
  });

  it("paging keeps the filter, and a page token can't be edited or moved", async () => {
    const s = await h.connect("diabetes-coach", await h.pass("diabetes-coach", "maria"));
    const first = await s.call("search_labs", { limit: 2 });
    const token = first.text.match(/next_page: (\S+)/)?.[1];
    expect(token).toBeTruthy();
    const second = await s.call("search_labs", { next_page: token });
    expect(second.isError).toBe(false);
    expect(second.text).toContain("Observation/maria-");

    const tampered = `${token?.slice(0, -4)}AAAA`;
    expect((await s.call("search_labs", { next_page: tampered })).isError).toBe(true);
    // the same token presented for another group is refused
    expect((await s.call("search_vitals", { next_page: token })).isError).toBe(true);
    await s.close();
  });

  it("every refused call has a receipt and an AuditEvent naming both the AI and Maria", async () => {
    const s = await h.connect(
      "scheduling-assistant",
      await h.pass("scheduling-assistant", "maria"),
    );
    await s.call("search_labs");
    const r = await h.lastReceipt();
    expect(r?.decision).toBe("refuse");
    const ae = await auditEventFor(r?.id ?? "");
    expect(ae.outcome).toBe("4");
    expect(ae.outcomeDesc).toBe(
      "REFUSED: Scheduling Assistant tried to read Maria Santos's lab results: not in the Scheduling Assistant role.",
    );
    expect(ae.agent[0]?.who.reference).toBe("Device/aipass-agent-scheduling-assistant");
    expect(ae.agent[0]?.requestor).toBe(false);
    expect(ae.agent[0]?.policy?.[0]).toMatch(/^urn:aipass:pass:/);
    expect(ae.agent[1]?.who.reference).toBe("Patient/maria");
    expect(ae.agent[1]?.requestor).toBe(true);
    await s.close();
  });

  it("the receipt chain verifies", async () => {
    const s = await h.connect("diabetes-coach", await h.pass("diabetes-coach", "maria"));
    await s.call("search_labs");
    await s.call("get_notes", { id: "maria-note-therapy" });
    await s.close();
    expect(await verifyReceiptChain(h.db)).toBeNull();
  });

  it("an edited receipt, or a removed one, breaks the chain at that point", async () => {
    const s = await h.connect("diabetes-coach", await h.pass("diabetes-coach", "maria"));
    await s.call("search_labs");
    await s.call("get_notes", { id: "maria-note-therapy" });
    await s.call("list_conditions");
    await s.close();
    const rows = await h.db.select().from(receipts).orderBy(receipts.seq);
    const [, second, third] = rows.slice(-3);
    // someone softens a refusal after the fact
    await h.db
      .update(receipts)
      .set({ sentence: "Diabetes Coach read 1 visit note for Maria Santos." })
      .where(eq(receipts.id, second?.id ?? ""));
    expect(await verifyReceiptChain(h.db)).toBe(second?.id);
    // put it back, then remove one instead
    await h.db
      .update(receipts)
      .set({ sentence: second?.sentence ?? "" })
      .where(eq(receipts.id, second?.id ?? ""));
    expect(await verifyReceiptChain(h.db)).toBeNull();
    await h.db.delete(receipts).where(eq(receipts.id, second?.id ?? ""));
    expect(await verifyReceiptChain(h.db)).toBe(third?.id);
    // and restore it, so the test database's chain stays whole
    if (second) await h.db.insert(receipts).values(second);
    expect(await verifyReceiptChain(h.db)).toBeNull();
  });

  it("speaks MCP 2025-11-25 too (stateless fallback)", async () => {
    const res = await h.appFetch(`${GATEWAY}/agents/diabetes-coach/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25",
        authorization: `Bearer ${await h.pass("diabetes-coach", "maria")}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "search_labs", arguments: { code: "4548-4", limit: 1 } },
      }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Hemoglobin A1c");
  });
});
