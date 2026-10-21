/** D18: aipass's own FHIR server is registered, once, from the settings; then the row counts. */
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AIPASS_FHIR_ID,
  aipassFhirTarget,
  asSmart,
  createDb,
  ensureAipassFhirServer,
  type FhirTarget,
  fhirServers,
  followAipassFhir,
  runMigrations,
} from "../src/index.ts";

const DB =
  process.env.REGISTRY_DATABASE_URL ??
  "postgres://aipass:aipass@127.0.0.1:5433/aipass_registry_test";

let made: ReturnType<typeof createDb>;

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
});

afterAll(async () => made?.close());

describe("aipass's own FHIR server", () => {
  it("is registered from the settings on a first start, with the credential sealed", async () => {
    await ensureAipassFhirServer(made.db, {
      baseUrl: "http://fhir.example/fhir/",
      authorization: "Bearer from-settings",
    });
    const [row] = await made.db.select().from(fhirServers).where(eq(fhirServers.kind, "aipass"));
    expect(row).toMatchObject({ id: AIPASS_FHIR_ID, baseUrl: "http://fhir.example/fhir" });
    expect(row?.authHeaderSealed).not.toContain("from-settings");
    expect(await aipassFhirTarget(made.db)).toEqual({
      baseUrl: "http://fhir.example/fhir",
      headers: { authorization: "Bearer from-settings" },
    });
  });

  it("isn't overwritten by the settings later: the registered row is what counts", async () => {
    await made.db
      .update(fhirServers)
      .set({ baseUrl: "http://edited.example/fhir" })
      .where(eq(fhirServers.id, AIPASS_FHIR_ID));
    await ensureAipassFhirServer(made.db, { baseUrl: "http://fhir.example/fhir" });
    expect((await aipassFhirTarget(made.db))?.baseUrl).toBe("http://edited.example/fhir");
  });

  it("there's only ever one", async () => {
    await expect(
      made.db.insert(fhirServers).values({
        id: "second",
        kind: "aipass",
        name: "Another",
        baseUrl: "http://other.example/fhir",
      }),
    ).rejects.toThrow();
  });

  it("running services follow an edit", async () => {
    const seen: FhirTarget[] = [];
    const f = followAipassFhir(made.db, (t) => seen.push(t), 60_000);
    await f.refresh();
    expect(seen.at(-1)?.baseUrl).toBe("http://edited.example/fhir");
    await made.db
      .update(fhirServers)
      .set({ baseUrl: "http://moved.example/fhir" })
      .where(eq(fhirServers.id, AIPASS_FHIR_ID));
    await f.refresh();
    expect(seen.at(-1)?.baseUrl).toBe("http://moved.example/fhir");
    const before = seen.length;
    await f.refresh();
    expect(seen.length).toBe(before); // unchanged: not applied again
    f.stop();
  });

  it("isn't mistaken for a SMART server", async () => {
    const [row] = await made.db.select().from(fhirServers).where(eq(fhirServers.kind, "aipass"));
    expect(asSmart(row)).toBeNull();
  });
});
