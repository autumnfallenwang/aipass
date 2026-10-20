/**
 * The admin API is for admins only: signed-out callers get 401, people get 403.
 */
import { createDb, receipts, runMigrations, seedDemo } from "@aipass/db";
import { FhirClient } from "@aipass/fhir";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { createAuth } from "../src/auth.ts";

const URL_ =
  process.env.TEST_DATABASE_URL ?? "postgres://aipass:aipass@127.0.0.1:5433/aipass_api_test";
const ORIGIN = "http://localhost:3000";

async function fresh(url: string) {
  const u = new URL(url);
  const name = u.pathname.slice(1);
  u.pathname = "/postgres";
  const admin = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await admin.unsafe(`drop database if exists "${name}" with (force)`);
  await admin.unsafe(`create database "${name}"`);
  await admin.end();
}

let app: ReturnType<typeof createApp>;
let close: () => Promise<void>;
let db: ReturnType<typeof createDb>["db"];

beforeAll(async () => {
  await fresh(URL_);
  await runMigrations(URL_);
  const made = createDb(URL_);
  db = made.db;
  close = made.close;
  await seedDemo(db);
  app = createApp({
    db,
    auth: createAuth(db),
    fhir: new FhirClient({ baseUrl: process.env.FHIR_BASE_URL ?? "http://127.0.0.1:8080/fhir" }),
  });
});
afterAll(async () => close?.());

async function signUp(email: string): Promise<string> {
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ name: email, email, password: "a-long-password-1" }),
  });
  expect(res.status).toBe(200);
  return (res.headers.getSetCookie() ?? []).map((c) => c.split(";")[0]).join("; ");
}

describe("admin API access", () => {
  it("needs an admin before the first sign-up, and makes that first account the admin", async () => {
    expect(await (await app.request("/api/setup")).json()).toEqual({ needsAdmin: true });
    const admin = await signUp("admin@example.org");
    expect(await (await app.request("/api/setup")).json()).toEqual({ needsAdmin: false });
    const me = await app.request("/api/me", { headers: { cookie: admin } });
    expect(await me.json()).toMatchObject({ role: "admin" });
    const agents = await app.request("/api/admin/agents", { headers: { cookie: admin } });
    expect(agents.status).toBe(200);
  });

  it("refuses signed-out callers with 401", async () => {
    for (const path of ["/api/admin/agents", "/api/admin/roles", "/api/admin/receipts"]) {
      expect((await app.request(path)).status).toBe(401);
    }
    const stop = await app.request("/api/admin/agents/diabetes-coach/stop", { method: "POST" });
    expect(stop.status).toBe(401);
  });

  it("refuses a second (person) account with 403, so a patient can't stop agents or edit roles", async () => {
    const person = await signUp("maria@example.org");
    const me = await app.request("/api/me", { headers: { cookie: person } });
    expect(await me.json()).toMatchObject({ role: "person" });
    const stop = await app.request("/api/admin/agents/diabetes-coach/stop", {
      method: "POST",
      headers: { cookie: person, origin: ORIGIN },
    });
    expect(stop.status).toBe(403);
    expect((await app.request("/api/admin/receipts", { headers: { cookie: person } })).status).toBe(
      403,
    );
  });

  it("rejects bad role bodies (unknown fields, duplicate groups, unknown patient fields)", async () => {
    const cookie = await signInAdmin();
    const bad = [
      { name: "X", rules: [], patientFields: [], extra: true },
      {
        name: "X",
        rules: [
          { group: "labs", read: true, propose: false, write: false },
          { group: "labs", read: true, propose: false, write: false },
        ],
        patientFields: [],
      },
      { name: "X", rules: [], patientFields: ["ssn"] },
      {
        name: "X",
        rules: [{ group: "billing", read: true, propose: false, write: false }],
        patientFields: [],
      },
    ];
    for (const body of bad) {
      const res = await app.request("/api/admin/roles", {
        method: "POST",
        headers: { cookie, "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
  });

  it("writes no receipts for admin actions on the agent activity log", async () => {
    const rows = await db.select().from(receipts);
    expect(rows).toHaveLength(0);
  });
});

async function signInAdmin(): Promise<string> {
  const res = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ email: "admin@example.org", password: "a-long-password-1" }),
  });
  return (res.headers.getSetCookie() ?? []).map((c) => c.split(";")[0]).join("; ");
}
