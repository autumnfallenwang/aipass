/**
 * S6: Maria connects her record at an EHR (the SMART launcher plays it,
 * `docker compose --profile smart up -d`). The tokens land in the vault,
 * sealed; nobody gets them back out through the api.
 */
import { createDb, runMigrations, seedDemo, unseal, vault, vaultKey } from "@aipass/db";
import { FhirClient, smartLauncherFhirUrl } from "@aipass/fhir";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { createAuth } from "../src/auth.ts";
import { config } from "../src/config.ts";
import { DEFAULT_SCOPE } from "../src/fhir-servers.ts";

const DB =
  process.env.SMART_DATABASE_URL ?? "postgres://aipass:aipass@127.0.0.1:5433/aipass_smart_test";
const LAUNCHER = process.env.SMART_LAUNCHER_URL ?? "http://localhost:8090";
const SECRET = "launcher-dev-secret";
const BASE = smartLauncherFhirUrl({
  launcher: LAUNCHER,
  patient: "maria",
  clientId: "aipass",
  clientSecret: SECRET,
});
const ORIGIN = config.publicUrl;

let app: ReturnType<typeof createApp>;
let made: ReturnType<typeof createDb>;
let admin = "";
let maria = "";

const cookieOf = (res: Response) =>
  (res.headers.getSetCookie() ?? []).map((c) => c.split(";")[0]).join("; ");

function call(path: string, cookie: string, init: { method?: string; json?: unknown } = {}) {
  return app.request(path, {
    method: init.method ?? (init.json ? "POST" : "GET"),
    headers: {
      cookie,
      origin: ORIGIN,
      ...(init.json ? { "content-type": "application/json" } : {}),
    },
    body: init.json ? JSON.stringify(init.json) : undefined,
  });
}

/** Maria's browser: start the launch, let the launcher (login skipped) send her back. */
async function launch(cookie = maria): Promise<URL> {
  const start = await call("/api/person/fhir/sunrise-ehr/connect", cookie);
  expect(start.status).toBe(302);
  const atEhr = await fetch(start.headers.get("location") ?? "", { redirect: "manual" });
  expect(atEhr.status).toBe(302);
  return new URL(atEhr.headers.get("location") ?? "");
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
  expect(
    (
      await call("/api/admin/persons/maria/login", admin, {
        json: { email: "maria@example.org", password: "maria-aipass-pw" },
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await call("/api/admin/persons/john/login", admin, {
        json: { email: "john@example.org", password: "john-aipass-pw1" },
      })
    ).status,
  ).toBe(201);
  maria = cookieOf(
    await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ email: "maria@example.org", password: "maria-aipass-pw" }),
    }),
  );
}, 60_000);

afterAll(async () => made?.close());

describe("connecting a record at an EHR (SMART standalone launch)", () => {
  it("the admin adds the EHR: endpoints from discovery, the secret sealed and never shown", async () => {
    const res = await call("/api/admin/fhir-servers", admin, {
      json: { name: "Sunrise EHR", baseUrl: BASE, clientId: "aipass", clientSecret: SECRET },
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status, JSON.stringify(body)).toBe(201);
    expect(body).toMatchObject({ id: "sunrise-ehr", confidential: true, scope: DEFAULT_SCOPE });
    expect(body.redirectUri).toBe(`${ORIGIN}/api/person/fhir/callback`);
    expect(String(body.tokenUrl)).toContain("/auth/token");
    const list = await (await call("/api/admin/fhir-servers", admin)).text();
    expect(list).not.toContain(SECRET);
    expect(list).not.toContain("clientSecretSealed");
    // the coach now reads from it
    expect(
      (
        await call("/api/admin/agents/diabetes-coach", admin, {
          method: "PATCH",
          json: { fhirServerId: "sunrise-ehr" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call("/api/admin/agents/diabetes-coach", admin, {
          method: "PATCH",
          json: { fhirServerId: "nope" },
        })
      ).status,
    ).toBe(400);
  });

  it("Maria sees the EHR her coach reads from, not yet connected", async () => {
    const list = await (await call("/api/person/fhir", maria)).json();
    expect(list).toEqual([
      { id: "sunrise-ehr", name: "Sunrise EHR", connected: false, connectedAt: null },
    ]);
  });

  it("Maria connects: the tokens go in the vault, sealed, with the patient pinned", async () => {
    const back = await launch();
    expect(back.pathname).toBe("/api/person/fhir/callback");
    const done = await call(`${back.pathname}${back.search}`, maria);
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toBe(`${ORIGIN}/my-ais?connected=sunrise-ehr`);
    const [row] = await made.db.select().from(vault).where(eq(vault.personId, "maria"));
    expect(row?.patientId).toBe("maria");
    const tokens = JSON.parse(unseal(vaultKey(), row?.tokensSealed ?? "", "maria|sunrise-ehr"));
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();
    expect(row?.tokensSealed).not.toContain(tokens.access_token);
    const list = (await (await call("/api/person/fhir", maria)).json()) as { connected: boolean }[];
    expect(list[0]?.connected).toBe(true);
    // nothing the person or admin can fetch carries the token
    for (const [path, cookie] of [
      ["/api/person/fhir", maria],
      ["/api/person/ais", maria],
      ["/api/admin/fhir-servers", admin],
      ["/api/admin/agents", admin],
    ] as const) {
      expect(await (await call(path, cookie)).text()).not.toContain(tokens.access_token);
    }
  });

  it("a launch is single use", async () => {
    const back = await launch();
    expect((await call(`${back.pathname}${back.search}`, maria)).headers.get("location")).toContain(
      "connected=",
    );
    const again = await call(`${back.pathname}${back.search}`, maria);
    expect(again.headers.get("location")).toContain("connect_error=");
  });

  it("someone else can't finish Maria's launch", async () => {
    const john = cookieOf(
      await app.request("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ email: "john@example.org", password: "john-aipass-pw1" }),
      }),
    );
    const back = await launch();
    const stolen = await call(`${back.pathname}${back.search}`, john);
    expect(stolen.headers.get("location")).toContain("connect_error=");
    const [johns] = await made.db.select().from(vault).where(eq(vault.personId, "john"));
    expect(johns).toBeUndefined();
  });

  it("the EHR saying no is not a connection", async () => {
    const start = await call("/api/person/fhir/sunrise-ehr/connect", maria);
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
    const res = await call(`/api/person/fhir/callback?state=${state}&error=access_denied`, maria);
    const err = new URL(res.headers.get("location") ?? "").searchParams.get("connect_error");
    expect(err).toBe("Sunrise EHR said no (access_denied)");
  });

  it("Maria disconnects", async () => {
    expect(
      (await call("/api/person/fhir/sunrise-ehr/disconnect", maria, { json: {} })).status,
    ).toBe(200);
    expect(await made.db.select().from(vault).where(eq(vault.personId, "maria"))).toHaveLength(0);
  });

  it("only signed-in people can start a launch", async () => {
    expect((await call("/api/person/fhir/sunrise-ehr/connect", "")).status).toBe(401);
  });
});
