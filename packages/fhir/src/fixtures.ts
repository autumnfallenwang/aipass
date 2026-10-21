import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

async function waitForServer(base: string): Promise<void> {
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

/**
 * Loads every synthetic fixture bundle into a FHIR server, waiting for it to
 * come up first: `dir/*.json`, then `dir/synthea/*.json`, then `dir/staff/*.json`
 * (staff and their care teams point at patients, so they go last). Idempotent:
 * bundles are transactions of PUTs with fixed ids.
 */
export async function loadFixtures(
  baseUrl: string,
  dir: string,
  log = console.info,
): Promise<void> {
  const base = baseUrl.replace(/\/$/, "");
  const files = ["", "synthea", "staff"].flatMap((sub) =>
    readdirSync(join(dir, sub))
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => join(dir, sub, f)),
  );
  await waitForServer(base);
  for (const file of files) {
    const res = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/fhir+json" },
      body: readFileSync(file, "utf8"),
    });
    if (!res.ok) throw new Error(`${file}: HTTP ${res.status}\n${await res.text()}`);
    const out = (await res.json()) as { entry?: unknown[] };
    log(`loaded ${file.slice(dir.length + 1)} (${out.entry?.length ?? 0} resources)`);
  }
}
