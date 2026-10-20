import { randomUUID } from "node:crypto";
import { createDb, type Db, DEMO, receipts, runMigrations, seedDemo } from "@aipass/db";
import { buildDevice, FhirClient } from "@aipass/fhir";
import { agentUrl } from "@aipass/shared";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { desc } from "drizzle-orm";
import {
  type CryptoKey,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTPayload,
  SignJWT,
} from "jose";
import postgres from "postgres";
import { createGateway } from "../src/app.ts";
import { type GatewayConfig, loadConfig } from "../src/config.ts";
import { PassVerifier } from "../src/pass.ts";

export const TEST_DB =
  process.env.TEST_DATABASE_URL ?? "postgres://aipass:aipass@127.0.0.1:5433/aipass_test";
export const FHIR = process.env.FHIR_BASE_URL ?? "http://127.0.0.1:8080/fhir";
export const ISSUER = "http://api.test";
export const GATEWAY = "http://gateway.test";

async function ensureDatabase(url: string): Promise<void> {
  const u = new URL(url);
  const name = u.pathname.slice(1);
  u.pathname = "/postgres";
  const admin = postgres(u.toString(), { max: 1, onnotice: () => {} });
  try {
    const rows = await admin`select 1 from pg_database where datname = ${name}`;
    if (rows.length === 0) await admin.unsafe(`create database "${name}"`);
  } finally {
    await admin.end();
  }
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;

export async function createHarness(
  opts: {
    fhir?: FhirClient;
    upstreamFetch?: typeof fetch;
    /** Sees every response the gateway sends an agent. */
    onResponse?: (res: Response) => void;
  } = {},
) {
  await ensureDatabase(TEST_DB);
  await runMigrations(TEST_DB);
  const { db, close } = createDb(TEST_DB);

  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "ES256" };
  const other = await generateKeyPair("ES256");

  const config: GatewayConfig = loadConfig({
    ...process.env,
    GATEWAY_URL: GATEWAY,
    API_URL: ISSUER,
    DATABASE_URL: TEST_DB,
    FHIR_BASE_URL: FHIR,
  });
  const verifier = new PassVerifier(
    config.gatewayUrl,
    config.trustedIssuers,
    new Map([[ISSUER, createLocalJWKSet({ keys: [jwk] })]]),
  );
  const fhir = opts.fhir ?? new FhirClient({ baseUrl: FHIR });
  const gw = createGateway({ db, config, verifier, fhir, upstreamFetch: opts.upstreamFetch });

  async function reset(): Promise<void> {
    await seedDemo(db, { reset: true });
    for (const a of DEMO.agents) await fhir.update(buildDevice({ ...a, status: "active" }));
  }

  /** Signs a pass. Override any claim to build a bad one. */
  async function pass(
    agent: string,
    person: string,
    over: { claims?: JWTPayload; ttl?: number; key?: CryptoKey; iat?: number } = {},
  ): Promise<string> {
    const iat = over.iat ?? Math.floor(Date.now() / 1000);
    return new SignJWT({
      act: { sub: agent },
      patient: person,
      sub: person,
      iss: ISSUER,
      aud: agentUrl(GATEWAY, agent),
      iat,
      exp: iat + (over.ttl ?? 300),
      jti: randomUUID(),
      ...over.claims,
    })
      .setProtectedHeader({ alg: "ES256", kid: "test-key" })
      .sign(over.key ?? privateKey);
  }

  const appFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const res = await gw.app.fetch(new Request(input, init));
    opts.onResponse?.(res);
    return res;
  };

  async function connect(agent: string, token: string) {
    const client = new Client({ name: "aipass-test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(agentUrl(GATEWAY, agent)), {
      fetch: appFetch,
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    return {
      client,
      async call(name: string, args: Record<string, unknown> = {}) {
        const r = await client.callTool({ name, arguments: args });
        const text = (r.content as { type: string; text?: string }[])
          .map((c) => c.text ?? "")
          .join("\n");
        return { text, isError: r.isError === true };
      },
      close: () => client.close(),
    };
  }

  async function lastReceipt() {
    const [r] = await db.select().from(receipts).orderBy(desc(receipts.seq)).limit(1);
    return r;
  }

  return {
    db: db as Db,
    fhir,
    config,
    gw,
    reset,
    pass,
    connect,
    appFetch,
    lastReceipt,
    wrongKey: other.privateKey,
    close,
  };
}
