/**
 * Loads every fixture bundle into the FHIR server. Idempotent: bundles are
 * transactions of PUTs with fixed ids, so running it twice changes nothing.
 *
 *   pnpm fixtures:load            # uses FHIR_BASE_URL or http://127.0.0.1:8080/fhir
 */
import { join } from "node:path";
import { loadFixtures } from "../packages/fhir/src/fixtures.ts";

await loadFixtures(
  process.env.FHIR_BASE_URL ?? "http://127.0.0.1:8080/fhir",
  join(import.meta.dirname, "..", "fixtures"),
);
