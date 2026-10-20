import { describe, expect, it } from "vitest";
import { seal, unseal, vaultKey, vaultKeys } from "../src/vault.ts";

const key = vaultKey({ AIPASS_VAULT_KEY: "a-test-vault-key-that-is-long-enough-123" });

describe("the vault's sealing (AES-256-GCM)", () => {
  it("opens what it sealed, for the same person and server", () => {
    const s = seal(key, "upstream-token", "maria|ehr");
    expect(s).not.toContain("upstream-token");
    expect(unseal(key, s, "maria|ehr")).toBe("upstream-token");
  });

  it("seals the same thing differently each time", () => {
    expect(seal(key, "x", "a")).not.toBe(seal(key, "x", "a"));
  });

  it("won't open a value moved to another person or server", () => {
    const s = seal(key, "upstream-token", "maria|ehr");
    expect(() => unseal(key, s, "john|ehr")).toThrow();
    expect(() => unseal(key, s, "maria|other")).toThrow();
  });

  it("won't open a tampered value or one sealed with another key", () => {
    const s = seal(key, "upstream-token", "maria|ehr");
    const [v, iv, ct, tag] = s.split(".");
    const flipped = `${v}.${iv}.${ct?.slice(0, -2)}${ct?.endsWith("A") ? "B" : "A"}${ct?.slice(-1)}.${tag}`;
    expect(() => unseal(key, flipped, "maria|ehr")).toThrow();
    const other = vaultKey({ AIPASS_VAULT_KEY: "another-test-vault-key-also-long-enough" });
    expect(() => unseal(other, s, "maria|ehr")).toThrow();
    expect(() => unseal(key, "not-sealed", "maria|ehr")).toThrow("not a sealed value");
  });

  it("needs a real key in production", () => {
    expect(() => vaultKey({ NODE_ENV: "production" })).toThrow("AIPASS_VAULT_KEY");
    expect(() => vaultKey({ NODE_ENV: "production", AIPASS_VAULT_KEY: "short" })).toThrow();
    expect(vaultKey({}).length).toBe(32);
  });

  it("opens with a previous key during a rotation, and seals only with the current one", () => {
    const env = {
      AIPASS_VAULT_KEY: "the-new-vault-key-that-is-long-enough-456",
      AIPASS_VAULT_KEY_PREVIOUS: "a-test-vault-key-that-is-long-enough-123",
    };
    const keys = vaultKeys(env);
    expect(keys).toHaveLength(2);
    expect(keys[0]?.equals(vaultKey(env))).toBe(true);
    const old = seal(key, "upstream-token", "maria|ehr");
    expect(unseal(keys, old, "maria|ehr")).toBe("upstream-token");
    expect(() => unseal(keys[0] as Buffer, old, "maria|ehr")).toThrow();
    expect(() => vaultKeys({ ...env, AIPASS_VAULT_KEY_PREVIOUS: "too-short" })).toThrow();
  });

  it("refuses the public local-trial key anywhere but localhost", () => {
    const trial = {
      NODE_ENV: "production",
      AIPASS_VAULT_KEY: "aipass-local-trial-vault-key-localhost-only",
    };
    expect(vaultKey({ ...trial, PUBLIC_URL: "http://localhost:3000" }).length).toBe(32);
    expect(() => vaultKey({ ...trial, PUBLIC_URL: "https://aipass.example.org" })).toThrow(
      "local-trial",
    );
  });
});
