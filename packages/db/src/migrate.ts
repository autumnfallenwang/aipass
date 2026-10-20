/** Applies pending migrations from ./drizzle. `pnpm db:migrate` */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "./index.ts";

export async function runMigrations(url?: string): Promise<void> {
  const { db, close } = createDb(url);
  try {
    await migrate(db, { migrationsFolder: join(import.meta.dirname, "..", "drizzle") });
  } finally {
    await close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runMigrations();
  console.info("migrations applied");
}
