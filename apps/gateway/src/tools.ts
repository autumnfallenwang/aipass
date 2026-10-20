import { MEASURE_NAMES } from "@aipass/fhir";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { Defect } from "./broken.ts";
import type { Changes } from "./changes.ts";
import type { Caller, Guard, ReadOutcome, ReadRequest } from "./guard.ts";

const INSTRUCTIONS = `You are connected to a patient's health record through aipass.
Every call is checked against what the clinic allows this AI to do and what the patient agreed to.
Some records are always private (mental health, substance use, HIV, restricted) and are never shown.
When a call is REFUSED, tell the user the reason in plain words. Don't try to work around it.`;

const limit = z
  .number()
  .int()
  .min(1)
  .max(50)
  .optional()
  .describe("How many records (1–50, default 20)");
const page = z.string().max(4000).optional().describe("The next_page value from a previous call");
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional();
const loinc = z
  .string()
  .regex(/^\d{1,7}-\d$/)
  .optional()
  .describe("A LOINC code, e.g. 4548-4 for HbA1c");
const fhirId = z.string().regex(/^[A-Za-z0-9\-.]{1,64}$/);

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function toResult(o: ReadOutcome): ToolResult {
  if (o.decision === "refuse") {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `REFUSED: ${o.reason}.\nThis was checked by aipass and recorded (receipt ${o.receiptId}). Tell the user why; don't retry.`,
        },
      ],
    };
  }
  const lines = [
    `${o.records.length} record(s) for ${o.personName}.`,
    JSON.stringify(o.records, null, 1),
  ];
  if (o.withheld.count > 0) {
    lines.push(
      `${o.withheld.count} record(s) were withheld: ${o.withheld.reasons.join("; ")}. Tell the user they exist but are private.`,
    );
  }
  if (o.nextPage)
    lines.push(`More records exist. To see them, call again with next_page: ${o.nextPage}`);
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

/**
 * One MCP server per request, bound to the verified caller. The tools take
 * structured arguments only: no raw FHIR query string ever reaches the server.
 */
export function buildServer(
  guard: Guard,
  caller: Caller,
  broken: ReadonlySet<Defect> = new Set(),
  changes?: Changes,
): McpServer {
  // Planted defect "include" (S4 self-test only): unknown arguments are let
  // through, and `_include`/`_revinclude` are passed on to FHIR.
  const object = broken.has("include") ? z.looseObject : z.strictObject;
  const includes = (args: Record<string, unknown>): Record<string, string> =>
    broken.has("include")
      ? Object.fromEntries(
          Object.entries(args).filter(
            (e): e is [string, string] =>
              (e[0] === "_include" || e[0] === "_revinclude") && typeof e[1] === "string",
          ),
        )
      : {};
  const server = new McpServer(
    { name: "aipass-gateway", version: "0.1.0" },
    { instructions: INSTRUCTIONS, capabilities: { tools: {} } },
  );
  const run = async (req: ReadRequest) => toResult(await guard.read(caller, req));
  const readOnly = { readOnlyHint: true, openWorldHint: false };

  server.registerTool(
    "get_patient_summary",
    {
      title: "Patient summary",
      description:
        "The patient's details (name, contact, birth date…), limited to what this AI may see.",
      inputSchema: object({}),
      annotations: readOnly,
    },
    () => run({ tool: "get_patient_summary", group: "demographics" }),
  );

  server.registerTool(
    "search_labs",
    {
      title: "Lab results",
      description: "The patient's lab results, newest first. Filter by LOINC code or by date.",
      inputSchema: object({ code: loinc, since: date, limit, next_page: page }),
      annotations: readOnly,
    },
    ({ code, since, limit: n, next_page, ...rest }) =>
      run({
        tool: "search_labs",
        group: "labs",
        params: {
          ...includes(rest),
          _sort: "-date",
          ...(code ? { code: `http://loinc.org|${code}` } : {}),
          ...(since ? { date: `ge${since}` } : {}),
        },
        limit: n,
        page: next_page,
      }),
  );

  server.registerTool(
    "search_vitals",
    {
      title: "Vital signs",
      description: "The patient's vital signs (blood pressure, weight…), newest first.",
      inputSchema: object({ code: loinc, since: date, limit, next_page: page }),
      annotations: readOnly,
    },
    ({ code, since, limit: n, next_page, ...rest }) =>
      run({
        tool: "search_vitals",
        group: "vitals",
        params: {
          ...includes(rest),
          _sort: "-date",
          ...(code ? { code: `http://loinc.org|${code}` } : {}),
          ...(since ? { date: `ge${since}` } : {}),
        },
        limit: n,
        page: next_page,
      }),
  );

  server.registerTool(
    "list_medications",
    {
      title: "Medications",
      description: "The patient's medications.",
      inputSchema: object({
        status: z.enum(["active", "completed", "stopped", "on-hold"]).optional(),
        limit,
        next_page: page,
      }),
      annotations: readOnly,
    },
    ({ status, limit: n, next_page }) =>
      run({
        tool: "list_medications",
        group: "medications",
        params: status ? { status } : {},
        limit: n,
        page: next_page,
      }),
  );

  server.registerTool(
    "list_conditions",
    {
      title: "Conditions",
      description: "The patient's conditions (problem list).",
      inputSchema: object({
        status: z.enum(["active", "resolved", "inactive", "remission"]).optional(),
        limit,
        next_page: page,
      }),
      annotations: readOnly,
    },
    ({ status, limit: n, next_page }) =>
      run({
        tool: "list_conditions",
        group: "conditions",
        params: status ? { "clinical-status": status } : {},
        limit: n,
        page: next_page,
      }),
  );

  server.registerTool(
    "list_appointments",
    {
      title: "Appointments",
      description: "The patient's appointments, soonest first.",
      inputSchema: object({
        from: date.describe("Only appointments on or after this date"),
        limit,
        next_page: page,
      }),
      annotations: readOnly,
    },
    ({ from, limit: n, next_page }) =>
      run({
        tool: "list_appointments",
        group: "appointments",
        params: { _sort: "date", ...(from ? { date: `ge${from}` } : {}) },
        limit: n,
        page: next_page,
      }),
  );

  server.registerTool(
    "get_notes",
    {
      title: "Visit notes",
      description: "The patient's visit notes, newest first. Pass an id to read one note.",
      inputSchema: object({
        id: fhirId.optional().describe("A DocumentReference id"),
        limit,
        next_page: page,
      }),
      annotations: readOnly,
    },
    ({ id, limit: n, next_page }) =>
      run({
        tool: "get_notes",
        group: "notes",
        ...(id ? { ref: `DocumentReference/${id}` } : { params: { _sort: "-date" } }),
        limit: n,
        page: next_page,
      }),
  );

  if (changes) registerChangeTools(server, changes, caller, object);
  return server;
}

