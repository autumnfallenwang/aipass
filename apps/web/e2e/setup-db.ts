/**
 * Puts the end-to-end database in a known state: migrated, emptied, then the
 * Maria demo seeded (no users, so the first sign-up becomes the admin).
 */
import { createDb, DEMO, runMigrations, seedDemo } from "@aipass/db";
import { buildDevice, FhirClient } from "@aipass/fhir";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url?.includes("e2e")) throw new Error(`refusing to reset a non-e2e database: ${url}`);

const u = new URL(url);
const name = u.pathname.slice(1);
u.pathname = "/postgres";
const admin = postgres(u.toString(), { max: 1, onnotice: () => {} });
if ((await admin`select 1 from pg_database where datname = ${name}`).length === 0) {
  await admin.unsafe(`create database "${name}"`);
}
await admin.end();

await runMigrations(url);
const { db, client, close } = createDb(url);
await client.unsafe(
  `truncate table receipts, grants, agents, roles, persons, passkey, verification, account, session, "user" restart identity cascade`,
);
await seedDemo(db);
await close();

const fhir = new FhirClient({ baseUrl: process.env.FHIR_BASE_URL ?? "http://127.0.0.1:8080/fhir" });
for (const a of DEMO.agents) await fhir.update(buildDevice({ ...a, status: "active" }));
console.info(`e2e database ${name} ready`);
