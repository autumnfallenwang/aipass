import { type CallContext, type Db, loadCallContext } from "@aipass/db";
import {
  type Bundle,
  type FhirClient,
  GROUP_QUERIES,
  groupOf,
  labelsOf,
  maskPatient,
  patientRefsOf,
  type Resource,
  receiptSentence,
  type SimpleRecord,
  simplify,
} from "@aipass/fhir";
import { decideRequest, decideResource, type Refuse, refuse, type Verdict } from "@aipass/policy";
import {
  ACTIONS,
  GROUPS,
  type Group,
  type PassClaims,
  type PatientField,
  type Permission,
  permission,
} from "@aipass/shared";
import type { Defect } from "./broken.ts";
import type { GatewayConfig } from "./config.ts";
import { openPage, sealPage } from "./paging.ts";
import { AuditWriteFailed, type Recorder } from "./recorder.ts";

export type Mode = "live" | "preview";

/**
 * Who is calling: the agent from the URL, the pass they presented (already
 * verified), and the OAuth client that holds it when the pass came from OAuth.
 */
export type Caller = { agentId: string; claims: PassClaims; mode: Mode; clientId?: string };

export type ReadRequest = {
  tool: string;
  group: Group;
  /** Extra FHIR search parameters, built by the tool from validated arguments only. */
  params?: Record<string, string>;
  limit?: number;
  page?: string;
  /** Read one record directly, as `Type/id`. */
  ref?: string;
};

export type Withheld = { count: number; reasons: string[] };

/**
 * Preview of a role: the admin sees a person's chart as an agent with that
 * role would, assuming the person agreed to everything the role allows.
 * Everything after the lookup (fetch, filter, mask, receipt) is the same code
 * an agent's call runs.
 */
export type RoleOverride = {
  agent: { id: string; name: string };
  role: { name: string; permissions: Permission[]; patientFields: PatientField[] };
};

export type ReadOutcome =
  | {
      decision: "allow";
      personName: string;
      records: SimpleRecord[];
      withheld: Withheld;
      nextPage?: string;
      sentence: string;
      receiptId: string;
    }
  | (Refuse & { sentence: string; receiptId: string });

type Resolved = {
  ctx: CallContext;
  agentName: string;
  person: { id: string; name: string; ref: string } | null;
  patientRef: string | null;
};

export class Guard {
  constructor(
    private readonly deps: {
      db: Db;
      fhir: FhirClient;
      config: GatewayConfig;
      recorder: Recorder;
      /** Planted defects (S4 self-test only). */
      broken?: ReadonlySet<Defect>;
    },
  ) {}

  /** Loads agent, role, person and grant live, and pins the patient. */
  private async resolve(
    caller: Caller,
    override?: RoleOverride,
  ): Promise<Resolved & { pin: Verdict }> {
    const loaded = await loadCallContext(this.deps.db, caller.agentId, caller.claims.sub);
    const ctx: CallContext = override
      ? {
          ...loaded,
          agent: {
            ...override.agent,
            status: "active",
            description: null,
            roleId: "",
            fhirDeviceId: null,
            createdBy: null,
            createdAt: new Date(0),
            updatedAt: new Date(0),
          },
          role: {
            id: "",
            name: override.role.name,
            description: null,
            rules: [],
            permissions: override.role.permissions,
            patientFields: override.role.patientFields,
            createdAt: new Date(0),
            updatedAt: new Date(0),
          },
          grant: loaded.person
            ? {
                id: "",
                personId: loaded.person.id,
                agentId: override.agent.id,
                permissions: override.role.permissions,
                status: "active",
                grantedAt: new Date(0),
                revokedAt: null,
                updatedAt: new Date(0),
              }
            : null,
        }
      : loaded;
    const person = ctx.person
      ? { id: ctx.person.id, name: ctx.person.displayName, ref: ctx.person.fhirRef }
      : null;
    let patientRef: string | null = null;
    let pin: Verdict = { decision: "allow" };
    if (person) {
      const personIsPatient = person.ref.startsWith("Patient/");
      const claimed = caller.claims.patient ? `Patient/${caller.claims.patient}` : null;
      if (personIsPatient) {
        patientRef = person.ref;
        // A pass naming a different patient than its own person is not honoured.
        if (claimed && claimed !== person.ref) {
          pin = refuse(5, "not_in_compartment", `not ${firstWord(person.name)}'s record`);
        }
      } else if (claimed) {
        patientRef = claimed;
      } else {
        pin = refuse(5, "not_in_compartment", "no patient selected");
      }
    }
    return { ctx, agentName: ctx.agent?.name ?? caller.agentId, person, patientRef, pin };
  }

