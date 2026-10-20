import { existsSync } from "node:fs";
import { join } from "node:path";
import { isLoopbackUrl, LOCAL_TRIAL_SECRETS } from "@aipass/shared";

const rootEnv = join(import.meta.dirname, "..", "..", "..", ".env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

function url(name: string, fallback: string): string {
  return (process.env[name] ?? fallback).replace(/\/$/, "");
}

export const config = {
  port: Number(process.env.API_PORT ?? 3001),
  apiUrl: url("API_URL", "http://localhost:3001"),
  gatewayUrl: url("GATEWAY_URL", "http://localhost:3002"),
  /** How the api itself reaches the gateway (the health check), when that isn't GATEWAY_URL: e.g. inside a container network. */
  gatewayInternalUrl: url(
    "GATEWAY_INTERNAL_URL",
    process.env.GATEWAY_URL ?? "http://localhost:3002",
  ),
  webUrl: url("WEB_URL", "http://localhost:3000"),
  fhirBaseUrl: url("FHIR_BASE_URL", "http://127.0.0.1:8080/fhir"),
  /** aipass's own credential for that FHIR server (the whole header value), if it needs one. */
  fhirHeaders: (process.env.FHIR_AUTHORIZATION
    ? { authorization: process.env.FHIR_AUTHORIZATION }
    : {}) as Record<string, string>,
  databaseUrl: process.env.DATABASE_URL ?? "postgres://aipass:aipass@127.0.0.1:5433/aipass",
  /** The origin people's browsers use. The web app proxies `/api/*` here, so auth lives on this origin. */
  publicUrl: url("PUBLIC_URL", process.env.WEB_URL ?? "http://localhost:3000"),
  authSecret: authSecret(),
  /** The organisation people see on the consent page ("approved by …"). */
  orgName: process.env.ORG_NAME ?? "Sunrise Clinic",
  /** Proxies in front whose X-Forwarded-For is believed, for rate limiting (addresses or CIDR ranges). */
  trustedProxies: (process.env.AIPASS_TRUSTED_PROXIES ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean),
  /** Dev passes are minted by a CLI and a localhost-only endpoint. Off unless asked for. */
  devPasses: process.env.AIPASS_DEV_PASSES === "1",
};

function authSecret(): string {
  const s = process.env.BETTER_AUTH_SECRET;
  if (
    s === LOCAL_TRIAL_SECRETS.auth &&
    !isLoopbackUrl(process.env.PUBLIC_URL ?? "http://localhost:3000")
  ) {
    throw new Error(
      "BETTER_AUTH_SECRET is the public local-trial value; set your own outside localhost",
    );
  }
  if (s && s.length >= 32) return s;
  if (process.env.NODE_ENV === "production") {
    throw new Error("BETTER_AUTH_SECRET (32+ characters) is required in production");
  }
  return "aipass-dev-only-secret-do-not-use-in-production";
}

/** The issuer of passes the api mints itself. */
export function passIssuer(): string {
  return config.apiUrl;
}
