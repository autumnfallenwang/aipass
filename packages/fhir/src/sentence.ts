import { type Action, GROUP_LABELS, type Group } from "@aipass/shared";

export type SentenceInput = {
  decision: "allow" | "refuse";
  agentName: string;
  personName: string | null;
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
  write: ["changed", "change"],
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
  if (s.decision === "refuse") {
    const whose = s.personName ? `${possessive(s.personName)} ${what.many}` : what.many;
    return `${prefix}REFUSED: ${s.agentName} tried to ${attempt} ${whose}: ${s.reason ?? "refused"}.`;
  }
  const n = s.count ?? 0;
  const noun = n === 1 ? what.one : what.many;
  const forWhom = s.personName ? ` for ${s.personName}` : "";
  let line = `${prefix}${s.agentName} ${past} ${n} ${noun}${forWhom}.`;
  if (s.withheld && s.withheld.count > 0) {
    const w = s.withheld.count === 1 ? "1 record was" : `${s.withheld.count} records were`;
    line += ` ${w} withheld (${[...new Set(s.withheld.reasons)].join("; ")}).`;
  }
  return line;
}