  async read(caller: Caller, req: ReadRequest, override?: RoleOverride): Promise<ReadOutcome> {
    if (override && caller.mode !== "preview")
      throw new Error("role overrides are for previews only");
    const r = await this.resolve(caller, override);
    const { ctx } = r;
    const broken = this.deps.broken ?? new Set<Defect>();
    let verdict = decideRequest({
      pass: { ok: true },
      agent: ctx.agent
        ? {
            id: ctx.agent.id,
            name: ctx.agent.name,
            status: broken.has("agent_status") ? "active" : ctx.agent.status,
          }
        : null,
      client: caller.clientId
        ? { id: caller.clientId, approved: ctx.allowedClients.includes(caller.clientId) }
        : null,
      role: ctx.role
        ? {
            name: ctx.role.name,
            permissions: broken.has("role") ? EVERYTHING : ctx.role.permissions,
          }
        : null,
      person: ctx.person ? { id: ctx.person.id, displayName: ctx.person.displayName } : null,
      grant: broken.has("grant")
        ? { status: "active", permissions: EVERYTHING }
        : ctx.grant
          ? { status: ctx.grant.status, permissions: ctx.grant.permissions }
          : null,
      request: { group: req.group, action: "read" },
    });
    const facts = (res: Resource) => {
      const f = factsOf(res);
      if (broken.has("compartment")) f.patientRefs = [r.patientRef ?? ""];
      if (broken.has("labels")) f.labels = [];
      if (broken.has("include") && f.group !== null) f.group = req.group;
      return f;
    };
    if (verdict.decision === "allow") verdict = r.pin;
    if (verdict.decision === "refuse" || !r.patientRef || !r.person) {
      const v =
        verdict.decision === "refuse" ? verdict : refuse(4, "person_unknown", "unknown person");
      return this.refused(caller, r, req, v);
    }

    const resCtx = {
      person: { displayName: r.person.name },
      patientRef: r.patientRef,
      requestGroup: req.group,
    };
    const patientFields = ctx.role?.patientFields ?? [];

    let fetched: { resources: Resource[]; next: string[]; queries: string[] };
    try {
      fetched = await this.fetch(caller, req, r.patientRef);
    } catch (err) {
      console.error(`FHIR fetch failed: ${(err as Error).message}`);
      return this.refused(
        caller,
        r,
        req,
        refuse(0, "check_failed", "the record server didn't answer, so nothing was released"),
      );
    }

    // A direct read of one record that turns out to be off-limits is a refusal, with its reason.
    if (req.ref) {
      const only = fetched.resources[0];
      if (!only) {
        return this.refused(caller, r, req, refuse(5, "not_in_compartment", "no such record"));
      }
      const v = decideResource(resCtx, facts(only));
      if (v.decision === "refuse") return this.refused(caller, r, req, v, fetched.queries);
    }

    const records: SimpleRecord[] = [];
    const targets: string[] = [];
    const withheld: Withheld = { count: 0, reasons: [] };
    for (const res of fetched.resources) {
      const v = decideResource(resCtx, facts(res));
      if (v.decision === "refuse") {
        withheld.count++;
        withheld.reasons.push(v.reason);
        continue;
      }
      const shown = res.resourceType === "Patient" ? maskPatient(res, patientFields) : res;
      records.push(simplify(shown));
      targets.push(`${res.resourceType}/${res.id}`);
    }
    withheld.reasons = [...new Set(withheld.reasons)];

    const nextPage =
      fetched.next.length > 0
        ? sealPage(this.deps.config.pageSecret, {
            agentId: caller.agentId,
            patientRef: r.patientRef,
            group: req.group,
            links: fetched.next,
          })
        : undefined;

    const sentence = receiptSentence({
      decision: "allow",
      agentName: r.agentName,
      personName: r.person.name,
      action: "read",
      group: req.group,
      count: records.length,
      withheld,
      preview: caller.mode === "preview",
    });
    let rec: { receiptId: string };
    try {
      rec = await this.deps.recorder.record(
        {
          agent: { id: caller.agentId, name: r.agentName },
          person: r.person,
          patientRef: r.patientRef,
          passJti: caller.claims.jti,
          tool: req.tool,
          action: "read",
          group: req.group,
          interaction: req.ref ? "read" : "search-type",
          query: fetched.queries.join(" ; "),
          decision: "allow",
          sentence,
          count: records.length,
          withheld: withheld.count,
          targets,
          mode: caller.mode,
        },
        { requireAudit: caller.mode === "live" },
      );
    } catch (err) {
      if (!(err instanceof AuditWriteFailed)) throw err;
      // We couldn't write to the record's audit log, so nothing leaves (fail closed).
      return this.refused(
        caller,
        r,
        req,
        refuse(0, "check_failed", "the audit log couldn't be written, so nothing was released"),
      );
    }
    return {
      decision: "allow",
      personName: r.person.name,
      records,
      withheld,
      nextPage,
      sentence,
      receiptId: rec.receiptId,
    };
  }

