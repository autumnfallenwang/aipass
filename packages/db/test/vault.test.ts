import { describe, expect, it } from "vitest";
import { seal, unseal, vaultKey } from "../src/vault.ts";

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
});
