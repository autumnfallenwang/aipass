import { describe, expect, it } from "vitest";
import { type CommitContext, decideCommit } from "../src/index.ts";

const now = new Date("2026-10-19T12:00:00Z");
const base: CommitContext = {
  approval: {
    agentId: "diabetes-coach",
    personId: "maria",
    status: "approved",
    payloadHash: "abc",
    approvedAt: new Date(now.getTime() - 30_000),
    expiresAt: new Date(now.getTime() + 600_000),
  },
  agentId: "diabetes-coach",
  personId: "maria",
  approverName: "Maria Santos",
  payloadHash: "abc",
  now,
};
const withApproval = (a: Partial<NonNullable<CommitContext["approval"]>>): CommitContext => ({
  ...base,
  approval: { ...(base.approval as NonNullable<CommitContext["approval"]>), ...a },
});

describe("decideCommit (rule 7)", () => {
  it.each<[string, CommitContext, string | null]>([
    ["approved, fresh, matching", base, null],
    ["no approval", { ...base, approval: null }, "no such approval"],
    [
      "another agent's approval looks like none",
      { ...base, agentId: "scheduling-assistant" },
      "no such approval",
    ],
    [
      "another person's approval looks like none",
      { ...base, personId: "john" },
      "no such approval",
    ],
    [
      "still pending",
      withApproval({ status: "pending", approvedAt: null }),
      "waiting for Maria's OK",
    ],
    [
      "pending past its expiry",
      withApproval({ status: "pending", approvedAt: null, expiresAt: new Date(now.getTime() - 1) }),
      "the proposal expired before it was approved",
    ],
    ["denied (A7)", withApproval({ status: "denied" }), "Maria said no"],
    ["used (A4)", withApproval({ status: "used" }), "this approval was already used"],
    [
      "approved more than 2 minutes ago (A5)",
      withApproval({ approvedAt: new Date(now.getTime() - 121_000) }),
      "the approval expired (commit within 2 minutes of approving)",
    ],
    [
      "payload changed (A3)",
      { ...base, payloadHash: "xyz" },
      "the change doesn't match what Maria approved",
    ],
  ])("%s", (_name, ctx, reason) => {
    const v = decideCommit(ctx);
    if (reason === null) expect(v).toEqual({ decision: "allow" });
    else expect(v).toMatchObject({ decision: "refuse", rule: 7, reason });
  });
});
