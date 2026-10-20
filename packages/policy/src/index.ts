/**
 * The aipass decision rule. Pure functions over plain data: no FHIR client,
 * no database, no framework. Every refusal names the first rule that failed.
 *
 *   1. the pass is valid
 *   2. the agent is active
 *   3. the role permits group + action
 *   4. the person's grant permits it
 *   5. the resource is in the person's patient compartment
 *   6. no locked label on the resource
 *   7. (writes) a matching, unused approval exists        — see decideCommit
 *
 * Rule 0 means the check itself couldn't run (a server down, a bad answer).
 * That is a refusal too: fail closed.
 */
import {
  type Action,
  type AgentStatus,
  GROUP_LABELS,
  type GrantStatus,
  type Group,
  HARMLESS_LABELS,
  LOCKED_LABELS,
  type LockedLabel,
  type Permission,
  permission,
} from "@aipass/shared";

export type RefusalCode =
  | "pass_invalid"
  | "agent_unknown"
  | "agent_stopped"
  | "client_not_approved"
  | "role_missing"
  | "role_denies"
  | "person_unknown"
  | "grant_missing"
  | "grant_revoked"
  | "grant_denies"
  | "outside_request"
  | "unknown_record_type"
  | "not_in_compartment"
  | "locked_label"
  | "unknown_label"
  | "approval_missing"
  | "approval_pending"
  | "approval_denied"
  | "approval_expired"
  | "approval_used"
  | "approval_mismatch"
  | "approval_wrong_person"
  | "approval_not_verified"
  | "check_failed"
  | "invalid_change";

export type Rule = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type Allow = { decision: "allow" };
export type Refuse = { decision: "refuse"; rule: Rule; code: RefusalCode; reason: string };
export type Verdict = Allow | Refuse;

export const ALLOW: Allow = { decision: "allow" };

export function refuse(rule: Rule, code: RefusalCode, reason: string): Refuse {
  return { decision: "refuse", rule, code, reason };
}

export function firstName(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] || displayName;
}

export type PassCheck = { ok: true } | { ok: false; error: string };

export type RequestContext = {
  pass: PassCheck;
  agent: { id: string; name: string; status: AgentStatus } | null;
  /**
   * The AI app (OAuth client) that holds the pass, when the pass came from
   * OAuth. Dev passes and token-exchange passes have none.
   */
  client?: { id: string; approved: boolean } | null;
  role: { name: string; permissions: readonly Permission[] } | null;
  person: { id: string; displayName: string } | null;
  grant: { status: GrantStatus; permissions: readonly Permission[] } | null;
  request: { group: Group; action: Action };
};

/** Rules 1–4: may this agent, for this person, do this action on this group at all? */
export function decideRequest(ctx: RequestContext): Verdict {
  const { group, action } = ctx.request;
  const perm = permission(group, action);
  const label = GROUP_LABELS[group].many;

  if (!ctx.pass.ok) return refuse(1, "pass_invalid", `no valid pass (${ctx.pass.error})`);

  if (!ctx.agent) return refuse(2, "agent_unknown", "unknown agent");
  if (ctx.agent.status !== "active") return refuse(2, "agent_stopped", "agent stopped by admin");
  if (ctx.client && !ctx.client.approved) {
    return refuse(2, "client_not_approved", `this app isn't approved to act as ${ctx.agent.name}`);
  }

  if (!ctx.role) return refuse(3, "role_missing", `${ctx.agent.name} has no role`);
  if (!ctx.role.permissions.includes(perm)) {
    return refuse(3, "role_denies", `not in the ${ctx.role.name} role`);
  }

  if (!ctx.person) return refuse(4, "person_unknown", "unknown person");
  const who = firstName(ctx.person.displayName);
  if (!ctx.grant)
    return refuse(4, "grant_missing", `${who} hasn't agreed to ${verb(action)}${label}`);
  if (ctx.grant.status !== "active") {
    return refuse(4, "grant_revoked", `${who} hasn't agreed to ${verb(action)}${label}`);
  }
  if (!ctx.grant.permissions.includes(perm)) {
    return refuse(4, "grant_denies", `${who} hasn't agreed to ${verb(action)}${label}`);
  }
  return ALLOW;
}

function verb(action: Action): string {
  if (action === "propose") return "proposals for ";
  if (action === "write") return "changes to ";
  return "";
}

