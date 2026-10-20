/** Applies pending migrations from ./drizzle (`pnpm db:migrate` runs scripts/migrate.ts). */
import { join } from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "./index.ts";

export async function runMigrations(url?: string): Promise<void> {
  const { db, close } = createDb(url);
  try {
    // AIPASS_MIGRATIONS_DIR: where the bundled api image keeps them.
    const migrationsFolder =
      process.env.AIPASS_MIGRATIONS_DIR ?? join(import.meta.dirname, "..", "drizzle");
    await migrate(db, { migrationsFolder });
  } finally {
    await close();
  }
}
