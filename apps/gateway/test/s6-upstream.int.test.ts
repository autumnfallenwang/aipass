/**
 * S6: records from another FHIR server, over SMART. The SMART launcher
 * (`docker compose --profile smart up -d`) plays the EHR in front of the same
 * HAPI. Maria connects her record once; the gateway reads it for the coach
 * with the token from the vault, and the agent never sees that token.
 */
import { agents, approvals, fhirServers, receipts, seal, unseal, vault } from "@aipass/db";
import {
  AIPASS_SYSTEM,
  authorizeUrl,
  discoverSmart,
  exchangeCode,
  FhirClient,
  pkcePair,
  smartLauncherFhirUrl,
} from "@aipass/fhir";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredTokens } from "../src/upstream.ts";
import { createHarness, FHIR, type Harness } from "./harness.ts";

const LAUNCHER = process.env.SMART_LAUNCHER_URL ?? "http://localhost:8090";
const CLIENT = { id: "aipass", secret: "launcher-dev-secret" };
const BASE = smartLauncherFhirUrl({
  launcher: LAUNCHER,
  patient: "maria",
  clientId: CLIENT.id,
  clientSecret: CLIENT.secret,
});
const REDIRECT = "http://localhost:3000/api/person/fhir/callback";
const SCOPE =
  "launch/patient openid fhirUser offline_access patient/*.rs patient/Observation.c patient/Provenance.c";

/** Every request the gateway makes to another server, with the credential it carried. */
const upstreamCalls: { url: string; authorization: string | null }[] = [];
const watch: typeof fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  upstreamCalls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
  return fetch(input, init);
};

let h: Harness;
let tokens: StoredTokens;
const logs: string[] = [];
/** Every response header the gateway sent the agent. */
const headersSeen: string[] = [];

/** A standalone patient launch, as Maria's browser would do it (the launcher skips its login). */
async function launch(): Promise<{ tokens: StoredTokens; patient: string }> {
  const ep = await discoverSmart(BASE);
  const { verifier, challenge } = pkcePair();
  const res = await fetch(
    authorizeUrl({
      ...ep,
      clientId: CLIENT.id,
      redirectUri: REDIRECT,
      scope: SCOPE,
      state: "test",
      codeChallenge: challenge,
      aud: BASE,
    }),
    { redirect: "manual" },
  );
  const code = new URL(res.headers.get("location") ?? "").searchParams.get("code") ?? "";
  const t = await exchangeCode(
    { tokenUrl: ep.tokenUrl, clientId: CLIENT.id, clientSecret: CLIENT.secret },
    { code, redirectUri: REDIRECT, codeVerifier: verifier },
  );
  return {
    tokens: { access_token: t.access_token, refresh_token: t.refresh_token, scope: t.scope },
    patient: t.patient ?? "",
  };
}

async function connectMaria(over: { expiresAt?: Date; tokens?: StoredTokens } = {}) {
  const got = await launch();
  tokens = over.tokens ?? got.tokens;
  await h.db
    .insert(vault)
    .values({
      personId: "maria",
      serverId: "sunrise-ehr",
      patientId: got.patient,
      tokensSealed: seal(h.config.vaultKey, JSON.stringify(tokens), "maria|sunrise-ehr"),
      expiresAt: over.expiresAt ?? new Date(Date.now() + 300_000),
    })
    .onConflictDoNothing();
}

/** The records an AuditEvent names on the EHR (by server id, not URL). */
async function auditedUrls(auditEventId: string | null | undefined): Promise<string[]> {
  const ae = (await h.fhir.read("AuditEvent", auditEventId ?? "")) as unknown as {
    entity?: { what?: { identifier?: { system?: string; value?: string } } }[];
  } | null;
  return (ae?.entity ?? [])
    .map((e) => e.what?.identifier)
    .filter((i) => i?.system === `${AIPASS_SYSTEM}/fhir-server/sunrise-ehr`)
    .map((i) => i?.value ?? "");
}

/** Must never leave: the tokens, the client secret, and the launcher's settings (they hold it too). */
function secrets(): string[] {
  const settings = BASE.split("/sim/")[1]?.split("/")[0] ?? "";
  return [tokens.access_token, tokens.refresh_token ?? "", CLIENT.secret, settings].filter(Boolean);
}

