/** S7: re-sealing the vault with a new key, against Postgres. */
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  fhirServers,
  rotateVault,
  runMigrations,
  seal,
  seedDemo,
  unseal,
  vault,
  vaultKeys,
} from "../src/index.ts";

const DB =
  process.env.ROTATE_DATABASE_URL ?? "postgres://aipass:aipass@127.0.0.1:5433/aipass_rotate_test";
const OLD = "the-old-vault-key-that-is-long-enough-111";
const NEW = "the-new-vault-key-that-is-long-enough-222";
const keys = vaultKeys({ AIPASS_VAULT_KEY: NEW, AIPASS_VAULT_KEY_PREVIOUS: OLD });
const [newKey, oldKey] = keys as [Buffer, Buffer];

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
  await seedDemo(made.db);
  await made.db.insert(fhirServers).values({
    id: "ehr",
    name: "EHR",
    baseUrl: "https://ehr.example/fhir",
    authorizeUrl: "https://ehr.example/authorize",
    tokenUrl: "https://ehr.example/token",
    clientId: "aipass",
    clientSecretSealed: seal(oldKey, "client-secret", "server|ehr"),
    scope: "launch/patient",
  });
  await made.db.insert(vault).values([
    {
      personId: "maria",
      serverId: "ehr",
      patientId: "p1",
      tokensSealed: seal(oldKey, '{"access_token":"a"}', "maria|ehr"),
      expiresAt: new Date(),
    },
    {
      // sealed with a key nobody has any more
      personId: "john",
      serverId: "ehr",
      patientId: "p2",
      tokensSealed: seal(Buffer.alloc(32, 7), '{"access_token":"b"}', "john|ehr"),
      expiresAt: new Date(),
    },
  ]);
});

afterAll(async () => made?.close());

describe("rotateVault", () => {
  it("re-seals what an old key opens with the new key, and lists what no key opens", async () => {
    const r = await rotateVault(made.db, keys);
    expect(r.resealed).toBe(2);
    expect(r.failed).toEqual(["john at ehr"]);

    const [server] = await made.db.select().from(fhirServers).where(eq(fhirServers.id, "ehr"));
    expect(unseal(newKey, server?.clientSecretSealed ?? "", "server|ehr")).toBe("client-secret");
    const [maria] = await made.db.select().from(vault).where(eq(vault.personId, "maria"));
    expect(unseal(newKey, maria?.tokensSealed ?? "", "maria|ehr")).toBe('{"access_token":"a"}');
    expect(() => unseal(oldKey, maria?.tokensSealed ?? "", "maria|ehr")).toThrow();
  });

  it("is safe to run again", async () => {
    const r = await rotateVault(made.db, keys);
    expect(r.resealed).toBe(2);
    expect(r.failed).toEqual(["john at ehr"]);
  });
});
