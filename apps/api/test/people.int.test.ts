/**
 * S9: People at scale, against Postgres and HAPI. 5,000 synthetic people
 * are listed, searched and filtered fast; people are added from a record
 * picked at aipass's own FHIR server; only the person can say yes (D19);
 * one record belongs to one person; removing someone keeps their receipts.
 */
import {
  appendReceipt,
  createDb,
  DEMO,
  ensureAipassFhirServer,
  persons,
  runMigrations,
  seedDemo,
  users,
  vault,
} from "@aipass/db";
import { FhirClient } from "@aipass/fhir";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { createAuth } from "../src/auth.ts";
import { config } from "../src/config.ts";

const DB =
  process.env.PEOPLE_DATABASE_URL ?? "postgres://aipass:aipass@127.0.0.1:5433/aipass_people_test";
const FHIR = process.env.FHIR_BASE_URL ?? "http://127.0.0.1:8080/fhir";
const ORIGIN = config.publicUrl;
const CARLO = "Patient/b4900f5e-1c24-1150-fd26-6fbc83da8893";
const MANY = 5000;
/** Maria, John and Dr. Lee. */
const DEMO_PEOPLE = DEMO.persons.length;

let app: ReturnType<typeof createApp>;
let made: ReturnType<typeof createDb>;
let admin = "";
const timings: Record<string, number> = {};

const cookieOf = (res: Response) =>
  (res.headers.getSetCookie() ?? []).map((c) => c.split(";")[0]).join("; ");

async function call<T = Record<string, unknown>>(
  path: string,
  init: { method?: string; json?: unknown } = {},
): Promise<{ status: number; body: T }> {
  const res = await app.request(path, {
    method: init.method ?? (init.json ? "POST" : "GET"),
    headers: {
      cookie: admin,
      origin: ORIGIN,
      ...(init.json ? { "content-type": "application/json" } : {}),
    },
    body: init.json ? JSON.stringify(init.json) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

type ListBody = {
  total: number;
  items: { id: string; displayName: string; email: string | null; status: string }[];
};

/** Lists with a query, and records how long the api took. */
async function list(query: string): Promise<ListBody> {
  const started = performance.now();
  const r = await call<ListBody>(`/api/admin/persons?${query}`);
  timings[query || "(none)"] = Math.round(performance.now() - started);
  expect(r.status).toBe(200);
  return r.body;
}

beforeAll(async () => {
  const u = new URL(DB);
  const name = u.pathname.slice(1);
  u.pathname = "/postgres";
  const pg = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await pg.unsafe(`drop database if exists "${name}" with (force)`);
  await pg.unsafe(`create database "${name}"`);
  await pg.end();
  await runMigrations(DB);
  made = createDb(DB);
  await seedDemo(made.db);
  await ensureAipassFhirServer(made.db, { baseUrl: FHIR });
  // 5,000 synthetic people (records that exist only here: this measures the list).
  await made.client.unsafe(`
    insert into persons (id, display_name, fhir_ref, is_test, status)
    select 'bulk-' || n, 'Bulk Person ' || lpad(n::text, 4, '0'), 'Patient/bulk-' || n, true,
           case when n % 100 = 0 then 'suspended' else 'active' end
    from generate_series(1, ${MANY}) n`);
  await made.client.unsafe(`
    insert into grants (id, person_id, agent_id, permissions, status, set_by)
    select 'grt-bulk-' || n, 'bulk-' || n, 'diabetes-coach', '["labs:read"]', 'active', 'admin'
    from generate_series(1, ${MANY}, 7) n`);
  app = createApp({
    db: made.db,
    auth: createAuth(made.db),
    fhir: new FhirClient({ baseUrl: FHIR }),
  });
  admin = cookieOf(
    await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({
        name: "Ada",
        email: "admin@example.org",
        password: "a-long-password-1",
      }),
    }),
  );
});

afterAll(async () => {
  console.info(
    `S9 list timings (ms) over ${MANY + DEMO_PEOPLE} people: ${JSON.stringify(timings)}`,
  );
  await made?.close();
});

describe("S9: the people list at scale", () => {
  it("pages through everyone, 25 at a time, sorted by name", async () => {
    const first = await list("limit=25");
    expect(first.total).toBe(MANY + DEMO_PEOPLE);
    expect(first.items).toHaveLength(25);
    expect(first.items[0]?.displayName).toBe("Bulk Person 0001");
    const later = await list("limit=25&page=200");
    expect(later.items).toHaveLength(25);
    expect(later.items[0]?.displayName).toBe("Bulk Person 4976");
  });

  it("searches by name, and by record id", async () => {
    expect((await list("q=maria")).items.map((p) => p.id)).toEqual(["maria"]);
    expect((await list("q=Person%204242")).items.map((p) => p.id)).toEqual(["bulk-4242"]);
    expect((await list("q=bulk-1234")).total).toBe(1);
    // % and _ are just characters in a search.
    expect((await list("q=%25")).total).toBe(0);
  });

  it("filters by status, AI, login and test persons", async () => {
    expect((await list("status=suspended")).total).toBe(MANY / 100);
    expect((await list("agent=diabetes-coach")).total).toBe(Math.ceil(MANY / 7) + 2);
    expect((await list("login=yes")).total).toBe(0);
    expect((await list("test=no")).total).toBe(0);
    expect((await list("server=aipass")).total).toBe(MANY + DEMO_PEOPLE);
    expect((await list("server=some-ehr")).total).toBe(0);
  });

  it("sorts by most AIs and by last activity", async () => {
    expect((await list("sort=ais&limit=1")).items[0]?.id).toBe("maria");
    await appendReceipt(made.db, {
      agentId: "diabetes-coach",
      personId: "bulk-77",
      action: "read",
      decision: "allow",
      sentence: "Diabetes Coach read 1 lab result for Bulk Person 0077.",
      mode: "live",
    });
    expect((await list("sort=activity&limit=1")).items[0]?.id).toBe("bulk-77");
  });

  it("answers every list above in under 200 ms", () => {
    for (const [q, ms] of Object.entries(timings)) expect(ms, q).toBeLessThan(200);
  });
});

describe("S9: adding people from a record", () => {
  it("searches aipass's own FHIR server, and says who already has a record", async () => {
    const carlo = await call<{ items: { ref: string; name: string; takenBy: unknown }[] }>(
      "/api/admin/fhir-servers/aipass/patients?q=Carlo",
    );
    expect(carlo.status).toBe(200);
    expect(carlo.body.items.find((i) => i.ref === CARLO)).toMatchObject({
      name: "Carlo647 Kory651 Blanda868",
      takenBy: null,
    });
    const maria = await call<{ items: { ref: string; takenBy: { id: string } | null }[] }>(
      "/api/admin/fhir-servers/aipass/patients?q=Santos",
    );
    expect(maria.body.items.find((i) => i.ref === "Patient/maria")?.takenBy?.id).toBe("maria");
  });

  it("adds a person from the record, named as the record says, once", async () => {
    const r = await call<{ id: string; displayName: string; isTest: boolean }>(
      "/api/admin/persons",
      { json: { serverId: "aipass", ref: CARLO } },
    );
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ displayName: "Carlo647 Kory651 Blanda868", isTest: false });
    const again = await call("/api/admin/persons", { json: { serverId: "aipass", ref: CARLO } });
    expect(again.status).toBe(409);
    const missing = await call("/api/admin/persons", {
      json: { serverId: "aipass", ref: "Patient/no-such-patient" },
    });
    expect(missing.status).toBe(400);
  });

  it("one record at an EHR belongs to one person", async () => {
    await made.client.unsafe(
      `insert into fhir_servers (id, kind, name, base_url) values ('ehr', 'smart', 'EHR', 'https://ehr.example/fhir')`,
    );
    const row = (personId: string) => ({
      personId,
      serverId: "ehr",
      patientId: "same",
      tokensSealed: "x",
      expiresAt: new Date(),
    });
    await made.db.insert(vault).values(row("maria"));
    await expect(made.db.insert(vault).values(row("john"))).rejects.toThrow();
  });
});

