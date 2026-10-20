import { agents, type Db } from "@aipass/db";
import { FhirClient, receiptSentence } from "@aipass/fhir";
import { agentUrl, type PassClaims } from "@aipass/shared";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { GatewayConfig } from "./config.ts";
import { Guard } from "./guard.ts";
import { PassVerifier } from "./pass.ts";
import { Recorder } from "./recorder.ts";
import { buildServer } from "./tools.ts";

export type GatewayDeps = {
  db: Db;
  config: GatewayConfig;
  fhir?: FhirClient;
  verifier?: PassVerifier;
};

const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function createGateway(deps: GatewayDeps) {
  const { db, config } = deps;
  const fhir =
    deps.fhir ?? new FhirClient({ baseUrl: config.fhirBaseUrl, headers: config.fhirHeaders });
  const verifier = deps.verifier ?? new PassVerifier(config.gatewayUrl, config.trustedIssuers);
  const recorder = new Recorder(db, fhir);
  const guard = new Guard({ db, fhir, config, recorder });

  // One handler serves MCP 2026-07-28 and falls back to stateless 2025-11-25.
  // The factory builds a fresh server per request, bound to the verified pass.
  const mcp = createMcpHandler(({ authInfo }) => {
    const claims = authInfo?.extra?.claims as PassClaims | undefined;
    const agentId = authInfo?.extra?.agentId as string | undefined;
    if (!claims || !agentId)
      throw new Error("MCP request reached the handler without a verified pass");
    return buildServer(guard, { agentId, claims, mode: "live" });
  });

  const prmUrl = (agentId: string) =>
    `${config.gatewayUrl}/.well-known/oauth-protected-resource/agents/${agentId}/mcp`;

  const app = new Hono();

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
        extra: { claims: result.claims, agentId },
      },
    });
  });

  return { app, guard, recorder, fhir };
}

async function findAgent(db: Db, id: string) {
  const [a] = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(eq(agents.id, id));
  return a;
}
