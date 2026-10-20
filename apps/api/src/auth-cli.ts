/**
 * Entry point for the Better Auth CLI only (`pnpm --filter @aipass/api auth:generate`),
 * which reads this instance's options to write `packages/db/src/auth-schema.ts`.
 */
import { createDb } from "@aipass/db";
import { createAuth } from "./auth.ts";

export const auth = createAuth(createDb().db);
