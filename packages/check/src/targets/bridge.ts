import { existsSync, readFileSync } from "node:fs";
import { callTool } from "../mcp.ts";
import type { AuditRecord, Credential, Outcome, Target } from "../types.ts";

/**
 * A generic MCP→FHIR bridge: a server whose tools read and search FHIR
 * directly. The probes still act "for Maria"; a bridge with no notion of a
 * person simply can't stop them. Presets below describe how each project's
 * tools are called.
 */
export type BridgePreset = {
  name: string;
  read(type: string, id: string): { tool: string; args: Record<string, unknown> };
  search(
    type: string,
    q: { patient: string; category?: string; extra?: Record<string, string> },
  ): { tool: string; args: Record<string, unknown> };
  /** Reads the project's own audit log, when it writes one. */
  audit?(since: Date, file: string): AuditRecord[];
};

export const PRESETS: Record<string, BridgePreset> = {
  /** github.com/wso2/fhir-mcp-server: generic `read` and `search` tools. */
  wso2: {
    name: "wso2/fhir-mcp-server",
    read: (type, id) => ({ tool: "read", args: { type, id } }),
    search: (type, q) => ({
      tool: "search",
      args: {
        type,
        searchParam: {
          [type === "Patient" ? "_id" : "patient"]:
            type === "Patient" ? q.patient : `Patient/${q.patient}`,
          ...(q.category ? { category: q.category } : {}),
          ...q.extra,
        },
      },
    }),
  },
  /** github.com/faulkj/fhirHydrant: one tool per resource type; `_id` alone reads directly. */
  fhirhydrant: {
    name: "faulkj/fhirHydrant",
    read: (type, id) => ({ tool: type.toLowerCase(), args: { _id: id, responseMode: "full" } }),
    search: (type, q) => ({
      tool: type.toLowerCase(),
      args: {
        ...(type === "Patient" ? { _id: q.patient } : { patient: `Patient/${q.patient}` }),
        ...(q.category ? { category: q.category } : {}),
        ...q.extra,
        responseMode: "full",
      },
    }),
    // FHIR_AUDIT_SINK=file writes one JSON line per tool call.
    audit(since, file) {
      if (!existsSync(file)) return [];
      return readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map(
          (l) =>
            JSON.parse(l) as { ts: string; status: string; operation?: string; resource?: string },
        )
        .filter((e) => new Date(e.ts) >= since)
        .map((e) => ({
          outcome: e.status === "ok" ? ("success" as const) : ("failure" as const),
          agents: [],
          description: `${e.operation ?? "?"} ${e.resource ?? "?"} (${e.status})`,
        }));
    },
  },
};

export function bridgeTarget(o: {
  preset: keyof typeof PRESETS;
  url: string;
  version: string;
  /** A static bearer token, if the deployment requires one. */
  bearer?: string;
  /** The project's audit log file, when the preset can read one. */
  auditFile?: string;
}): Target {
  const p = PRESETS[o.preset];
  if (!p) throw new Error(`unknown bridge preset "${o.preset}"`);
  const call = (
    cred: Credential,
    x: { tool: string; args: Record<string, unknown> },
  ): Promise<Outcome> => callTool(o.url, cred?.bearer, x.tool, x.args);
  const audit = p.audit && o.auditFile ? p.audit : undefined;
  return {
    name: p.name,
    version: o.version,
    capabilities: {
      credentials: Boolean(o.bearer),
      partialAccess: false,
      adminStop: false,
      personRevoke: false,
      audit: Boolean(audit),
    },
    credential: async () => (o.bearer ? { bearer: o.bearer, agent: "all" } : { agent: "all" }),
    read: (cred, type, id) => call(cred, p.read(type, id)),
    search: (cred, type, q) => call(cred, p.search(type, q)),
    auditSince: audit ? async (since) => audit(since, o.auditFile as string) : undefined,
  };
}
