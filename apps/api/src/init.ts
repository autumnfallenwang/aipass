/**
 * One-shot setup for a container install (S7): migrates the database and,
 * with AIPASS_DEMO=1, loads the synthetic patients and the Maria demo. Safe to
 * run on every start: each step only adds what's missing.
 */
import { join } from "node:path";
import { createDb, runMigrations } from "@aipass/db";
import { loadFixtures } from "@aipass/fhir";
import { config } from "./config.ts";
import { seedDemoAll } from "./demo.ts";

await runMigrations(config.databaseUrl);
console.info("migrations applied");
if (process.env.AIPASS_DEMO === "1") {
  const dir =
    process.env.AIPASS_FIXTURES_DIR ?? join(import.meta.dirname, "..", "..", "..", "fixtures");
  await loadFixtures(config.fhirBaseUrl, dir);
  const { db, close } = createDb(config.databaseUrl);
  try {
    await seedDemoAll(db, { fhirBaseUrl: config.fhirBaseUrl });
  } finally {
    await close();
  }
  console.info("demo seeded (synthetic data only)");
}
