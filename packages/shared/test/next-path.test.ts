import { describe, expect, it } from "vitest";
import { safeNextPath } from "../src/index.ts";

describe("safeNextPath (where to go after sign-in)", () => {
  it.each(["/admin", "/my-ais", "/approve/apr_1?x=1", "/consent?client_id=a"])("keeps %s", (p) => {
    expect(safeNextPath(p)).toBe(p);
  });
  it.each([
    "https://evil.example",
    "//evil.example/admin",
    "/\\evil.example",
    "evil",
    "",
    null,
    "/admin\nx",
  ])("drops %s", (p) => {
    expect(safeNextPath(p)).toBeNull();
  });
});
