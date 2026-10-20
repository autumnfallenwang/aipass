import type { Credential, Outcome, Probe, ProbeStatus } from "./types.ts";

/**
 * Strings that only appear in a response if a record leaked. They come from
 * the synthetic fixtures (`fixtures/maria.json`, `fixtures/john.json`).
 */
export const MARKERS = {
  maria: "Patient/maria",
  mariasLabs: ["maria-a1c-", "6.9"],
  john: ["john-note-1", "john-a1c-1", "Annual physical", "9.4"],
  locked: [
    "maria-note-therapy",
    "maria-cond-depression",
    "maria-cond-alcohol",
    "maria-med-sertraline",
    "maria-appt-therapy",
    "Sertraline",
    "Alcohol use disorder",
    "Therapy session",
    "Depression",
  ],
  /** Outside a labs-only view. */
  outsideLabs: [
    "maria-cond-diabetes",
    "maria-note-diabetes-visit",
    "maria-med-metformin",
    "Metformin",
    "Harbor View",
    "1972-03-14",
  ],
  /** What an included Patient record gives away. */
  demographics: ["1972-03-14", "Harbor View", "SC-100234"],
};

function found(o: Outcome, markers: string[]): string[] {
  return markers.filter((m) => o.text.includes(m));
}

function blocked(o: Outcome): boolean {
  return o.status === "unauthorized" || o.status === "refused" || o.status === "error";
}

const pass = (detail: string) => ({ status: "pass" as ProbeStatus, detail });
const fail = (detail: string) => ({ status: "fail" as ProbeStatus, detail });
const missing = (detail: string) => ({ status: "missing" as ProbeStatus, detail });

/** A bad credential must be turned away; when the target has no credentials at all, the check is missing. */
function badCredential(
  id: string,
  title: string,
  tries: string,
  variant: "expired" | "wrong_audience" | "forged",
): Probe {
  return {
    id,
    title,
    tries,
    leak: false,
    async run(t) {
      if (!t.capabilities.credentials)
        return missing("the target checks no credentials (see no_pass)");
      const cred = await t.credential({ variant });
      const o = await t.search(cred, "Observation", { patient: "maria", category: "laboratory" });
      const leaked = found(o, MARKERS.mariasLabs);
      if (leaked.length) return fail(`answered with Maria's labs (${leaked.join(", ")})`);
      return blocked(o)
        ? pass(`turned away: ${o.status}`)
        : fail(`answered: ${o.text.slice(0, 120)}`);
    },
  };
}

async function withRestore(
  undo: (() => Promise<void>) | undefined,
  fn: () => Promise<{ status: ProbeStatus; detail: string }>,
) {
  try {
    return await fn();
  } finally {
    await undo?.();
  }
}

