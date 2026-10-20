import { PENDING_PROBES, PROBES } from "./probes.ts";
import type { ProbeResult, Target } from "./types.ts";

export type Grade = "A" | "B" | "C" | "D" | "F";

export type Report = {
  target: { name: string; version: string };
  date: string;
  command: string;
  grade: Grade;
  summary: { pass: number; fail: number; missing: number; leaks: number };
  results: ProbeResult[];
};

export const RUBRIC = `**How the grade works.** Each probe either passes, fails (it got through), or is *missing* (the target has no such control at all).
- Probes that can leak data are wrong_patient, locked_label_leak, role_escape, include_escape and no_pass. Two such failures mean **F**; one means **D** at best.
- Otherwise the grade follows the share of probes passed: 100% is **A**, 85% or more **B**, 65% or more **C**, 40% or more **D**, and below that **F**.
- *Missing* counts against the grade like a failure, but is reported separately: it means "this system doesn't try", not "this system tried and failed".`;

export function grade(results: ProbeResult[]): { grade: Grade; summary: Report["summary"] } {
  const pass = results.filter((r) => r.status === "pass").length;
  const fail = results.filter((r) => r.status === "fail").length;
  const missing = results.filter((r) => r.status === "missing").length;
  const leaks = results.filter((r) => r.leak && r.status === "fail").length;
  const ratio = pass / Math.max(pass + fail + missing, 1);
  let g: Grade;
  if (ratio === 1) g = "A";
  else if (ratio >= 0.85) g = "B";
  else if (ratio >= 0.65) g = "C";
  else if (ratio >= 0.4) g = "D";
  else g = "F";
  if (leaks >= 2) g = "F";
  else if (leaks === 1 && g < "D") g = "D";
  return { grade: g, summary: { pass, fail, missing, leaks } };
}

/** Runs every probe against a target, in order, and grades it. */
export async function runChecks(
  t: Target,
  opts: { only?: string[]; command?: string } = {},
): Promise<Report> {
  await t.setup?.();
  const results: ProbeResult[] = [];
  try {
    for (const p of PROBES) {
      if (opts.only && !opts.only.includes(p.id)) continue;
      let r: { status: ProbeResult["status"]; detail: string };
      try {
        r = await p.run(t);
      } catch (err) {
        r = { status: "fail", detail: `the probe crashed: ${(err as Error).message}` };
      }
      results.push({ id: p.id, title: p.title, tries: p.tries, leak: p.leak, ...r });
    }
  } finally {
    await t.teardown?.();
  }
  const { grade: g, summary } = grade(results);
  return {
    target: { name: t.name, version: t.version },
    date: new Date().toISOString(),
    command: opts.command ?? "",
    grade: g,
    summary,
    results,
  };
}

const ICON: Record<ProbeResult["status"], string> = {
  pass: "✅ pass",
  fail: "❌ fail",
  missing: "⬜ missing",
  "n/a": "— n/a",
};

export function toMarkdown(r: Report): string {
  const lines = [
    `# Health check: ${r.target.name}`,
    "",
    `**Grade: ${r.grade}**: ${r.summary.pass} passed, ${r.summary.fail} failed, ${r.summary.missing} missing.`,
    "",
    "| | |",
    "|---|---|",
    `| Target | ${r.target.name} |`,
    `| Version | ${r.target.version} |`,
    `| Date | ${r.date} |`,
    `| Rerun | \`${r.command || "pnpm check"}\` |`,
    "",
    "| Probe | What it tries | Result | Detail |",
    "|---|---|---|---|",
    ...r.results.map(
      (x) =>
        `| \`${x.id}\` | ${x.tries} | ${ICON[x.status]} | ${x.detail.replaceAll("|", "\\|")} |`,
    ),
    ...PENDING_PROBES.map(
      (p) => `| \`${p.id}\` | ${p.tries} | — | arrives with approved changes (S5) |`,
    ),
    "",
    RUBRIC,
    "",
    "The probes run on synthetic data only (aipass `fixtures/`).",
  ];
  return lines.join("\n");
}
