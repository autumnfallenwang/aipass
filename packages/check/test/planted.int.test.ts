/**
 * Proves the inspector: the gateway is started with one planted defect at a
 * time, and the probe for that defect must fail, while a clean gateway must
 * pass every probe (no false alarms). Runs in-process against Postgres + HAPI.
 */
import { createDb, passKeys, runMigrations, seedDemo } from "@aipass/db";
import { createGateway } from "@aipass/gateway";
import { DEFECTS, type Defect } from "@aipass/gateway/broken";
import { loadConfig } from "@aipass/gateway/config";
import { PassVerifier } from "@aipass/gateway/pass";
import { createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runChecks } from "../src/report.ts";
import { aipassTarget } from "../src/targets/aipass.ts";

const DB =
  process.env.CHECK_DATABASE_URL ?? "postgres://aipass:aipass@127.0.0.1:5433/aipass_check_test";
const FHIR = process.env.FHIR_BASE_URL ?? "http://127.0.0.1:8080/fhir";
const GATEWAY = "http://gateway.check";
const ISSUER = "http://api.check";

/** Which probe must catch which planted defect. */
const CATCHES: Record<Defect, string> = {
  require_pass: "no_pass",
  signature: "forged_pass",
  expiry: "expired_pass",
  audience: "wrong_audience",
  agent_status: "stopped_agent",
  role: "role_escape",
  grant: "revoked_grant",
  compartment: "wrong_patient",
  labels: "locked_label_leak",
  include: "include_escape",
  audit_refusals: "refusal_audited",
  audit_person: "receipt_names_both",
};

let made: ReturnType<typeof createDb>;
let jwks: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const u = new URL(DB);
  const name = u.pathname.slice(1);
  u.pathname = "/postgres";
  const admin = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await admin.unsafe(`drop database if exists "${name}" with (force)`);
  await admin.unsafe(`create database "${name}"`);
  await admin.end();
  await runMigrations(DB);
  made = createDb(DB);
  await seedDemo(made.db);
  // the api's signing key, as the api would create it
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  const pub = { ...(await exportJWK(publicKey)), kid: "check-key", alg: "ES256" };
  await made.db.insert(passKeys).values({
    kid: "check-key",
    alg: "ES256",
    publicJwk: pub,
    privateJwk: { ...(await exportJWK(privateKey)), kid: "check-key", alg: "ES256" },
  });
  jwks = createLocalJWKSet({ keys: [pub] });
});
afterAll(async () => made?.close());

async function check(defects: Defect[]) {
  const config = {
    ...loadConfig({
      ...process.env,
      GATEWAY_URL: GATEWAY,
      API_URL: ISSUER,
      DATABASE_URL: DB,
      FHIR_BASE_URL: FHIR,
      AIPASS_BROKEN: defects.join(","),
    }),
  };
  const verifier = new PassVerifier(
    GATEWAY,
    config.trustedIssuers,
    new Map([[ISSUER, jwks]]),
    config.broken,
  );
  const { app } = createGateway({ db: made.db, config, verifier });
  const target = aipassTarget({
    db: made.db,
    gatewayUrl: GATEWAY,
    passIssuer: ISSUER,
    fhirBaseUrl: FHIR,
    fetch: async (input, init) => app.fetch(new Request(input, init)),
  });
  return runChecks(target);
}

const matrix: string[] = [];

describe("the health check catches every planted defect", () => {
  it("passes every probe on a correct gateway (no false alarms)", async () => {
    const r = await check([]);
    const notPassing = r.results.filter((x) => x.status !== "pass");
    expect(notPassing.map((x) => `${x.id}: ${x.detail}`)).toEqual([]);
    expect(r.grade).toBe("A");
    matrix.push(`| (none) | — | all ${r.results.length} pass | ${r.grade} |`);
  });

  it.each(DEFECTS)("catches the planted defect %s", async (defect) => {
    const r = await check([defect]);
    const probe = CATCHES[defect];
    const hit = r.results.find((x) => x.id === probe);
    const others = r.results.filter((x) => x.status === "fail").map((x) => x.id);
    matrix.push(`| \`${defect}\` | \`${probe}\` | fails: ${others.join(", ")} | ${r.grade} |`);
    expect(hit?.status, hit?.detail).toBe("fail");
  });

  afterAll(() => {
    console.info(
      [
        "| Planted defect | Must be caught by | Probes that failed | Grade |",
        "|---|---|---|---|",
        ...matrix,
      ].join("\n"),
    );
  });
});
