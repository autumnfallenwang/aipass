import { and, eq } from "drizzle-orm";
import { fhirAuthBind } from "./fhir.ts";
import type { Db } from "./index.ts";
import { chatLinks, fhirServers, modelConnections, vault } from "./schema.ts";
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
    if (s.clientSecretSealed) {
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
    if (s.authHeaderSealed) {
      const bind = fhirAuthBind(s.id);
      try {
        const header = unseal(keys, s.authHeaderSealed, bind);
        await db
          .update(fhirServers)
          .set({ authHeaderSealed: seal(current, header, bind) })
          .where(eq(fhirServers.id, s.id));
        result.resealed++;
      } catch {
        result.failed.push(`FHIR server ${s.id}: aipass's credential`);
      }
    }
  }

  // S8: model keys and the built-in chat's tokens.
  for (const m of await db.select().from(modelConnections)) {
    if (!m.apiKeySealed) continue;
    const bind = `model|${m.id}`;
    try {
      const k = unseal(keys, m.apiKeySealed, bind);
      await db
        .update(modelConnections)
        .set({ apiKeySealed: seal(current, k, bind) })
        .where(eq(modelConnections.id, m.id));
      result.resealed++;
    } catch {
      result.failed.push(`model connection ${m.id}: API key`);
    }
  }
  for (const l of await db.select().from(chatLinks)) {
    const bind = `chat|${l.userId}|${l.agentId}`;
    try {
      const t = unseal(keys, l.tokensSealed, bind);
      await db
        .update(chatLinks)
        .set({ tokensSealed: seal(current, t, bind) })
        .where(and(eq(chatLinks.userId, l.userId), eq(chatLinks.agentId, l.agentId)));
      result.resealed++;
    } catch {
      result.failed.push(`built-in chat for ${l.userId} as ${l.agentId}`);
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