describe("S9: only the person says yes (D19)", () => {
  it("the admin can't give a real person's consent, only revoke it", async () => {
    const carlo = (await list("q=Carlo")).items[0];
    expect(carlo).toBeDefined();
    const set = await call(`/api/admin/persons/${carlo?.id}/grants/diabetes-coach`, {
      method: "PUT",
      json: { permissions: ["labs:read"] },
    });
    expect(set.status).toBe(403);
    expect(String(set.body.error)).toContain("only Carlo647 can agree to this");
  });

  it("a test person's grant can be set, and says so", async () => {
    const r = await call(`/api/admin/persons/john/grants/scheduling-assistant`, {
      method: "PUT",
      json: { permissions: ["appointments:read"] },
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "active", setBy: "admin" });
    expect(
      (await call("/api/admin/persons/john/grants/scheduling-assistant/revoke", { json: {} }))
        .status,
    ).toBe(200);
    expect(
      (await call("/api/admin/persons/john/grants/scheduling-assistant/restore", { json: {} }))
        .status,
    ).toBe(200);
  });

  it("one person's detail has their records, login and grants", async () => {
    const r = await call<{
      records: { serverId: string; ref: string }[];
      grants: { agentId: string; setBy: string }[];
      login: unknown;
    }>("/api/admin/persons/maria");
    expect(r.status).toBe(200);
    expect(r.body.records[0]).toMatchObject({ serverId: "aipass", ref: "Patient/maria" });
    expect(r.body.records.map((x) => x.serverId)).toContain("ehr");
    expect(r.body.grants.map((g) => g.agentId).sort()).toEqual([
      "diabetes-coach",
      "scheduling-assistant",
    ]);
    expect(r.body.login).toBeNull();
  });
});

describe("S9: suspend and remove", () => {
  it("pauses and resumes a person", async () => {
    expect(
      (await call("/api/admin/persons/john", { method: "PATCH", json: { status: "suspended" } }))
        .body,
    ).toMatchObject({ status: "suspended" });
    expect(
      (await call("/api/admin/persons/john", { method: "PATCH", json: { status: "active" } })).body,
    ).toMatchObject({ status: "active" });
  });

  it("removing someone takes their login and grants, and keeps their receipts", async () => {
    expect(
      (
        await call("/api/admin/persons/bulk-77/login", {
          json: { email: "bulk77@example.org", password: "bulk-77-password" },
        })
      ).status,
    ).toBe(201);
    const [p] = await made.db.select().from(persons).where(eq(persons.id, "bulk-77"));
    const r = await call<{ receiptsKept: number }>("/api/admin/persons/bulk-77", {
      method: "DELETE",
    });
    expect(r.status).toBe(200);
    expect(r.body.receiptsKept).toBe(1);
    expect(await made.db.select().from(persons).where(eq(persons.id, "bulk-77"))).toEqual([]);
    expect(
      await made.db
        .select()
        .from(users)
        .where(eq(users.id, p?.userId ?? "")),
    ).toEqual([]);
  });
});
