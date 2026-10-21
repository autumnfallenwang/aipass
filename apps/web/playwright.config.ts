import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { E2E, E2E_ENV } from "./e2e/env.ts";

const root = join(import.meta.dirname, "..", "..");

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL: E2E.web, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      // A scripted OpenAI-compatible model (S8): no test depends on a real one.
      command: "pnpm exec tsx e2e/fake-model.ts",
      url: `${E2E.model}/v1/models`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "pnpm --filter @aipass/api start",
      cwd: root,
      url: `${E2E.api}/health`,
      env: E2E_ENV,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: "pnpm --filter @aipass/gateway start",
      cwd: root,
      url: `${E2E.gateway}/health`,
      env: E2E_ENV,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: "pnpm exec next dev --port 4000",
      url: `${E2E.web}/health`,
      env: E2E_ENV,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
