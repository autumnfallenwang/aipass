/** `pnpm db:migrate`: applies pending migrations to DATABASE_URL. */
import { runMigrations } from "../src/migrate.ts";

await runMigrations();
console.info("migrations applied");
