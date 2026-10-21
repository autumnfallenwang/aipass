import { type Permission, V3_ACT_CODE, V3_CONFIDENTIALITY } from "@aipass/shared";
import { describe, expect, it } from "vitest";
import {
  decideRequest,
  decideResource,
  effectivePermissions,
  firstName,
  type RequestContext,
  type ResourceContext,
  type ResourceFacts,
} from "../src/index.ts";

const coachRole: Permission[] = [
  "labs:read",
  "labs:propose",
  "vitals:read",
  "medications:read",
  "conditions:read",
  "notes:read",
];
const schedulingRole: Permission[] = ["appointments:read", "demographics:read"];

const base: RequestContext = {
  pass: { ok: true },
  agent: { id: "diabetes-coach", name: "Diabetes Coach", status: "active" },
  role: { name: "Diabetes Coach", permissions: coachRole },
  person: { id: "maria", displayName: "Maria Santos" },
  grant: { status: "active", permissions: coachRole },
  request: { group: "labs", action: "read" },
};

describe("decideRequest (rules 1–4)", () => {
  const cases: [string, Partial<RequestContext>, string | null, number | null][] = [
    ["coach reads labs", {}, null, null],
    ["invalid pass", { pass: { ok: false, error: "expired" } }, "no valid pass (expired)", 1],
    ["unknown agent", { agent: null }, "unknown agent", 2],
    [
      "stopped agent",
      { agent: { id: "diabetes-coach", name: "Diabetes Coach", status: "stopped" } },
      "agent stopped by admin",
      2,
    ],
    ["no role", { role: null }, "Diabetes Coach has no role", 3],
    [
      "app not approved for this agent",
      { client: { id: "https://evil.example/app", approved: false } },
      "this app isn't approved to act as Diabetes Coach",
      2,
    ],
    ["approved app", { client: { id: "claude-code", approved: true } }, null, null],
    [
      "scheduling reads labs",
      { role: { name: "Scheduling Assistant", permissions: schedulingRole } },
      "not in the Scheduling Assistant role",
      3,
    ],
    ["unknown person", { person: null }, "unknown person", 4],
    [
      "person paused by the clinic (S9)",
      { person: { id: "maria", displayName: "Maria Santos", status: "suspended" } },
      "Maria's access is paused by the clinic",
      4,
    ],
    [
      "an active person",
      { person: { id: "maria", displayName: "Maria Santos", status: "active" } },
      null,
      null,
    ],
    ["no grant", { grant: null }, "Maria hasn't agreed to lab results", 4],
    [
      "revoked grant",
      { grant: { status: "revoked", permissions: coachRole } },
      "Maria hasn't agreed to lab results",
      4,
    ],
    [
      "grant without vitals",
      {
        grant: { status: "active", permissions: ["labs:read"] },
        request: { group: "vitals", action: "read" },
      },
      "Maria hasn't agreed to vital signs",
      4,
    ],
    [
      "proposal not granted",
      {
        grant: { status: "active", permissions: ["labs:read"] },
        request: { group: "labs", action: "propose" },
      },
      "Maria hasn't agreed to proposals for lab results",
      4,
    ],
    [
      "role ceiling beats a wider grant",
      {
        role: { name: "Scheduling Assistant", permissions: schedulingRole },
        grant: { status: "active", permissions: [...coachRole, ...schedulingRole] },
      },
      "not in the Scheduling Assistant role",
      3,
    ],
    [
      "stopped agent is reported before the role",
      {
        agent: { id: "x", name: "X", status: "stopped" },
        role: null,
      },
      "agent stopped by admin",
      2,
    ],
  ];

  it.each(cases)("%s", (_name, patch, reason, rule) => {
    const v = decideRequest({ ...base, ...patch });
    if (reason === null) {
      expect(v).toEqual({ decision: "allow" });
    } else {
      expect(v).toMatchObject({ decision: "refuse", reason, rule });
    }
  });
});

