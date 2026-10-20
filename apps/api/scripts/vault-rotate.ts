/**
 * Re-seals the vault with a new key (S7).
 *
 *   AIPASS_VAULT_KEY=<new> AIPASS_VAULT_KEY_PREVIOUS=<old> pnpm vault:rotate
 *
 * Run it while the api and gateway already have both keys (so nothing breaks
 * in between), then drop the old key from AIPASS_VAULT_KEY_PREVIOUS.
 */
import { createDb, rotateVault, vaultKeys } from "@aipass/db";
import { config } from "../src/config.ts";

const keys = vaultKeys();
if (keys.length < 2) {
  console.error(
    "set AIPASS_VAULT_KEY to the new key and AIPASS_VAULT_KEY_PREVIOUS to the old one(s)",
  );
  process.exit(1);
}
const { db, close } = createDb(config.databaseUrl);
try {
  const r = await rotateVault(db, keys);
  console.info(`re-sealed ${r.resealed} value(s) with the current key`);
  for (const f of r.failed) console.error(`couldn't open with any key, left as is: ${f}`);
  process.exitCode = r.failed.length ? 1 : 0;
} finally {
  await close();
}
