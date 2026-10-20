import { describe, expect, it } from "vitest";
import { grade, runChecks } from "../src/report.ts";
import type { ProbeResult } from "../src/types.ts";

const r = (status: ProbeResult["status"], leak = false): ProbeResult => ({
  id: "x",
  title: "x",
  tries: "x",
  status,
  leak,
  detail: "",
});

describe("grading", () => {
  it("is A only when every probe passes", () => {
    expect(grade(Array.from({ length: 12 }, () => r("pass"))).grade).toBe("A");
  });

  it("drops to B for one non-leak failure out of twelve", () => {
    expect(grade([...Array.from({ length: 11 }, () => r("pass")), r("fail")]).grade).toBe("B");
  });

  it("caps at D for one leak, however good the rest", () => {
    expect(grade([...Array.from({ length: 11 }, () => r("pass")), r("fail", true)]).grade).toBe(
      "D",
    );
  });

  it("is F for two leaks", () => {
    expect(
      grade([...Array.from({ length: 10 }, () => r("pass")), r("fail", true), r("fail", true)])
        .grade,
    ).toBe("F");
  });

  it("counts missing controls against the grade but reports them apart", () => {
    const g = grade([r("pass"), r("missing"), r("missing"), r("missing")]);
    expect(g.grade).toBe("F");
    expect(g.summary).toEqual({ pass: 1, fail: 0, missing: 3, leaks: 0 });
  });
});

describe("the control", () => {
  it("fails every probe when the allowed request doesn't work (an unreachable target can't look safe)", async () => {
    const unreachable = {
      name: "nowhere",
      version: "0",
      capabilities: {
        credentials: true,
        partialAccess: true,
        adminStop: true,
        personRevoke: true,
        audit: true,
        approvals: true,
      },
      credential: async () => ({ bearer: "x", agent: "all" as const }),
      read: async () => ({ status: "error" as const, text: "fetch failed" }),
      search: async () => ({ status: "error" as const, text: "fetch failed" }),
    };
    const report = await runChecks(unreachable);
    expect(report.grade).toBe("F");
    expect(
      report.results.every((x) => x.status === "fail" && x.detail.startsWith("not run:")),
    ).toBe(true);
  });
});
