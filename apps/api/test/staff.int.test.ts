/**
 * S10: a staff member's side of the api, against Postgres and HAPI (D21). Her
 * care team is read from aipass's own FHIR server; she can open only a patient
 * in it; and every pass the agent gets for her names that patient.
 * Dr. Lee's care team is in fixtures/staff/lee.json: Maria and Carlo, not John.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createDb, ensureAipassFhirServer, runMigrations, seedDemo } from "@aipass/db";
import { type Bundle, FhirClient } from "@aipass/fhir";
import { decodeJwt } from "jose";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { createAuth } from "../src/auth.ts";
import { config } from "../src/config.ts";
import { mintPass } from "../src/pass.ts";

const DB =
  process.env.STAFF_DATABASE_URL ?? "postgres://aipass:aipass@127.0.0.1:5433/aipass_staff_test";
const FHIR = process.env.FHIR_BASE_URL ?? "http://127.0.0.1:8080/fhir";
const ORIGIN = config.publicUrl;
const CARLO = "Patient/b4900f5e-1c24-1150-fd26-6fbc83da8893";

let app: ReturnType<typeof createApp>;
let made: ReturnType<typeof createDb>;
const cookies: Record<string, string> = {};

const cookieOf = (res: Response) =>
  (res.headers.getSetCookie() ?? []).map((c) => c.split(";")[0]).join("; ");

async function call<T = Record<string, unknown>>(
  who: string,
  path: string,
  init: { method?: string; json?: unknown } = {},
): Promise<{ status: number; body: T }> {
  const res = await app.request(path, {
    method: init.method ?? (init.json ? "POST" : "GET"),
    headers: {
      cookie: cookies[who] ?? "",
      origin: ORIGIN,
      ...(init.json ? { "content-type": "application/json" } : {}),
    },
    body: init.json ? JSON.stringify(init.json) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

async function signIn(who: string, email: string, password: string) {
  const res = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ email, password }),
  });
  expect(res.status).toBe(200);
  cookies[who] = cookieOf(res);
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
  const fhir = new FhirClient({ baseUrl: FHIR });
  const fixture = join(import.meta.dirname, "../../../fixtures/staff/lee.json");
  await fhir.transaction(JSON.parse(readFileSync(fixture, "utf8")) as Bundle);
  app = createApp({ db: made.db, auth: createAuth(made.db), fhir });
  const admin = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({
      name: "Ada",
      email: "admin@example.org",
      password: "a-long-password-1",
    }),
  });
  cookies.admin = cookieOf(admin);
  for (const [id, email] of [
    ["lee", "lee@example.org"],
    ["maria", "maria@example.org"],
  ] as const) {
    const r = await call("admin", `/api/admin/persons/${id}/login`, {
      json: { email, password: `${id}-demo-password` },
    });
    expect(r.status).toBe(201);
    await signIn(id, email, `${id}-demo-password`);
  }
});

afterAll(async () => {
  await made?.close();
});

describe("S10: a staff member opens a patient in her care", () => {
  it("her care team comes from the record system", async () => {
    const r = await call<{ staff: boolean; patients: { ref: string; name: string }[] }>(
      "lee",
      "/api/person/patients",
    );
    expect(r.status).toBe(200);
    expect(r.body.staff).toBe(true);
    expect(r.body.patients.map((p) => p.ref)).toEqual([CARLO, "Patient/maria"]);
    expect(r.body.patients[1]?.name).toBe("Maria Elena Santos");
  });

  it("with no patient open, a pass names nobody", async () => {
    const { token } = await mintPass(made.db, { agentId: "visit-assistant", personId: "lee" });
    expect(decodeJwt(token).patient).toBeUndefined();
  });

  it("only a patient in her care can be opened", async () => {
    const john = await call("lee", "/api/person/ais/visit-assistant/patient", {
      method: "PUT",
      json: { ref: "Patient/john" },
    });
    expect(john.status).toBe(403);
    expect(john.body.error).toBe("that patient isn't in your care");
    const maria = await call("lee", "/api/person/ais/visit-assistant/patient", {
      method: "PUT",
      json: { ref: "Patient/maria" },
    });
    expect(maria.status).toBe(200);
    expect(maria.body).toEqual({ patient: { ref: "Patient/maria", name: "Maria Elena Santos" } });
  });

  it("every pass then names her open patient, and My AIs shows it", async () => {
    const { token } = await mintPass(made.db, { agentId: "visit-assistant", personId: "lee" });
    expect(decodeJwt(token)).toMatchObject({ sub: "lee", patient: "maria" });
    const mine = await call<{
      person: { staff: boolean };
      ais: { agentId: string; openPatient: { ref: string; name: string } | null }[];
    }>("lee", "/api/person/ais");
    expect(mine.body.person.staff).toBe(true);
    expect(mine.body.ais.find((a) => a.agentId === "visit-assistant")?.openPatient).toEqual({
      ref: "Patient/maria",
      name: "Maria Elena Santos",
    });
  });

  it("switching patient changes the next pass; closing it leaves none", async () => {
    await call("lee", "/api/person/ais/visit-assistant/patient", {
      method: "PUT",
      json: { ref: CARLO },
    });
    const carlo = await mintPass(made.db, { agentId: "visit-assistant", personId: "lee" });
    expect(decodeJwt(carlo.token).patient).toBe(CARLO.slice("Patient/".length));
    await call("lee", "/api/person/ais/visit-assistant/patient", { method: "DELETE" });
    const none = await mintPass(made.db, { agentId: "visit-assistant", personId: "lee" });
    expect(decodeJwt(none.token).patient).toBeUndefined();
  });

  it("a patient has no care team, can't open anyone, and her pass names her own record", async () => {
    const r = await call<{ staff: boolean; patients: unknown[] }>("maria", "/api/person/patients");
    expect(r.body).toEqual({ staff: false, patients: [] });
    const open = await call("maria", "/api/person/ais/diabetes-coach/patient", {
      method: "PUT",
      json: { ref: "Patient/john" },
    });
    expect(open.status).toBe(403);
    const { token } = await mintPass(made.db, { agentId: "diabetes-coach", personId: "maria" });
    expect(decodeJwt(token).patient).toBe("maria");
  });
});