beforeAll(async () => {
  h = await createHarness({
    upstreamFetch: watch,
    onResponse: (res) => {
      for (const [k, v] of res.headers) headersSeen.push(`${k}: ${v}`);
    },
  });
  for (const level of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
  }
});
afterAll(async () => {
  vi.restoreAllMocks();
  await h?.close();
});
beforeEach(async () => {
  await h.reset();
  await h.db.delete(vault);
  await h.db.delete(fhirServers);
  const ep = await discoverSmart(BASE);
  await h.db.insert(fhirServers).values({
    id: "sunrise-ehr",
    name: "Sunrise EHR",
    baseUrl: BASE,
    ...ep,
    clientId: CLIENT.id,
    clientSecretSealed: seal(h.config.vaultKey, CLIENT.secret, "server|sunrise-ehr"),
    scope: SCOPE,
  });
  await h.db
    .update(agents)
    .set({ fhirServerId: "sunrise-ehr" })
    .where(eq(agents.id, "diabetes-coach"));
  upstreamCalls.length = 0;
});

describe("S6: a SMART upstream", () => {
  it("reads Maria's labs from the EHR with her vaulted token, under the same rules", async () => {
    await connectMaria();
    const s = await h.connect("diabetes-coach", await h.pass("diabetes-coach", "maria"));
    const r = await s.call("search_labs", { code: "4548-4" });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain("Hemoglobin A1c");
    expect(r.text).toContain("6.9 %");

    // Every call went to the EHR, with Maria's token, and nowhere else.
    expect(upstreamCalls.length).toBeGreaterThan(0);
    for (const c of upstreamCalls) {
      expect(c.url.startsWith(BASE)).toBe(true);
      expect(c.authorization).toBe(`Bearer ${tokens.access_token}`);
    }
    // The audit trail names the records as the EHR's, by server id.
    const receipt = await h.lastReceipt();
    expect(receipt?.decision).toBe("allow");
    const named = await auditedUrls(receipt?.auditEventId);
    expect(named.length).toBeGreaterThan(0);
    expect(named.every((u) => u.startsWith("Observation/"))).toBe(true);

    // Labels still lock: the therapy note never leaves, even from the EHR.
    const notes = await s.call("get_notes");
    expect(notes.text).not.toContain("Therapy session");
    expect(notes.text).toContain("mental-health records are always private");
    await s.close();
  });

  it("pins the patient from the launch: John's note is refused even though the EHR would return it", async () => {
    await connectMaria();
    const s = await h.connect("diabetes-coach", await h.pass("diabetes-coach", "maria"));
    const r = await s.call("get_notes", { id: "john-note-1" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("REFUSED");
    expect((await h.lastReceipt())?.rule).toBe(5);
    await s.close();
  });

  it("refuses when Maria hasn't connected her record there", async () => {
    const s = await h.connect("diabetes-coach", await h.pass("diabetes-coach", "maria"));
    const r = await s.call("search_labs");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("REFUSED: Maria hasn't connected a record at Sunrise EHR.");
    expect(upstreamCalls).toHaveLength(0);
    await s.close();
  });

  it("refreshes an expired token, and stores the new one sealed", async () => {
    await connectMaria({ expiresAt: new Date(Date.now() - 1000) });
    const before = tokens.access_token;
    const s = await h.connect("diabetes-coach", await h.pass("diabetes-coach", "maria"));
    const r = await s.call("search_labs");
    expect(r.isError, r.text).toBe(false);
    expect(upstreamCalls.some((c) => c.url.includes("/token"))).toBe(true);
    const [row] = await h.db.select().from(vault).where(eq(vault.personId, "maria"));
    const now = JSON.parse(unseal(h.config.vaultKey, row?.tokensSealed ?? "", "maria|sunrise-ehr"));
    expect(now.access_token).not.toBe(before);
    expect(row?.tokensSealed).not.toContain(now.access_token);
    expect(row?.expiresAt.getTime()).toBeGreaterThan(Date.now());
    tokens = now;
    await s.close();
  });

  it("refuses, and asks Maria to reconnect, when the refresh fails", async () => {
    const got = await launch();
    await connectMaria({
      expiresAt: new Date(Date.now() - 1000),
      tokens: { ...got.tokens, refresh_token: "not-a-refresh-token" },
    });
    const s = await h.connect("diabetes-coach", await h.pass("diabetes-coach", "maria"));
    const r = await s.call("search_labs");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("the connection to Sunrise EHR expired; Maria needs to reconnect");
    await s.close();
  });

  it("won't open a vault entry that was moved to someone else", async () => {
    await connectMaria();
    const [row] = await h.db.select().from(vault).where(eq(vault.personId, "maria"));
    // The same record can't be John's too (S9: one record, one person)…
    await expect(
      h.db.insert(vault).values({ ...(row as typeof vault.$inferInsert), personId: "john" }),
    ).rejects.toThrow();
    // …and Maria's sealed tokens, copied to a row of John's, don't open there.
    await h.db.insert(vault).values({
      ...(row as typeof vault.$inferInsert),
      personId: "john",
      patientId: "john-at-the-ehr",
    });
    const s = await h.connect("diabetes-coach", await h.pass("diabetes-coach", "john"));
    const r = await s.call("search_labs");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("REFUSED: the stored connection couldn't be opened");
    expect(upstreamCalls.filter((c) => c.authorization)).toHaveLength(0);
    await s.close();
  });

  it("refuses when the admin switches the server off", async () => {
    await connectMaria();
    await h.db.update(fhirServers).set({ enabled: false });
    const s = await h.connect("diabetes-coach", await h.pass("diabetes-coach", "maria"));
    const r = await s.call("search_labs");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("switched off");
    await s.close();
  });

  it("writes an approved reading to the EHR, with Provenance naming the AI by identifier", async () => {
    await connectMaria();
    const s = await h.connect("diabetes-coach", await h.pass("diabetes-coach", "maria"));
    const p = await s.call("propose_observation", { measure: "blood_glucose", value: 131 });
    expect(p.isError, p.text).toBe(false);
    const args = JSON.parse(p.text.match(/with exactly: (\{.*\})/)?.[1] ?? "null");
    // The passkey step is tested end to end elsewhere (S5 A1–A8).
    await h.db
      .update(approvals)
      .set({ status: "approved", approvedAt: new Date() })
      .where(eq(approvals.id, args.approval_id));
    const c = await s.call("commit_change", args);
    expect(c.isError, c.text).toBe(false);
    const [rec] = await h.db
      .select()
      .from(receipts)
      .where(and(eq(receipts.tool, "commit_change"), eq(receipts.decision, "allow")))
      .orderBy(desc(receipts.seq))
      .limit(1);
    const [written = ""] = await auditedUrls(rec?.auditEventId);
    expect(written.startsWith("Observation/")).toBe(true);
    // The agent is told what was written, never where the EHR lives.
    expect(c.text).toContain(`(${written})`);
    expect(c.text).not.toContain(LAUNCHER);

    const home = new FhirClient({ baseUrl: FHIR });
    const id = written.split("/").pop() ?? "";
    const prov = await home.search(
      "Provenance",
      new URLSearchParams({ target: `Observation/${id}` }),
    );
    const agent = (
      prov.entry?.[0]?.resource as { agent?: { who: unknown; onBehalfOf?: unknown }[] }
    )?.agent?.[0];
    expect(agent?.who).toMatchObject({ identifier: { value: "diabetes-coach" } });
    expect(agent?.onBehalfOf).toMatchObject({ reference: "Patient/maria" });
    for (const e of prov.entry ?? []) {
      await fetch(`${FHIR}/Provenance/${e.resource?.id}`, { method: "DELETE" });
    }
    await fetch(`${FHIR}/Observation/${id}`, { method: "DELETE" });
    await s.close();
  });

  it("never lets an upstream token or the client secret out: tool results, headers, receipts, audit, logs", async () => {
    const since = new Date(Date.now() - 2000).toISOString();
    await connectMaria({ expiresAt: new Date(Date.now() - 1000) });
    const s = await h.connect("diabetes-coach", await h.pass("diabetes-coach", "maria"));
    const outputs: string[] = [];
    for (const [tool, args] of [
      ["search_labs", {}],
      ["get_patient_summary", {}],
      ["get_notes", {}],
      ["get_notes", { id: "john-note-1" }],
      ["list_conditions", {}],
    ] as const) {
      outputs.push((await s.call(tool, args)).text);
    }
    // the refresh above replaced the tokens; check both generations
    const [row] = await h.db.select().from(vault).where(eq(vault.personId, "maria"));
    const fresh = JSON.parse(
      unseal(h.config.vaultKey, row?.tokensSealed ?? "", "maria|sunrise-ehr"),
    );
    const all = [...secrets(), fresh.access_token, fresh.refresh_token].filter(Boolean);
    const rows = await h.db.select().from(receipts);
    const ae = await new FhirClient({ baseUrl: FHIR }).search(
      "AuditEvent",
      new URLSearchParams({ date: `ge${since}`, _count: "100" }),
    );
    const haystack = [
      ...outputs,
      ...headersSeen,
      JSON.stringify(rows),
      JSON.stringify(ae),
      ...logs,
    ].join("\n");
    expect(headersSeen.length).toBeGreaterThan(0);
    expect(ae.entry?.length ?? 0).toBeGreaterThanOrEqual(outputs.length);
    expect(rows.length).toBeGreaterThanOrEqual(outputs.length);
    for (const secret of all) expect(haystack).not.toContain(secret);
    await s.close();
  });
});
