import { describe, expect, it } from "vitest";
import { isInternalHost } from "../src/auth.ts";

describe("isInternalHost (which connection origins Better Auth must trust)", () => {
  it.each([
    "localhost",
    "127.0.0.1",
    "10.1.2.3",
    "192.168.0.9",
    "172.20.0.4",
    "keycloak",
    "idp.local",
    "[::1]",
    "fd12:3456::1",
  ])("%s is internal", (h) => expect(isInternalHost(h)).toBe(true));
  it.each(["accounts.google.com", "login.hospital.example", "172.32.0.1", "8.8.8.8", "11.0.0.1"])(
    "%s is public",
    (h) => expect(isInternalHost(h)).toBe(false),
  );
});
