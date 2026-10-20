import { appendReceipt, type Db, newId } from "@aipass/db";
import { buildAuditEvent, type FhirClient } from "@aipass/fhir";
import type { Action, Group } from "@aipass/shared";
import type { Defect } from "./broken.ts";

export type ReceiptInput = {
  agent: { id: string; name: string };
  person: { id: string; name: string; ref: string } | null;
  patientRef: string | null;
  passJti: string | null;
  tool: string | null;
  action: Action | "connect";
  group: Group | null;
  interaction: "search-type" | "read" | "create" | "update" | "operation";
  query?: string;
  decision: "allow" | "refuse";
  rule?: number | null;
  code?: string | null;
  reason?: string | null;
  sentence: string;
  count?: number;
  withheld?: number;
  targets?: string[];
  mode: "live" | "preview";
};

export type Recorded = { receiptId: string; auditEventId: string | null };

/** Thrown when the AuditEvent couldn't be written and the caller required it. No receipt was written. */
export class AuditWriteFailed extends Error {}

/**
 * Writes the two records every request leaves: a FHIR AuditEvent in the
 * record's own audit log, and a hash-chained receipt in our database.
 */
export class Recorder {
  constructor(
    private readonly db: Db,
    private readonly fhir: FhirClient,
    /** Planted defects (S4 self-test only). */
    private readonly broken: ReadonlySet<Defect> = new Set(),
  ) {}

  /**
   * With `requireAudit`, a failed AuditEvent write throws before any receipt
   * is written, so the caller can refuse instead (fail closed).
   */
  async record(r: ReceiptInput, opts: { requireAudit?: boolean } = {}): Promise<Recorded> {
    const receiptId = newId("rcpt");
    let auditEventId: string | null = null;
    // A preview is the admin looking, not an agent acting: receipt only.
    const skip = this.broken.has("audit_refusals") && r.decision === "refuse";
    if (r.mode === "live" && !skip) {
      try {
        const ae = await this.fhir.create(
          buildAuditEvent({
            recorded: new Date().toISOString(),
            agent: r.agent,
            person:
              r.person && !this.broken.has("audit_person")
                ? { ref: r.person.ref, name: r.person.name }
                : null,
            patientRef: r.patientRef,
            interaction: r.interaction,
            query: r.query,
            outcome: r.decision,
            sentence: r.sentence,
            passJti: r.passJti,
            receiptId,
            targets: r.targets,
          }),
        );
        auditEventId = ae.id ?? null;
      } catch (err) {
        console.error(`AuditEvent write failed for ${receiptId}: ${(err as Error).message}`);
        if (opts.requireAudit) throw new AuditWriteFailed((err as Error).message);
      }
    }
    await appendReceipt(this.db, {
      id: receiptId,
      agentId: r.agent.id,
      personId: r.person?.id ?? null,
      tool: r.tool,
      action: r.action,
      group: r.group,
      target: r.patientRef,
      decision: r.decision,
      rule: r.rule ?? null,
      code: r.code ?? null,
      reason: r.reason ?? null,
      sentence: r.sentence,
      count: r.count ?? 0,
      withheld: r.withheld ?? 0,
      passJti: r.passJti,
      mode: r.mode,
      auditEventId,
    });
    return { receiptId, auditEventId };
  }
}
