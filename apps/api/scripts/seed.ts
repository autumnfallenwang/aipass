/**
 * Seeds the Maria demo (see src/demo.ts).
 *
 *   pnpm db:seed            # adds what's missing
 *   pnpm db:seed --reset    # puts the demo back to its starting state
 */
import { createDb } from "@aipass/db";
import { config } from "../src/config.ts";
import { seedDemoAll } from "../src/demo.ts";

const reset = process.argv.includes("--reset");
const { db, close } = createDb(config.databaseUrl);
try {
  await seedDemoAll(db, {
    fhirBaseUrl: config.fhirBaseUrl,
    fhirHeaders: config.fhirHeaders,
    reset,
  });
  console.info(reset ? "demo reset" : "demo seeded");
} finally {
  await close();
}
