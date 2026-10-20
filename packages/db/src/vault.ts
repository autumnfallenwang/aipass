import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const DEV_KEY = "aipass-dev-only-vault-key-do-not-use-in-production";

/** The vault key: AIPASS_VAULT_KEY (32+ characters) hashed to 256 bits. Required in production. */
export function vaultKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const k = env.AIPASS_VAULT_KEY;
  if (k && k.length >= 32) return createHash("sha256").update(k).digest();
  if (env.NODE_ENV === "production") {
    throw new Error("AIPASS_VAULT_KEY (32+ characters) is required in production");
  }
  return createHash("sha256").update(DEV_KEY).digest();
}

/**
 * Seals a secret with AES-256-GCM. `bind` (e.g. "person|server") is
 * authenticated, so a sealed value copied to another row won't open there.
 */
export function seal(key: Buffer, plaintext: string, bind: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(bind, "utf8"));
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return ["v1", iv, ct, c.getAuthTag()]
    .map((p) => (typeof p === "string" ? p : p.toString("base64url")))
    .join(".");
}

/** Opens a sealed value; throws if it was tampered with, moved, or sealed with another key. */
export function unseal(key: Buffer, sealed: string, bind: string): string {
  const [v, iv, ct, tag] = sealed.split(".");
  if (v !== "v1" || !iv || !ct || !tag) throw new Error("not a sealed value");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  d.setAAD(Buffer.from(bind, "utf8"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}
