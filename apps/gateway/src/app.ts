import { agents, type Db, roles } from "@aipass/db";
import { FhirClient, receiptSentence } from "@aipass/fhir";
import { agentUrl, GROUPS, type PassClaims, rulesToPermissions } from "@aipass/shared";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { Changes } from "./changes.ts";
import type { GatewayConfig } from "./config.ts";
import { type Caller, Guard, type RoleOverride } from "./guard.ts";
import { PassVerifier } from "./pass.ts";
import { Recorder } from "./recorder.ts";
import { buildServer } from "./tools.ts";
import { Upstreams } from "./upstream.ts";

export type GatewayDeps = {
  db: Db;
  config: GatewayConfig;
  fhir?: FhirClient;
  verifier?: PassVerifier;
  /** How the gateway reaches other FHIR servers and their token endpoints (tests watch it). */
  upstreamFetch?: typeof fetch;
};

const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function createGateway(deps: GatewayDeps) {
  const { db, config } = deps;
  const fhir =
    deps.fhir ?? new FhirClient({ baseUrl: config.fhirBaseUrl, headers: config.fhirHeaders });
  const broken = config.broken;
  if (broken.size) {
    console.warn(
      `\n!!! aipass gateway running with PLANTED DEFECTS: ${[...broken].join(", ")} !!!\n`,
    );
  }
  const verifier =
    deps.verifier ?? new PassVerifier(config.gatewayUrl, config.trustedIssuers, undefined, broken);
  const recorder = new Recorder(db, fhir, broken);
  const upstreams = new Upstreams({
    db,
    home: fhir,
    key: config.vaultKey,
    keys: config.vaultKeys,
    fetch: deps.upstreamFetch,
  });
  const guard = new Guard({ db, config, recorder, upstreams, broken });
  const changes = new Changes({ db, config, recorder, guard, broken });

  // One handler serves MCP 2026-07-28 and falls back to stateless 2025-11-25.
  // The factory builds a fresh server per request, bound to the verified pass.
  const mcp = createMcpHandler(({ authInfo }) => {
    const claims = authInfo?.extra?.claims as PassClaims | undefined;
    const agentId = authInfo?.extra?.agentId as string | undefined;
    if (!claims || !agentId) {
      throw new Error("MCP request reached the handler without a verified pass");
    }
    const clientId = authInfo?.extra?.clientId;
    return buildServer(
      guard,
      {
        agentId,
        claims,
        mode: "live",
        clientId: typeof clientId === "string" ? clientId : undefined,
      },
      broken,
      changes,
    );
  });

  const prmUrl = (agentId: string) =>
    `${config.gatewayUrl}/.well-known/oauth-protected-resource/agents/${agentId}/mcp`;

  const app = new Hono();
  // Security headers on every response (S7). HSTS only takes effect over
  // HTTPS, which the adopter terminates in front of aipass.
  app.use(
    "*",
    secureHeaders({
      strictTransportSecurity: "max-age=31536000",
      referrerPolicy: "no-referrer",
      xFrameOptions: "DENY",
    }),
  );

  app.get("/health", (c) => c.json({ status: "ok", service: "aipass-gateway" }));

  // RFC 9728 Protected Resource Metadata, one document per agent endpoint.
  app.get("/.well-known/oauth-protected-resource/agents/:agentId/mcp", async (c) => {
    const agentId = c.req.param("agentId");
    const agent = AGENT_ID.test(agentId) ? await findAgent(db, agentId) : undefined;
    if (!agent) return c.json({ error: "no such agent" }, 404);
    return c.json({
      resource: agentUrl(config.gatewayUrl, agentId),
      resource_name: `${agent.name} (aipass)`,
      authorization_servers: config.authorizationServers,
      bearer_methods_supported: ["header"],
      scopes_supported: ["openid", "offline_access"],
    });
  });

  // "Preview as this role": the api asks, signed with its own key; the same
  // guard runs every group in preview mode (receipts marked preview).
  app.post("/internal/preview", async (c) => {
    const v = await verifier.verifyPreview(c.req.header("authorization"), config.apiUrl);
    if (!v.ok) return c.json({ error: "invalid_token", error_description: v.error }, 401);
    const p = v.claims.preview;
    let agentId: string;
    let override: RoleOverride | undefined;
    if ("roleId" in p) {
      const [role] = await db.select().from(roles).where(eq(roles.id, p.roleId));
      if (!role) return c.json({ error: "no such role" }, 404);
      agentId = `preview-${role.id}`;
      override = {
        agent: { id: agentId, name: `${role.name} (preview)` },
        role: {
          name: role.name,
          permissions: rulesToPermissions(role.rules),
          patientFields: role.patientFields,
        },
      };
    } else {
      if (!(await findAgent(db, p.agentId))) return c.json({ error: "no such agent" }, 404);
      agentId = p.agentId;
    }
    const now = Math.floor(Date.now() / 1000);
    const caller: Caller = {
      agentId,
      mode: "preview",
      claims: {
        iss: v.claims.iss,
        sub: p.personId,
        aud: `${config.gatewayUrl}/internal/preview`,
        iat: now,
        exp: now + 60,
        jti: v.claims.jti,
        act: { sub: agentId },
      },
    };
    const groups = await Promise.all(
      GROUPS.map(async (group) => {
        const o = await guard.read(caller, { tool: "preview", group, limit: 20 }, override);
        return o.decision === "allow"
          ? { group, decision: "allow" as const, records: o.records, withheld: o.withheld }
          : { group, decision: "refuse" as const, rule: o.rule, reason: o.reason };
      }),
    );
    return c.json({ agentId, personId: p.personId, groups });
  });

  app.all("/agents/:agentId/mcp", async (c) => {
    const agentId = c.req.param("agentId");
    const agent = AGENT_ID.test(agentId) ? await findAgent(db, agentId) : undefined;
    if (!agent) return c.json({ error: "no such agent" }, 404);

    const result = await verifier.verify(c.req.header("authorization"), agentId);
    if (!result.ok) {
      const reason = `no valid pass (${result.error})`;
      await recorder.record({
        agent: { id: agentId, name: agent.name },
        person: null,
        patientRef: null,
        passJti: null,
        tool: null,
        action: "connect",
        group: null,
        interaction: "search-type",
        decision: "refuse",
        rule: 1,
        code: "pass_invalid",
        reason,
        sentence: receiptSentence({
          decision: "refuse",
          agentName: agent.name,
          personName: null,
          action: "connect",
          group: null,
          reason,
        }),
        mode: "live",
      });
      const desc =
        result.error === "missing"
          ? ""
          : `, error="invalid_token", error_description="${result.error}"`;
      return c.json({ error: "invalid_token", error_description: result.error }, 401, {
        "WWW-Authenticate": `Bearer resource_metadata="${prmUrl(agentId)}"${desc}`,
      });
    }

    return mcp.fetch(c.req.raw, {
      authInfo: {
        token: "[verified pass]",
        clientId: result.claims.act.sub,
        scopes: result.claims.scope?.split(" ") ?? [],
        expiresAt: result.claims.exp,
        resource: new URL(agentUrl(config.gatewayUrl, agentId)),
        resourceMetadataUrl: prmUrl(agentId),
        extra: { claims: result.claims, agentId, clientId: result.clientId },
      },
    });
  });

  return { app, guard, changes, recorder, fhir };
}

async function findAgent(db: Db, id: string) {
  const [a] = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(eq(agents.id, id));
  return a;
}
