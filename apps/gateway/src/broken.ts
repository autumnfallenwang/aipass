/**
 * Planted defects, for proving the health check (S4). `AIPASS_BROKEN=labels`
 * starts a gateway that skips the locked-label check, so the `locked_label_leak`
 * probe must catch it. Each defect switches off exactly one check.
 *
 * Never in production: the gateway refuses to start with any defect when
 * NODE_ENV=production.
 */
export const DEFECTS = [
  "require_pass", // a request with no pass is let in (as the default person)
  "signature", // the pass's signature isn't checked
  "expiry", // an expired pass is accepted
  "audience", // a pass for another service is accepted
  "agent_status", // a stopped agent keeps working (rule 2)
  "role", // the role's ceiling isn't applied (rule 3)
  "grant", // the person's grant isn't applied (rule 4)
  "compartment", // records of other patients aren't filtered (rule 5)
  "labels", // locked labels aren't filtered (rule 6)
  "include", // `_include`/`_revinclude` reach FHIR and included records aren't filtered
  "audit_refusals", // refusals leave no AuditEvent
  "audit_person", // AuditEvents don't name the person
] as const;

export type Defect = (typeof DEFECTS)[number];

export function parseBroken(value: string | undefined, env = process.env): Set<Defect> {
  const names = (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = names.filter((n) => !(DEFECTS as readonly string[]).includes(n));
  if (unknown.length) throw new Error(`unknown AIPASS_BROKEN defect(s): ${unknown.join(", ")}`);
  if (names.length && env.NODE_ENV === "production") {
    throw new Error("AIPASS_BROKEN plants security defects; it is refused in production");
  }
  return new Set(names as Defect[]);
}
