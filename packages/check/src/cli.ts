/**
 * The aipass health check, from the terminal.
 *
 *   pnpm check                                   # this install's own gateway (env: DATABASE_URL, GATEWAY_URL, API_URL, FHIR_BASE_URL)
 *   pnpm check --target wso2 --url http://127.0.0.1:8101/mcp --version 2a915a4
 *   pnpm check --target fhirhydrant --url http://127.0.0.1:8102/mcp --version 1a24376 --audit-file ./audit.jsonl
 *   ... --out report.md --json report.json --only no_pass,wrong_patient
 */
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createDb } from "@aipass/db";
import { runChecks, toMarkdown } from "./report.ts";
import { aipassTarget } from "./targets/aipass.ts";
import { bridgeTarget, PRESETS } from "./targets/bridge.ts";
import type { Target } from "./types.ts";

const rootEnv = join(import.meta.dirname, "..", "..", "..", ".env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const { values: a } = parseArgs({
  options: {
    target: { type: "string", default: "aipass" },
    url: { type: "string" },
    version: { type: "string" },
    bearer: { type: "string" },
    "audit-file": { type: "string" },
    only: { type: "string" },
    out: { type: "string" },
    json: { type: "string" },
  },
});

function gitVersion(): string {
  try {
    return execFileSync("git", ["describe", "--tags", "--always", "--dirty"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

const command = `pnpm check ${process.argv.slice(2).join(" ")}`.trim();
let target: Target;
let close = async () => {};
if (a.target === "aipass") {
  const made = createDb(process.env.DATABASE_URL);
  close = made.close;
  target = aipassTarget({
    db: made.db,
    gatewayUrl: (process.env.GATEWAY_URL ?? "http://localhost:3002").replace(/\/$/, ""),
    passIssuer: (process.env.API_URL ?? "http://localhost:3001").replace(/\/$/, ""),
    fhirBaseUrl: process.env.FHIR_BASE_URL ?? "http://127.0.0.1:8080/fhir",
    publicUrl: process.env.PUBLIC_URL ?? process.env.WEB_URL ?? "http://localhost:3000",
    version: a.version ?? gitVersion(),
  });
} else if (a.target && a.target in PRESETS) {
  if (!a.url) throw new Error("--url is required for an external target");
  target = bridgeTarget({
    preset: a.target,
    url: a.url,
    version: a.version ?? "unknown",
    bearer: a.bearer,
    auditFile: a["audit-file"],
  });
} else {
  throw new Error(`unknown target "${a.target}" (aipass, ${Object.keys(PRESETS).join(", ")})`);
}

try {
  const report = await runChecks(target, { only: a.only?.split(","), command });
  const md = toMarkdown(report);
  if (a.out) writeFileSync(a.out, `${md}\n`);
  if (a.json) writeFileSync(a.json, `${JSON.stringify(report, null, 2)}\n`);
  console.info(md);
  process.exitCode = report.grade === "A" ? 0 : 1;
} finally {
  await close();
}
