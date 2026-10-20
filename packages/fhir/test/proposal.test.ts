import { describe, expect, it } from "vitest";
import {
  approvalChallenge,
  buildProposedObservation,
  describeChange,
  payloadHash,
} from "../src/index.ts";

const change = { measure: "blood_glucose" as const, value: 130, effective: "2026-10-19T08:00:00Z" };

describe("proposed changes", () => {
  it("builds the exact Observation that will be written", () => {
    const o = buildProposedObservation(change, "Patient/maria");
    expect(o).toMatchObject({
      resourceType: "Observation",
      subject: { reference: "Patient/maria" },
      code: { coding: [{ system: "http://loinc.org", code: "2339-0" }] },
      valueQuantity: { value: 130, unit: "mg/dL" },
      effectiveDateTime: "2026-10-19T08:00:00.000Z",
    });
  });

  it("hashes canonically: key order doesn't matter, any value change does", () => {
    const o = buildProposedObservation(change, "Patient/maria");
    const reordered = Object.fromEntries(Object.entries(o).reverse()) as typeof o;
    expect(payloadHash(reordered)).toBe(payloadHash(o));
    expect(
      payloadHash(buildProposedObservation({ ...change, value: 310 }, "Patient/maria")),
    ).not.toBe(payloadHash(o));
    expect(payloadHash(buildProposedObservation(change, "Patient/john"))).not.toBe(payloadHash(o));
  });

  it("binds the passkey challenge to the hash, the approval and the nonce", () => {
    const c = (h: string, id: string, n: string) =>
      Buffer.from(approvalChallenge(h, id, n)).toString("hex");
    expect(c("h", "a1", "n")).toBe(c("h", "a1", "n"));
    expect(c("h", "a1", "n")).not.toBe(c("h2", "a1", "n"));
    expect(c("h", "a1", "n")).not.toBe(c("h", "a2", "n"));
    expect(c("h", "a1", "n")).not.toBe(c("h", "a1", "n2"));
  });

  it("refuses values outside the measure's range, unknown measures and future readings", () => {
    expect(() => buildProposedObservation({ ...change, value: 9999 }, "Patient/maria")).toThrow(
      /between/,
    );
    expect(() =>
      buildProposedObservation(
        { ...change, measure: "cholesterol" as "blood_glucose" },
        "Patient/maria",
      ),
    ).toThrow(/unknown measure/);
    expect(() =>
      buildProposedObservation({ ...change, effective: "2099-01-01T00:00:00Z" }, "Patient/maria"),
    ).toThrow(/future/);
  });

  it("describes the change in plain words", () => {
    expect(describeChange(change)).toBe(
      "Blood glucose 130 mg/dL, measured Mon, 19 Oct 2026 08:00 UTC",
    );
  });
});
