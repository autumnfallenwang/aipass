/**
 * Seeds the Maria demo: two roles, two agents, Maria and John, their grants,
 * and a FHIR Device per agent.
 *
 *   pnpm db:seed            # adds what's missing
 *   pnpm db:seed --reset    # puts the demo back to its starting state
 */
import { createDb, DEMO, seedDemo } from "@aipass/db";
import { buildDevice, FhirClient } from "@aipass/fhir";
import { config } from "../src/config.ts";

const reset = process.argv.includes("--reset");
const { db, close } = createDb(config.databaseUrl);
try {
  await seedDemo(db, { reset });
  const fhir = new FhirClient({ baseUrl: config.fhirBaseUrl });
  for (const a of DEMO.agents) await fhir.update(buildDevice({ ...a, status: "active" }));
  console.info(reset ? "demo reset" : "demo seeded");
} finally {
  await close();
}
