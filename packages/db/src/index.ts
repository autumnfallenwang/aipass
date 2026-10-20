import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

export { authSchema, users } from "./auth.ts";
export * from "./ids.ts";
export { runMigrations } from "./migrate.ts";
export * from "./queries.ts";
export * from "./receipts.ts";
export * from "./schema.ts";
export * from "./seed.ts";
export { schema };

export const DEFAULT_DATABASE_URL = "postgres://aipass:aipass@127.0.0.1:5433/aipass";

export function createDb(url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL) {
  const client = postgres(url, { max: 10, onnotice: () => {} });
  const db = drizzle(client, { schema });
  return { db, client, close: () => client.end({ timeout: 5 }) };
}

export type Db = ReturnType<typeof createDb>["db"];