const change = {
  measure: z.enum(MEASURE_NAMES as [string, ...string[]]).describe("What was measured"),
  value: z
    .number()
    .describe("The reading, in the measure's unit (blood_glucose: mg/dL, body_weight: kg)"),
  effective: z.iso
    .datetime({ offset: true })
    .optional()
    .describe("When it was measured (ISO date-time). Defaults to now"),
};

/** S5: propose a change, then commit it once the person has approved it with their passkey. */
function registerChangeTools(
  server: McpServer,
  changes: Changes,
  caller: Caller,
  object: typeof z.strictObject,
) {
  server.registerTool(
    "propose_observation",
    {
      title: "Propose a reading",
      description:
        "Proposes adding a reading (blood glucose, body weight) to the patient's record. Nothing is written yet: the patient must approve this exact change with their passkey, then call commit_change.",
      inputSchema: object(change),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ measure, value, effective }) => {
      const o = await changes.propose(caller, {
        measure: measure as keyof typeof import("@aipass/fhir").MEASURES,
        value,
        effective: effective ?? new Date().toISOString(),
      });
      if (o.decision === "refuse") return refusedResult(o.reason);
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Proposed (nothing written yet): ${o.summary}.`,
              `${o.approverName} must approve it with their passkey here: ${o.approveUrl}`,
              `The proposal expires at ${o.expiresAt.toISOString()}. Once approved, call commit_change within 2 minutes with exactly: ${JSON.stringify(o.commitArgs)}`,
            ].join("\n"),
          },
        ],
      };
    },
  );

  server.registerTool(
    "commit_change",
    {
      title: "Commit an approved change",
      description:
        "Writes a proposed reading once the patient has approved it. Pass the approval_id and exactly the same values that were proposed.",
      inputSchema: object({ approval_id: z.string().regex(/^apr_[0-9a-f-]{36}$/), ...change }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ approval_id, measure, value, effective }) => {
      const o = await changes.commit(caller, approval_id, {
        measure: measure as keyof typeof import("@aipass/fhir").MEASURES,
        value,
        effective: effective ?? "",
      });
      if (o.decision === "refuse") return refusedResult(o.reason);
      return {
        content: [{ type: "text" as const, text: `Written: ${o.summary} (${o.ref}).` }],
      };
    },
  );
}

function refusedResult(reason: string): ToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `REFUSED: ${reason}.\nThis was checked by aipass and recorded. Tell the user why; don't retry.`,
      },
    ],
  };
}
