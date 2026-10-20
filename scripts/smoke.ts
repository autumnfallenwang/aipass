/**
 * Checks that every service is up: the three apps answer /health and the FHIR
 * server returns Maria. Used by the S0 "fresh clone" check and by CI.
 *
 *   pnpm smoke
 */
const targets = [
  ["web", process.env.WEB_URL ?? "http://localhost:3000"],
  ["api", process.env.API_URL ?? "http://localhost:3001"],
  ["gateway", process.env.GATEWAY_URL ?? "http://localhost:3002"],
] as const;
const fhir = process.env.FHIR_BASE_URL ?? "http://127.0.0.1:8080/fhir";

async function check(name: string, url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    console.info(`${res.ok ? "ok  " : "FAIL"} ${name} ${url} -> ${res.status}`);
    return res.ok;
  } catch (err) {
    console.info(`FAIL ${name} ${url} -> ${(err as Error).message}`);
    return false;
  }
}

const results = await Promise.all([
  ...targets.map(([name, base]) => check(name, `${base}/health`)),
  check("fhir: Patient/maria", `${fhir}/Patient/maria`),
]);
if (results.includes(false)) process.exit(1);
console.info("all healthy");

export {};
