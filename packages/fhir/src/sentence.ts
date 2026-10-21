import { type Action, GROUP_LABELS, type Group } from "@aipass/shared";

export type SentenceInput = {
  decision: "allow" | "refuse";
  agentName: string;
  personName: string | null;
  /** The person is a staff member acting on a patient they have open (S10). */
  staff?: boolean;
  /** That patient's name, when it's known (staff members only). */
  patientName?: string | null;
  action: Action | "connect";
  group: Group | null;
  /** Records returned (allow). */
  count?: number;
  /** Why it was refused (refuse), or a note on what was withheld (allow). */
  reason?: string;
  withheld?: { count: number; reasons: string[] };
  preview?: boolean;
};

const VERB: Record<Action | "connect", [past: string, attempt: string]> = {
  connect: ["connected", "connect"],
  read: ["read", "read"],
  propose: ["proposed", "propose"],
  write: ["added", "add"],
};

function possessive(name: string): string {
  return `${name}'s`;
}

/** The plain-English line on every receipt. */
export function receiptSentence(s: SentenceInput): string {
  const prefix = s.preview ? "PREVIEW: " : "";
  const what = s.group ? GROUP_LABELS[s.group] : { one: "record", many: "records" };
  const [past, attempt] = VERB[s.action];
  if (s.decision === "refuse" && s.action === "connect") {
    return `${prefix}REFUSED: ${s.agentName} tried to connect: ${s.reason ?? "refused"}.`;
  }
  // A staff member's records aren't what's touched: say whose they act for, and the patient.
  const patient = s.staff && s.patientName ? ` (patient: ${s.patientName})` : "";
  if (s.decision === "refuse") {
    const whose = !s.personName
      ? what.many
      : s.staff
        ? `${what.many} for ${s.personName}${patient}`
        : `${possessive(s.personName)} ${what.many}`;
    return `${prefix}REFUSED: ${s.agentName} tried to ${attempt} ${whose}: ${s.reason ?? "refused"}.`;
  }
  const n = s.count ?? 0;
  const noun = n === 1 ? what.one : what.many;
  const forWhom = s.personName ? ` for ${s.personName}` : "";
  let line = `${prefix}${s.agentName} ${past} ${n} ${noun}${forWhom}${patient}.`;
  if (s.withheld && s.withheld.count > 0) {
    const w = s.withheld.count === 1 ? "1 record was" : `${s.withheld.count} records were`;
    line += ` ${w} withheld (${[...new Set(s.withheld.reasons)].join("; ")}).`;
  }
  return line;
}