describe("decideResource (rules 3, 5, 6)", () => {
  const ctx: ResourceContext = {
    person: { displayName: "Maria Santos" },
    patientRef: "Patient/maria",
    requestGroup: "notes",
  };
  const note: ResourceFacts = { group: "notes", patientRefs: ["Patient/maria"], labels: [] };

  const cases: [string, Partial<ResourceFacts>, string | null, number | null][] = [
    ["plain visit note", {}, null, null],
    [
      "harmless confidentiality N",
      { labels: [{ system: V3_CONFIDENTIALITY, code: "N" }] },
      null,
      null,
    ],
    [
      "therapy note (PSY)",
      { labels: [{ system: V3_ACT_CODE, code: "PSY" }] },
      "mental-health records are always private",
      6,
    ],
    [
      "substance use (42CFRPart2)",
      { labels: [{ system: V3_ACT_CODE, code: "42CFRPart2" }] },
      "substance-use records are always private",
      6,
    ],
    [
      "substance use (ETH)",
      { labels: [{ system: V3_ACT_CODE, code: "ETH" }] },
      "substance-use records are always private",
      6,
    ],
    [
      "HIV",
      { labels: [{ system: V3_ACT_CODE, code: "HIV" }] },
      "HIV-related records are always private",
      6,
    ],
    [
      "restricted (R)",
      { labels: [{ system: V3_CONFIDENTIALITY, code: "R" }] },
      "restricted records are always private",
      6,
    ],
    [
      "unknown label fails closed",
      { labels: [{ system: "https://example.org/labels", code: "SECRET" }] },
      "records with an unrecognised sensitivity label are withheld",
      6,
    ],
    [
      "PSY code under the wrong system is still not trusted",
      { labels: [{ system: "https://example.org/labels", code: "PSY" }] },
      "records with an unrecognised sensitivity label are withheld",
      6,
    ],
    ["John's note", { patientRefs: ["Patient/john"] }, "not Maria's record", 5],
    ["no patient reference", { patientRefs: [] }, "not Maria's record", 5],
    ["mixed patients", { patientRefs: ["Patient/maria", "Patient/john"] }, "not Maria's record", 5],
    [
      "an included lab on a notes request",
      { group: "labs" },
      "records outside this request are withheld",
      3,
    ],
    [
      "record of an unknown type",
      { group: null },
      "records of an unrecognised type are withheld",
      3,
    ],
    [
      "compartment is checked before labels",
      { patientRefs: ["Patient/john"], labels: [{ system: V3_ACT_CODE, code: "PSY" }] },
      "not Maria's record",
      5,
    ],
  ];

  it.each(cases)("%s", (_name, patch, reason, rule) => {
    const v = decideResource(ctx, { ...note, ...patch });
    if (reason === null) {
      expect(v).toEqual({ decision: "allow" });
    } else {
      expect(v).toMatchObject({ decision: "refuse", reason, rule });
    }
  });
});

describe("staff members (S10)", () => {
  const staff: ResourceContext = {
    person: { displayName: "Dr. Grace Lee" },
    patientRef: "Patient/maria",
    staff: true,
    requestGroup: "labs",
  };
  const lab: ResourceFacts = { group: "labs", patientRefs: ["Patient/maria"], labels: [] };

  it("the patient they have open: allowed", () => {
    expect(decideResource(staff, lab)).toEqual({ decision: "allow" });
  });

  it("another patient's record: not the patient in context", () => {
    expect(decideResource(staff, { ...lab, patientRefs: ["Patient/john"] })).toMatchObject({
      decision: "refuse",
      rule: 5,
      code: "not_in_compartment",
      reason: "not the patient in context",
    });
  });

  it("locked labels apply to staff members too", () => {
    expect(
      decideResource(staff, { ...lab, labels: [{ system: V3_ACT_CODE, code: "PSY" }] }),
    ).toMatchObject({ rule: 6, reason: "mental-health records are always private" });
  });

  it.each([
    ["Maria Santos", "Maria"],
    ["Dr. Grace Lee", "Dr. Lee"],
    ["Dr Lee", "Dr Lee"],
    ["Carlo647 Kory651 Blanda868", "Carlo647"],
    ["Dr.", "Dr."],
  ])("names %s as %s", (full, short) => {
    expect(firstName(full)).toBe(short);
  });
});

describe("effectivePermissions = role ∩ grant", () => {
  it("is the intersection", () => {
    expect(
      effectivePermissions(
        { permissions: coachRole },
        { status: "active", permissions: ["labs:read", "appointments:read"] },
      ),
    ).toEqual(["labs:read"]);
  });

  it("is empty when the grant is revoked", () => {
    expect(
      effectivePermissions(
        { permissions: coachRole },
        { status: "revoked", permissions: coachRole },
      ),
    ).toEqual([]);
  });

  it("is empty without a role or a grant", () => {
    expect(effectivePermissions(null, { status: "active", permissions: coachRole })).toEqual([]);
    expect(effectivePermissions({ permissions: coachRole }, null)).toEqual([]);
  });
});