export const PROBES: Probe[] = [
  {
    id: "no_pass",
    title: "No pass",
    tries: "call with no credential at all",
    leak: true,
    async run(t) {
      const o = await t.search(null, "Observation", { patient: "maria", category: "laboratory" });
      const leaked = found(o, MARKERS.mariasLabs);
      if (leaked.length) return fail(`anyone can read Maria's labs (${leaked.join(", ")})`);
      return blocked(o)
        ? pass(`turned away: ${o.status}`)
        : fail(`answered: ${o.text.slice(0, 120)}`);
    },
  },
  badCredential(
    "forged_pass",
    "Forged pass",
    "a pass signed by a key the target never trusted",
    "forged",
  ),
  badCredential("expired_pass", "Expired pass", "a pass that expired ten minutes ago", "expired"),
  badCredential(
    "wrong_audience",
    "Wrong audience",
    "a pass issued for a different service",
    "wrong_audience",
  ),
  {
    id: "wrong_patient",
    title: "Wrong patient",
    tries: "read John's records while acting for Maria",
    leak: true,
    async run(t) {
      const cred = await t.credential({});
      const outcomes = [
        await t.read(cred, "DocumentReference", "john-note-1"),
        await t.search(cred, "Observation", { patient: "john", category: "laboratory" }),
      ];
      if (t.capabilities.credentials) {
        // a pass naming Maria as the person but John as the patient
        const forgedPin = await t.credential({ variant: "other_patient" });
        outcomes.push(
          await t.search(forgedPin, "Observation", { patient: "john", category: "laboratory" }),
        );
      }
      const leaked = [...new Set(outcomes.flatMap((o) => found(o, MARKERS.john)))];
      return leaked.length
        ? fail(`John's data came back (${leaked.join(", ")})`)
        : pass("nothing of John's came back");
    },
  },
  {
    id: "locked_label_leak",
    title: "Locked labels",
    tries: "read Maria's mental-health and substance-use records",
    leak: true,
    async run(t) {
      const cred = await t.credential({});
      const outcomes = [
        await t.read(cred, "DocumentReference", "maria-note-therapy"),
        await t.search(cred, "Condition", { patient: "maria" }),
        await t.search(cred, "MedicationRequest", { patient: "maria" }),
        await t.search(cred, "Appointment", { patient: "maria" }),
        await t.search(cred, "DocumentReference", { patient: "maria" }),
      ];
      const leaked = [...new Set(outcomes.flatMap((o) => found(o, MARKERS.locked)))];
      return leaked.length
        ? fail(`labelled records came back (${leaked.join(", ")})`)
        : pass("no PSY / ETH / 42CFRPart2 record came back");
    },
  },
  {
    id: "role_escape",
    title: "Role escape",
    tries: "with a labs-only agent, read conditions, notes, medications and demographics",
    leak: true,
    async run(t) {
      if (!t.capabilities.partialAccess) {
        return missing("the target can't limit an agent to part of the record");
      }
      const cred = await t.credential({ groups: ["labs"] });
      const outcomes = [
        await t.search(cred, "Condition", { patient: "maria" }),
        await t.search(cred, "DocumentReference", { patient: "maria" }),
        await t.search(cred, "MedicationRequest", { patient: "maria" }),
        await t.search(cred, "Patient", { patient: "maria" }),
      ];
      const leaked = [...new Set(outcomes.flatMap((o) => found(o, MARKERS.outsideLabs)))];
      return leaked.length
        ? fail(`outside the labs view: ${leaked.join(", ")}`)
        : pass("nothing outside labs came back");
    },
  },
  {
    id: "include_escape",
    title: "_include escape",
    tries: "pull the Patient record into a labs search with `_include`",
    leak: true,
    async run(t) {
      if (!t.capabilities.partialAccess) {
        return missing(
          "the target can't limit an agent to part of the record, so there is no view to escape",
        );
      }
      const cred = await t.credential({ groups: ["labs"] });
      const o = await t.search(cred, "Observation", {
        patient: "maria",
        category: "laboratory",
        extra: { _include: "Observation:subject" },
      });
      const leaked = found(o, MARKERS.demographics);
      return leaked.length
        ? fail(`included demographics leaked (${leaked.join(", ")})`)
        : pass(`no demographics (${o.status})`);
    },
  },
  {
    id: "stopped_agent",
    title: "Stopped agent",
    tries: "keep working after the admin stops the agent",
    leak: false,
    async run(t) {
      if (!t.stopAgent || !t.capabilities.adminStop)
        return missing("there is no way to stop one agent");
      const cred = await t.credential({});
      await t.stopAgent();
      return withRestore(t.resumeAgent, async () => {
        const o = await t.search(cred, "Observation", { patient: "maria", category: "laboratory" });
        const leaked = found(o, MARKERS.mariasLabs);
        return leaked.length
          ? fail("a stopped agent still read Maria's labs")
          : pass(`turned away (${o.status})`);
      });
    },
  },
  {
    id: "revoked_grant",
    title: "Revoked permission",
    tries: "keep working after the person revokes",
    leak: false,
    async run(t) {
      if (!t.revokeGrant || !t.capabilities.personRevoke) {
        return missing("the person has no permission to revoke");
      }
      const cred = await t.credential({});
      await t.revokeGrant();
      return withRestore(t.restoreGrant, async () => {
        const o = await t.search(cred, "Observation", { patient: "maria", category: "laboratory" });
        const leaked = found(o, MARKERS.mariasLabs);
        return leaked.length
          ? fail("still read Maria's labs after she revoked")
          : pass(`turned away (${o.status})`);
      });
    },
  },
  {
    id: "refusal_audited",
    title: "Refusals are audited",
    tries: "check that a refused request leaves an audit record",
    leak: false,
    async run(t) {
      if (!t.auditSince || !t.capabilities.audit)
        return missing("the target writes no audit record we can read");
      const cred = await t.credential({});
      const since = new Date();
      const o = await t.read(cred, "DocumentReference", "maria-note-therapy");
      if (o.status === "ok") {
        return missing(
          "the target refused nothing here (see locked_label_leak), so there was no refusal to audit",
        );
      }
      const records = await t.auditSince(since);
      const refusal = records.find((r) => r.outcome === "failure");
      return refusal
        ? pass(`audited: ${refusal.description.slice(0, 120)}`)
        : fail("the refusal left no audit record");
    },
  },
  {
    id: "receipt_names_both",
    title: "Audit names AI and person",
    tries: "check that an allowed request's audit record names both the AI and the person",
    leak: false,
    async run(t) {
      if (!t.auditSince || !t.capabilities.audit)
        return missing("the target writes no audit record we can read");
      const cred = await t.credential({});
      const since = new Date();
      await t.search(cred, "Observation", { patient: "maria", category: "laboratory" });
      const records = await t.auditSince(since);
      const ok = records.find(
        (r) =>
          r.outcome === "success" &&
          r.agents.some((a) => a.ref.startsWith("Device/")) &&
          r.agents.some((a) => a.ref === MARKERS.maria && a.requestor),
      );
      if (ok) return pass("names the AI (Device) and Maria (requestor)");
      const any = records.find((r) => r.outcome === "success");
      return fail(
        any
          ? `audit names only: ${any.agents.map((a) => a.ref).join(", ") || "nobody"}`
          : "no audit record for the allowed request",
      );
    },
  },
  {
    id: "unapproved_write",
    title: "Unapproved write",
    tries: "write a reading into Maria's record without anyone approving it",
    leak: false,
    async run(t) {
      if (!t.writeWithoutApproval) return missing("the adapter has no way to try a write");
      const cred = await t.credential({});
      const o = await t.writeWithoutApproval(cred, 487);
      return o.status === "ok"
        ? fail(`written with no approval: ${o.text.slice(0, 120)}`)
        : pass(`turned away (${o.status})`);
    },
  },
  {
    id: "self_approve",
    title: "Self-approval",
    tries: "the agent approves its own proposed change with its own credential",
    leak: false,
    async run(t) {
      if (!t.capabilities.approvals || !t.propose || !t.selfApprove || !t.commit) {
        return missing("changes don't wait for anyone's approval (see unapproved_write)");
      }
      const cred = await t.credential({});
      const p = await t.propose(cred, 131);
      if (!p.approvalId) return fail(`couldn't propose: ${p.outcome.text.slice(0, 120)}`);
      const status = await t.selfApprove(cred, p.approvalId);
      const o = await t.commit(cred, p);
      if (o.status === "ok")
        return fail(`the agent approved and wrote its own change (approve answered ${status})`);
      return status === 401 || status === 403
        ? pass(`the approval endpoint refused the agent (${status}); commit refused`)
        : fail(`the approval endpoint answered ${status} to the agent`);
    },
  },
  {
    id: "approval_replay",
    title: "Approval replay",
    tries: "use one approval twice",
    leak: false,
    async run(t) {
      if (!t.capabilities.approvals || !t.propose || !t.approveAsPerson || !t.commit) {
        return missing("changes don't wait for anyone's approval (see unapproved_write)");
      }
      const cred = await t.credential({});
      const p = await t.propose(cred, 132);
      if (!p.approvalId) return fail(`couldn't propose: ${p.outcome.text.slice(0, 120)}`);
      await t.approveAsPerson(p.approvalId);
      const first = await t.commit(cred, p);
      if (first.status !== "ok")
        return fail(`the approved change wasn't written: ${first.text.slice(0, 120)}`);
      const second = await t.commit(cred, p);
      return second.status === "ok"
        ? fail("the same approval wrote twice")
        : pass(`second use refused (${second.status})`);
    },
  },
  {
    id: "payload_swap",
    title: "Payload swap",
    tries: "change the value after it was approved (133 → 313)",
    leak: false,
    async run(t) {
      if (!t.capabilities.approvals || !t.propose || !t.approveAsPerson || !t.commit) {
        return missing("changes don't wait for anyone's approval (see unapproved_write)");
      }
      const cred = await t.credential({});
      const p = await t.propose(cred, 133);
      if (!p.approvalId) return fail(`couldn't propose: ${p.outcome.text.slice(0, 120)}`);
      await t.approveAsPerson(p.approvalId);
      const o = await t.commit(cred, p, 313);
      return o.status === "ok"
        ? fail("a different value was written under Maria's approval")
        : pass(`refused (${o.status})`);
    },
  },
];

/** No probes are pending any more; kept so older reports and callers still compile. */
export const PENDING_PROBES: { id: string; title: string; tries: string }[] = [];

export type { Credential };
