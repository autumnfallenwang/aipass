import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { E2E_ENV } from "./env.ts";

export default function globalSetup(): void {
  execFileSync("pnpm", ["exec", "tsx", join(import.meta.dirname, "setup-db.ts")], {
    env: { ...process.env, ...E2E_ENV },
    stdio: "inherit",
  });
}
