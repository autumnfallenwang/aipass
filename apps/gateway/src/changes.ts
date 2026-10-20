import { randomBytes } from "node:crypto";
import { approvalRules, approvals, type Db, newId, persons } from "@aipass/db";
import {
  buildProposedObservation,
  buildProvenance,
  describeChange,
  MEASURES,
  ProposalError,
  type ProposedChange,
  payloadHash,
  receiptSentence,
} from "@aipass/fhir";
import { APPROVAL_WINDOW_SECONDS, decideCommit, type Refuse, refuse } from "@aipass/policy";
import type { Group } from "@aipass/shared";
import { and, eq } from "drizzle-orm";
import type { Defect } from "./broken.ts";
import type { GatewayConfig } from "./config.ts";
import type { Caller, Guard, Resolved } from "./guard.ts";
import { AuditWriteFailed, type Recorder } from "./recorder.ts";
import { isTarget } from "./upstream.ts";

/** How long a proposal waits for the person's OK. */
const PROPOSAL_MINUTES = 10;

export type ProposeOutcome =
  | {
      decision: "allow";
      approvalId: string;
      approveUrl: string;
      summary: string;
      approverName: string;
      expiresAt: Date;
      commitArgs: { approval_id: string } & ProposedChange;
      sentence: string;
    }
  | (Refuse & { sentence: string });

export type CommitOutcome =
  | { decision: "allow"; ref: string; summary: string; sentence: string }
  | (Refuse & { sentence: string });

/**
 * Changes with the person's approval (S5).
 *
 * 1. propose: check the agent may propose, build the exact resource, hash it,
 *    and store a pending approval. The agent gets a link for the person.
 * 2. the person approves on the web with their passkey (the api checks that).
 * 3. commit: the agent presents the same change; it is re-hashed and must
 *    match an approval that is approved, fresh, unused, for this agent and person.
 */
export class Changes {
  constructor(
    private readonly deps: {
      db: Db;
      config: GatewayConfig;
      recorder: Recorder;
      guard: Guard;
      broken?: ReadonlySet<Defect>;
    },
  ) {}

  private get broken(): ReadonlySet<Defect> {
    return this.deps.broken ?? new Set();
  }

  async propose(caller: Caller, change: ProposedChange): Promise<ProposeOutcome> {
    const { db, guard, config } = this.deps;
    const r = await guard.resolve(caller);
    const group = MEASURES[change.measure]?.group ?? "labs";
    const v = guard.verdictFor(caller, r, group, "propose");
    if (v.decision === "refuse" || !r.person || !r.patientRef || !r.ctx.role) {
      const why = v.decision === "refuse" ? v : refuse(4, "person_unknown", "unknown person");
      return this.refused(caller, r, "propose_observation", "propose", group, why);
    }
    // The record is built for the patient at the server it will be written to.
    const target = await guard.target(r);
    if (!isTarget(target)) {
      return this.refused(caller, r, "propose_observation", "propose", group, target);
    }
    let resource: ReturnType<typeof buildProposedObservation>;
    try {
      resource = buildProposedObservation(change, target.patientRef);
    } catch (err) {
      if (!(err instanceof ProposalError)) throw err;
      return this.refused(
        caller,
        r,
        "propose_observation",
        "propose",
        group,
        refuse(0, "invalid_change", err.message),
      );
    }
    const hash = payloadHash(resource);

    // Who approves: the patient, unless the admin named someone for this role and group.
    const [rule] = await db
      .select()
      .from(approvalRules)
      .where(and(eq(approvalRules.roleId, r.ctx.role.id), eq(approvalRules.group, group)));
    const approverId = rule?.approverPersonId ?? r.person.id;
    const [approver] = await db.select().from(persons).where(eq(persons.id, approverId));

    const id = newId("apr");
    const expiresAt = new Date(Date.now() + PROPOSAL_MINUTES * 60_000);
    const summary = describeChange(change);
    await db.insert(approvals).values({
      id,
      agentId: caller.agentId,
      personId: r.person.id,
      approverPersonId: approverId,
      action: "create",
      group,
      resourceType: "Observation",
      payload: resource,
      payloadHash: hash,
      summary,
      nonce: randomBytes(16).toString("base64url"),
      status: "pending",
      passJti: caller.claims.jti,
      expiresAt,
    });

    const approverName = approver?.displayName ?? r.person.name;
    const sentence = `${receiptSentence({
      decision: "allow",
      agentName: r.agentName,
      personName: r.person.name,
      action: "propose",
      group,
      count: 1,
    })} Waiting for ${approverName.split(" ")[0]}'s OK: ${summary}.`;
    await this.deps.recorder.record({
      agent: { id: caller.agentId, name: r.agentName },
      person: r.person,
      patientRef: r.patientRef,
      passJti: caller.claims.jti,
      tool: "propose_observation",
      action: "propose",
      group,
      interaction: "operation",
      query: `propose ${id} sha256:${hash}`,
      decision: "allow",
      sentence,
      count: 1,
      mode: caller.mode,
    });
    return {
      decision: "allow",
      approvalId: id,
      approveUrl: `${config.publicUrl}/approve/${id}`,
      summary,
      approverName,
      expiresAt,
      commitArgs: { approval_id: id, ...change, effective: String(resource.effectiveDateTime) },
      sentence,
    };
  }

