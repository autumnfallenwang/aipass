import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Defect, parseBroken } from "./broken.ts";

const rootEnv = join(import.meta.dirname, "..", "..", "..", ".env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

function url(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  return (env[name] ?? fallback).replace(/\/$/, "");
}

export type TrustedIssuer = { issuer: string; jwksUri: string };

export type GatewayConfig = {
  port: number;
  gatewayUrl: string;
  apiUrl: string;
  fhirBaseUrl: string;
  /** Header the gateway sends to the FHIR server: its own credential, never the agent's. */
  fhirHeaders: Record<string, string>;
  databaseUrl: string;
  trustedIssuers: TrustedIssuer[];
  /** The public origin people's browsers use (approval links point here). */
  publicUrl: string;
  /** The authorization server advertised in Protected Resource Metadata. */
  authorizationServers: string[];
  /** Signs paging tokens so an agent can't edit them. */
  pageSecret: Buffer;
  maxPageSize: number;
  /** Planted defects (S4 self-test only; refused in production). */
  broken: ReadonlySet<Defect>;
};

export function loadConfig(env = process.env): GatewayConfig {
  const apiUrl = url(env, "API_URL", "http://localhost:3001");
  // OAuth passes are issued on the public origin (D10) but their keys are
  // fetched from the api directly.
  const publicUrl = url(env, "PUBLIC_URL", env.WEB_URL ?? "http://localhost:3000");
  const issuers: TrustedIssuer[] = env.TRUSTED_ISSUERS
    ? (JSON.parse(env.TRUSTED_ISSUERS) as TrustedIssuer[])
    : [
        // dev passes (S1) and token exchange (S6)
        { issuer: apiUrl, jwksUri: `${apiUrl}/.well-known/jwks.json` },
        // OAuth access tokens (S3)
        { issuer: `${publicUrl}/api/auth`, jwksUri: `${apiUrl}/api/auth/jwks` },
      ];
  return {
    port: Number(env.GATEWAY_PORT ?? 3002),
    gatewayUrl: url(env, "GATEWAY_URL", "http://localhost:3002"),
    apiUrl,
    fhirBaseUrl: url(env, "FHIR_BASE_URL", "http://127.0.0.1:8080/fhir"),
    fhirHeaders: env.FHIR_AUTHORIZATION ? { authorization: env.FHIR_AUTHORIZATION } : {},
    databaseUrl: env.DATABASE_URL ?? "postgres://aipass:aipass@127.0.0.1:5433/aipass",
    trustedIssuers: issuers,
    publicUrl,
    authorizationServers: [`${publicUrl}/api/auth`],
    pageSecret: env.PAGE_SECRET ? Buffer.from(env.PAGE_SECRET, "utf8") : randomBytes(32),
    maxPageSize: 50,
    broken: parseBroken(env.AIPASS_BROKEN, env),
  };
}
