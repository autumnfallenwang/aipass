/**
 * Loads every fixture bundle into the FHIR server. Idempotent: bundles are
 * transactions of PUTs with fixed ids, so running it twice changes nothing.
 *
 *   pnpm fixtures:load            # uses FHIR_BASE_URL or http://127.0.0.1:8080/fhir
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const base = (process.env.FHIR_BASE_URL ?? "http://127.0.0.1:8080/fhir").replace(/\/$/, "");
const root = join(import.meta.dirname, "..", "fixtures");

function bundleFiles(): string[] {
  const top = readdirSync(root)
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(root, f));
  const synthea = readdirSync(join(root, "synthea"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(root, "synthea", f));
  return [...top, ...synthea];
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 90; i++) {
    try {
      const res = await fetch(`${base}/metadata`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`FHIR server at ${base} did not come up`);
}

async function main(): Promise<void> {
  await waitForServer();
  for (const file of bundleFiles()) {
    const body = readFileSync(file, "utf8");
    const res = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/fhir+json" },
      body,
    });
    if (!res.ok) {
      console.error(`${file}: HTTP ${res.status}\n${await res.text()}`);
      process.exit(1);
    }
    const out = (await res.json()) as { entry?: unknown[] };
    console.info(`loaded ${file.slice(root.length + 1)} (${out.entry?.length ?? 0} resources)`);
  }
}

await main();
