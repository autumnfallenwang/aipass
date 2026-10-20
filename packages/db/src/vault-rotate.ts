import { and, eq } from "drizzle-orm";
import type { Db } from "./index.ts";
import { fhirServers, vault } from "./schema.ts";
import { seal, unseal } from "./vault.ts";

export type RotationResult = { resealed: number; failed: string[] };

/**
 * Re-seals everything in the vault with the current key (`keys[0]`), opening
 * each value with whichever key still fits. Values no key opens are left as
 * they are and listed, so nothing is lost by running it twice.
 */
export async function rotateVault(db: Db, keys: Buffer[]): Promise<RotationResult> {
  const [current] = keys;
  if (!current) throw new Error("no vault key");
  const result: RotationResult = { resealed: 0, failed: [] };

  for (const s of await db.select().from(fhirServers)) {
    if (!s.clientSecretSealed) continue;
    const bind = `server|${s.id}`;
    try {
      const secret = unseal(keys, s.clientSecretSealed, bind);
      await db
        .update(fhirServers)
        .set({ clientSecretSealed: seal(current, secret, bind) })
        .where(eq(fhirServers.id, s.id));
      result.resealed++;
    } catch {
      result.failed.push(`FHIR server ${s.id}: client secret`);
    }
  }

  for (const v of await db.select().from(vault)) {
    const bind = `${v.personId}|${v.serverId}`;
    try {
      const tokens = unseal(keys, v.tokensSealed, bind);
      await db
        .update(vault)
        .set({ tokensSealed: seal(current, tokens, bind) })
        .where(and(eq(vault.personId, v.personId), eq(vault.serverId, v.serverId)));
      result.resealed++;
    } catch {
      result.failed.push(`${v.personId} at ${v.serverId}`);
    }
  }
  return result;
}
