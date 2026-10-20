import { existsSync } from "node:fs";
import { join } from "node:path";

const rootEnv = join(import.meta.dirname, "..", "..", "..", ".env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

function url(name: string, fallback: string): string {
  return (process.env[name] ?? fallback).replace(/\/$/, "");
}

export const config = {
  port: Number(process.env.API_PORT ?? 3001),
  apiUrl: url("API_URL", "http://localhost:3001"),
  gatewayUrl: url("GATEWAY_URL", "http://localhost:3002"),
  webUrl: url("WEB_URL", "http://localhost:3000"),
  fhirBaseUrl: url("FHIR_BASE_URL", "http://127.0.0.1:8080/fhir"),
  databaseUrl: process.env.DATABASE_URL ?? "postgres://aipass:aipass@127.0.0.1:5433/aipass",
  /** The origin people's browsers use. The web app proxies `/api/*` here, so auth lives on this origin. */
  publicUrl: url("PUBLIC_URL", process.env.WEB_URL ?? "http://localhost:3000"),
  authSecret: authSecret(),
  /** Dev passes are minted by a CLI and a localhost-only endpoint. Off unless asked for. */
  devPasses: process.env.AIPASS_DEV_PASSES === "1",
};

function authSecret(): string {
  const s = process.env.BETTER_AUTH_SECRET;
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
