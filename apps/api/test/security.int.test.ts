/** S7: fixes from the ASVS Level 2 self-check, against real Postgres. */
import { approvals, createDb, newId, runMigrations, seedDemo } from "@aipass/db";
import { FhirClient } from "@aipass/fhir";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.ts";
import { createAuth } from "../src/auth.ts";
import { config } from "../src/config.ts";

const DB =
  process.env.SECURITY_DATABASE_URL ??
  "postgres://aipass:aipass@127.0.0.1:5433/aipass_security_test";
const ORIGIN = config.publicUrl;
let app: ReturnType<typeof createApp>;
let made: ReturnType<typeof createDb>;
let admin = "";
let maria = "";
let john = "";
let approvalId = "";
const logs: string[] = [];

const cookieOf = (res: Response) =>
  (res.headers.getSetCookie() ?? []).map((c) => c.split(";")[0]).join("; ");

function req(
  path: string,
  init: { method?: string; cookie?: string; origin?: string | null; json?: unknown } = {},
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.origin !== null) headers.origin = init.origin ?? ORIGIN;
  return app.request(path, {
    method: init.method ?? (init.json === undefined ? "GET" : "POST"),
    headers,
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
}

async function signIn(email: string, password: string) {
  return cookieOf(await req("/api/auth/sign-in/email", { json: { email, password } }));
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
  app = createApp({
    db: made.db,
    auth: createAuth(made.db),
    fhir: new FhirClient({ baseUrl: "http://127.0.0.1:8080/fhir" }),
  });
  vi.spyOn(console, "info").mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  });
  admin = cookieOf(
    await req("/api/auth/sign-up/email", {
      json: { name: "Ada", email: "admin@example.org", password: "a-long-password-1" },
    }),
  );
  for (const [id, email] of [
    ["maria", "maria@example.org"],
    ["john", "john@example.org"],
  ] as const) {
    expect(
      (
        await req(`/api/admin/persons/${id}/login`, {
          cookie: admin,
          json: { email, password: `${id}-password-1` },
        })
      ).status,
    ).toBe(201);
  }
  maria = await signIn("maria@example.org", "maria-password-1");
  john = await signIn("john@example.org", "john-password-1");
  approvalId = newId("apr");
  await made.db.insert(approvals).values({
    id: approvalId,
    agentId: "diabetes-coach",
    personId: "maria",
    approverPersonId: "maria",
    action: "create",
    group: "labs",
    resourceType: "Observation",
    payload: { resourceType: "Observation", valueQuantity: { value: 130 } },
    payloadHash: "abc",
    summary: "Blood glucose 130 mg/dL",
    nonce: "n",
    status: "pending",
    expiresAt: new Date(Date.now() + 600_000),
  });
}, 60_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await made?.close();
});

describe("ASVS L2 fixes", () => {
  it("refuses a state change from another site (CSRF), even with the admin's cookie", async () => {
    const evil = await req("/api/admin/agents/diabetes-coach/stop", {
      cookie: admin,
      origin: "https://evil.example",
      json: {},
    });
    expect(evil.status).toBe(403);
    const sibling = await app.request("/api/person/ais/diabetes-coach/revoke", {
      method: "POST",
      headers: { cookie: maria, "sec-fetch-site": "same-site" },
    });
    expect(sibling.status).toBe(403);
    // the same request from aipass's own origin goes through
    const ok = await req("/api/admin/agents/diabetes-coach/stop", { cookie: admin, json: {} });
    expect(ok.status).toBe(200);
    await req("/api/admin/agents/diabetes-coach/resume", { cookie: admin, json: {} });
  });

  it("shows an approval only to its person and approver; others learn who may approve, nothing else", async () => {
    const mine = await req(`/api/person/approvals/${approvalId}`, { cookie: maria });
    expect(mine.status).toBe(200);
    const theirs = await req(`/api/person/approvals/${approvalId}`, { cookie: john });
    expect(theirs.status).toBe(403);
    const body = await theirs.text();
    expect(body).toContain("Only Maria Santos can approve this.");
    expect(body).not.toContain("130");
    expect(body).not.toContain("Blood glucose");
  });

  it("lets only the admin manage SSO providers", async () => {
    const register = {
      providerId: "squatted",
      issuer: "https://login.example",
      domain: "x.example",
    };
    expect((await req("/api/auth/sso/register", { cookie: maria, json: register })).status).toBe(
      403,
    );
    expect((await req("/api/auth/sso/providers", { cookie: maria })).status).toBe(403);
    expect((await req("/api/auth/sso/register", { json: register })).status).toBe(403);
  });

  it("logs sign-ins and admin changes as JSON lines, with no emails or passwords", async () => {
    logs.length = 0;
    await req("/api/auth/sign-in/email", {
      json: { email: "maria@example.org", password: "wrong-password-0" },
    });
    await req("/api/admin/agents/diabetes-coach", {
      method: "PATCH",
      cookie: admin,
      json: { description: "x" },
    });
    const events = logs.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
    expect(events).toContainEqual(
      expect.objectContaining({ event: "auth", path: "/sign-in/email", outcome: "failed" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "admin_change",
        method: "PATCH",
        path: "/api/admin/agents/diabetes-coach",
        status: 200,
      }),
    );
    const all = logs.join("\n");
    expect(all).not.toContain("maria@example.org");
    expect(all).not.toContain("wrong-password-0");
  });
});