  private async fetch(
    caller: Caller,
    req: ReadRequest,
    patientRef: string,
  ): Promise<{ resources: Resource[]; next: string[]; queries: string[] }> {
    const { fhir, config } = this.deps;
    const queries = GROUP_QUERIES[req.group];

    if (req.ref) {
      const [type, id] = req.ref.split("/");
      if (!type || !id || !queries.some((q) => q.resourceType === type)) {
        return { resources: [], next: [], queries: [req.ref] };
      }
      const res = await fhir.read(type, id);
      return { resources: res ? [res] : [], next: [], queries: [req.ref] };
    }

    let bundles: Bundle[];
    let described: string[];
    if (req.page) {
      const page = openPage(config.pageSecret, req.page, {
        agentId: caller.agentId,
        patientRef,
        group: req.group,
      });
      if (!page) throw new Error("bad page token");
      bundles = await Promise.all(page.links.map((l) => fhir.page(l)));
      described = page.links.map((l) => `page ${new URL(l).search}`);
    } else {
      const limit = String(Math.min(Math.max(req.limit ?? 20, 1), config.maxPageSize));
      const built = queries.map((q) => {
        const p = new URLSearchParams();
        p.set(
          q.patientParam,
          q.patientParam === "_id" ? patientRef.replace(/^Patient\//, "") : patientRef,
        );
        for (const [k, v] of Object.entries(q.fixed)) p.set(k, v);
        for (const [k, v] of Object.entries(req.params ?? {})) {
          if (SAFE_PARAMS.has(k) || (this.deps.broken?.has("include") && INCLUDES.has(k))) {
            p.set(k, v);
          }
        }
        p.set("_count", limit);
        return { type: q.resourceType, params: p };
      });
      bundles = await Promise.all(built.map((b) => fhir.search(b.type, b.params)));
      described = built.map((b) => `${b.type}?${decodeURIComponent(b.params.toString())}`);
    }

    const resources: Resource[] = [];
    const next: string[] = [];
    for (const b of bundles) {
      if (b.resourceType !== "Bundle")
        throw new Error("FHIR answered with something other than a Bundle");
      for (const e of b.entry ?? []) {
        if (e.resource && e.resource.resourceType !== "OperationOutcome")
          resources.push(e.resource);
      }
      const n = b.link?.find((l) => l.relation === "next")?.url;
      if (n && fhir.owns(n)) next.push(n);
    }
    return { resources, next, queries: described };
  }

  private async refused(
    caller: Caller,
    r: Resolved,
    req: ReadRequest,
    v: Refuse,
    queries?: string[],
  ): Promise<ReadOutcome> {
    const sentence = receiptSentence({
      decision: "refuse",
      agentName: r.agentName,
      personName: r.person?.name ?? null,
      action: "read",
      group: req.group,
      reason: v.reason,
      preview: caller.mode === "preview",
    });
    const rec = await this.deps.recorder.record({
      agent: { id: caller.agentId, name: r.agentName },
      person: r.person,
      patientRef: r.patientRef,
      passJti: caller.claims.jti,
      tool: req.tool,
      action: "read",
      group: req.group,
      interaction: req.ref ? "read" : "search-type",
      query: queries?.join(" ; ") ?? req.ref,
      decision: "refuse",
      rule: v.rule,
      code: v.code,
      reason: v.reason,
      sentence,
      mode: caller.mode,
    });
    return { ...v, sentence, receiptId: rec.receiptId };
  }
}

/** Search parameters a tool may add. Everything else (`_include`, `_has`, chains, operations) is dropped. */
const SAFE_PARAMS = new Set(["code", "date", "status", "clinical-status", "_sort"]);
/** Only ever passed on with the planted defect "include". */
const INCLUDES = new Set(["_include", "_revinclude"]);

const EVERYTHING: Permission[] = GROUPS.flatMap((g) => ACTIONS.map((a) => permission(g, a)));

function factsOf(r: Resource) {
  return { group: groupOf(r), patientRefs: patientRefsOf(r), labels: labelsOf(r) };
}

function firstWord(s: string): string {
  return s.split(/\s+/)[0] ?? s;
}