  async commit(caller: Caller, approvalId: string, change: ProposedChange): Promise<CommitOutcome> {
    const { db, guard } = this.deps;
    const r = await guard.resolve(caller);
    const group = MEASURES[change.measure]?.group ?? "labs";
    const v = guard.verdictFor(caller, r, group, "propose");
    if (v.decision === "refuse" || !r.person || !r.patientRef) {
      const why = v.decision === "refuse" ? v : refuse(4, "person_unknown", "unknown person");
      return this.refused(caller, r, "commit_change", "write", group, why);
    }
    const target = await guard.target(r);
    if (!isTarget(target)) return this.refused(caller, r, "commit_change", "write", group, target);
    const { fhir } = target;
    let resource: ReturnType<typeof buildProposedObservation>;
    try {
      resource = buildProposedObservation(change, target.patientRef);
    } catch (err) {
      if (!(err instanceof ProposalError)) throw err;
      return this.refused(
        caller,
        r,
        "commit_change",
        "write",
        group,
        refuse(0, "invalid_change", err.message),
      );
    }
    const hash = payloadHash(resource);

    const [approval] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    const [approver] = approval
      ? await db.select().from(persons).where(eq(persons.id, approval.approverPersonId))
      : [];
    if (!this.broken.has("approval")) {
      const verdict = decideCommit({
        approval: approval
          ? {
              agentId: approval.agentId,
              personId: approval.personId,
              status:
                this.broken.has("replay") && approval.status === "used"
                  ? "approved"
                  : approval.status,
              payloadHash: this.broken.has("hash") ? hash : approval.payloadHash,
              approvedAt: approval.approvedAt,
              expiresAt: approval.expiresAt,
            }
          : null,
        agentId: caller.agentId,
        personId: r.person.id,
        approverName: approver?.displayName ?? r.person.name,
        payloadHash: hash,
        now: new Date(),
      });
      if (verdict.decision === "refuse") {
        return this.refused(caller, r, "commit_change", "write", group, verdict, approvalId);
      }
      // Use it exactly once, atomically, so two commits can't both win.
      if (!this.broken.has("replay")) {
        const used = await db
          .update(approvals)
          .set({ status: "used", usedAt: new Date() })
          .where(and(eq(approvals.id, approvalId), eq(approvals.status, "approved")))
          .returning({ id: approvals.id });
        if (used.length === 0) {
          return this.refused(
            caller,
            r,
            "commit_change",
            "write",
            group,
            refuse(7, "approval_used", "this approval was already used"),
            approvalId,
          );
        }
      }
    }

    // Write the record, then say who did it, for whom, with whose approval.
    let ref: string;
    try {
      const written = await fhir.create(resource);
      ref = `Observation/${written.id}`;
      const elsewhere = Boolean(target.source);
      await fhir.create(
        buildProvenance({
          recorded: new Date().toISOString(),
          target: ref,
          agent: { id: caller.agentId, name: r.agentName },
          // On another server the person is the launch's patient; their aipass ref isn't there.
          onBehalfOf: { ref: elsewhere ? target.patientRef : r.person.ref, name: r.person.name },
          // Someone else who approved is only known here, so on another server they're named.
          approver:
            approver && approver.id !== r.person.id
              ? { ref: elsewhere ? undefined : approver.fhirRef, name: approver.displayName }
              : undefined,
          approvalId,
          payloadHash: hash,
          elsewhere,
        }),
      );
    } catch (err) {
      console.error(`FHIR write failed: ${(err as Error).message}`);
      // nothing was written, so the approval can still be used
      await db
        .update(approvals)
        .set({ status: "approved", usedAt: null })
        .where(eq(approvals.id, approvalId));
      return this.refused(
        caller,
        r,
        "commit_change",
        "write",
        group,
        refuse(
          0,
          "check_failed",
          "the record server didn't accept the change, so nothing was written",
        ),
        approvalId,
      );
    }
    if (approval)
      await db.update(approvals).set({ resultRef: ref }).where(eq(approvals.id, approvalId));

    const summary = describeChange(change);
    const approvedBy = approver?.displayName ?? r.person.name;
    const sentence = `${receiptSentence({
      decision: "allow",
      agentName: r.agentName,
      personName: r.person.name,
      action: "write",
      group,
      count: 1,
    })} ${summary}. Approved by ${approvedBy} with a passkey.`;
    try {
      await this.deps.recorder.record(
        {
          agent: { id: caller.agentId, name: r.agentName },
          person: r.person,
          patientRef: r.patientRef,
          passJti: caller.claims.jti,
          tool: "commit_change",
          action: "write",
          group,
          interaction: "create",
          query: `commit ${approvalId} sha256:${hash}`,
          decision: "allow",
          sentence,
          count: 1,
          targets: [target.source ? { server: target.source.id, ref } : ref],
          mode: caller.mode,
        },
        { requireAudit: false },
      );
    } catch (err) {
      if (!(err instanceof AuditWriteFailed)) throw err;
    }
    return { decision: "allow", ref, summary, sentence };
  }

  private async refused(
    caller: Caller,
    r: Resolved,
    tool: string,
    action: "propose" | "write",
    group: Group,
    v: Refuse,
    approvalId?: string,
  ): Promise<Refuse & { sentence: string }> {
    const sentence = receiptSentence({
      decision: "refuse",
      agentName: r.agentName,
      personName: r.person?.name ?? null,
      action,
      group,
      reason: v.reason,
    });
    await this.deps.recorder.record({
      agent: { id: caller.agentId, name: r.agentName },
      person: r.person,
      patientRef: r.patientRef,
      passJti: caller.claims.jti,
      tool,
      action,
      group,
      interaction: action === "propose" ? "operation" : "create",
      query: approvalId ? `commit ${approvalId}` : undefined,
      decision: "refuse",
      rule: v.rule,
      code: v.code,
      reason: v.reason,
      sentence,
      mode: caller.mode,
    });
    return { ...v, sentence };
  }
}

export { APPROVAL_WINDOW_SECONDS };
