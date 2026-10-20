import { type Db, passKeys } from "@aipass/db";
import { isNull } from "drizzle-orm";
import { type CryptoKey, exportJWK, generateKeyPair, importJWK, type JWK } from "jose";

export const PASS_ALG = "ES256";

export type SigningKey = { kid: string; key: CryptoKey; publicJwk: JWK };

let cached: SigningKey | undefined;

/** The active signing key, created on first use and kept in the database. */
export async function activeKey(db: Db): Promise<SigningKey> {
  if (cached) return cached;
  let [row] = await db.select().from(passKeys).where(isNull(passKeys.retiredAt)).limit(1);
  if (!row) {
    const { publicKey, privateKey } = await generateKeyPair(PASS_ALG, { extractable: true });
    const kid = `pass-${Date.now().toString(36)}`;
    const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: PASS_ALG, use: "sig" };
    const privateJwk = { ...(await exportJWK(privateKey)), kid, alg: PASS_ALG };
    [row] = await db
      .insert(passKeys)
      .values({ kid, alg: PASS_ALG, publicJwk, privateJwk })
      .onConflictDoNothing()
      .returning();
    if (!row) return activeKey(db);
  }
  const key = (await importJWK(row.privateJwk as JWK, PASS_ALG)) as CryptoKey;
  cached = { kid: row.kid, key, publicJwk: row.publicJwk as JWK };
  return cached;
}

/** Public keys for `/.well-known/jwks.json`, including retired ones still inside a pass lifetime. */
export async function publicJwks(db: Db): Promise<{ keys: JWK[] }> {
  await activeKey(db);
  const rows = await db.select().from(passKeys);
  const cutoff = Date.now() - 10 * 60_000;
  return {
    keys: rows
      .filter((r) => !r.retiredAt || r.retiredAt.getTime() > cutoff)
      .map((r) => r.publicJwk as JWK),
  };
}
