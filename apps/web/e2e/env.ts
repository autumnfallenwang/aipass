/** The end-to-end stack runs on its own ports and database, next to `pnpm dev`. */
export const E2E = {
  web: "http://localhost:4000",
  api: "http://localhost:4001",
  gateway: "http://localhost:4002",
  /** The scripted model (S8, `fake-model.ts`). */
  model: "http://127.0.0.1:4005",
};

export const E2E_ENV: Record<string, string> = {
  DATABASE_URL:
    process.env.E2E_DATABASE_URL ?? "postgres://aipass:aipass@127.0.0.1:5433/aipass_e2e",
  FHIR_BASE_URL: process.env.FHIR_BASE_URL ?? "http://127.0.0.1:8080/fhir",
  API_URL: E2E.api,
  API_PORT: "4001",
  GATEWAY_URL: E2E.gateway,
  GATEWAY_PORT: "4002",
  PUBLIC_URL: E2E.web,
  WEB_URL: E2E.web,
  AIPASS_DEV_PASSES: "1",
  NEXT_DIST_DIR: ".next-e2e",
};