/** What the gateway knows about one returned record. FHIR parsing lives in `@aipass/fhir`. */
export type ResourceFacts = {
  /** Which group the record belongs to, or null when it fits no group. */
  group: Group | null;
  /** Patient references the record points at, normalised as `Patient/<id>`. */
  patientRefs: readonly string[];
  /** `meta.security` codings. */
  labels: readonly { system?: string; code?: string }[];
};

export type ResourceContext = {
  person: { displayName: string };
  /** The patient the pass is pinned to, as `Patient/<id>`. */
  patientRef: string;
  /** The group the request asked for. */
  requestGroup: Group;
};

const LABEL_REASONS: Record<LockedLabel["kind"], string> = {
  "mental-health": "mental-health records are always private",
  "substance-use": "substance-use records are always private",
  hiv: "HIV-related records are always private",
  restricted: "restricted records are always private",
};

export function lockedLabelOf(label: { system?: string; code?: string }): LockedLabel | undefined {
  return LOCKED_LABELS.find((l) => l.system === label.system && l.code === label.code);
}

function isHarmless(label: { system?: string; code?: string }): boolean {
  return HARMLESS_LABELS.some((l) => l.system === label.system && l.code === label.code);
}

/** Rules 3, 5 and 6 applied to one returned record. Run on every record, every page. */
export function decideResource(ctx: ResourceContext, facts: ResourceFacts): Verdict {
  if (facts.group === null) {
    return refuse(3, "unknown_record_type", "records of an unrecognised type are withheld");
  }
  if (facts.group !== ctx.requestGroup) {
    return refuse(3, "outside_request", "records outside this request are withheld");
  }

  const refs = facts.patientRefs;
  if (refs.length === 0 || refs.some((r) => r !== ctx.patientRef)) {
    return refuse(5, "not_in_compartment", `not ${firstName(ctx.person.displayName)}'s record`);
  }

  for (const label of facts.labels) {
    const locked = lockedLabelOf(label);
    if (locked) return refuse(6, "locked_label", LABEL_REASONS[locked.kind]);
  }
  for (const label of facts.labels) {
    if (!isHarmless(label)) {
      return refuse(
        6,
        "unknown_label",
        "records with an unrecognised sensitivity label are withheld",
      );
    }
  }
  return ALLOW;
}

/** Role ceiling ∩ the person's grant. What the agent can actually do for this person right now. */
export function effectivePermissions(
  role: { permissions: readonly Permission[] } | null,
  grant: { status: GrantStatus; permissions: readonly Permission[] } | null,
): Permission[] {
  if (!role || !grant || grant.status !== "active") return [];
  return role.permissions.filter((p) => grant.permissions.includes(p));
}

/** What the gateway knows about an approval when the agent commits (rule 7). */
export type CommitContext = {
  approval: {
    agentId: string;
    personId: string;
    status: "pending" | "approved" | "used" | "denied" | "expired";
    payloadHash: string;
    approvedAt: Date | null;
    expiresAt: Date;
  } | null;
  agentId: string;
  personId: string;
  approverName: string;
  /** Hash of the change the agent is committing now. */
  payloadHash: string;
  now: Date;
};

/** How long after approval a change may be committed. */
export const APPROVAL_WINDOW_SECONDS = 120;

/**
 * Rule 7: a write needs a matching, unused, fresh approval for this agent and
 * this person. The rule behind it: an approval is real only if nothing the
 * agent holds can produce it.
 */
export function decideCommit(c: CommitContext): Verdict {
  const a = c.approval;
  const who = firstName(c.approverName);
  // Someone else's approval looks exactly like no approval.
  if (!a || a.agentId !== c.agentId || a.personId !== c.personId) {
    return refuse(7, "approval_missing", "no such approval");
  }
  if (a.status === "denied") return refuse(7, "approval_denied", `${who} said no`);
  if (a.status === "used") return refuse(7, "approval_used", "this approval was already used");
  if (a.status === "pending") {
    return a.expiresAt <= c.now
      ? refuse(7, "approval_expired", "the proposal expired before it was approved")
      : refuse(7, "approval_pending", `waiting for ${who}'s OK`);
  }
  if (
    a.status === "expired" ||
    !a.approvedAt ||
    c.now.getTime() - a.approvedAt.getTime() > APPROVAL_WINDOW_SECONDS * 1000
  ) {
    return refuse(
      7,
      "approval_expired",
      "the approval expired (commit within 2 minutes of approving)",
    );
  }
  if (a.payloadHash !== c.payloadHash) {
    return refuse(7, "approval_mismatch", `the change doesn't match what ${who} approved`);
  }
  return ALLOW;
}
