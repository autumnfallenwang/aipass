/**
 * Prints {"Authorization": "Bearer <pass>"} for Claude Code's `headersHelper`,
 * for a headless agent (S6): it swaps the person's token from the hospital's
 * login for an aipass pass (RFC 8693 token exchange), authenticating as
 * itself with the client the admin created on the agent's Apps dialog.
 *
 *   AIPASS_CLIENT_ID=… AIPASS_CLIENT_SECRET=… tsx scripts/exchange-header.ts --agent diabetes-coach
 *
 * The person's token: AIPASS_SUBJECT_TOKEN if set. Otherwise, for the local
 * demo only, a password grant against the dev Keycloak realm "sunrise"
 * (maria / maria-kc-password), standing in for "Maria signed in at her hospital".
 */
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    agent: { type: "string" },
    "public-url": { type: "string", default: process.env.PUBLIC_URL ?? "http://localhost:3000" },
    "gateway-url": { type: "string", default: process.env.GATEWAY_URL ?? "http://localhost:3002" },
    "hospital-user": { type: "string", default: "maria" },
    "hospital-password": { type: "string", default: "maria-kc-password" },
  },
});

function fail(msg: string): never {
  process.stderr.write(`exchange-header: ${msg}\n`);
  process.exit(1);
}

const agent = values.agent ?? fail("--agent is required");
const clientId =
  process.env.AIPASS_CLIENT_ID ?? fail("set AIPASS_CLIENT_ID (from the agent's Apps dialog)");
const clientSecret = process.env.AIPASS_CLIENT_SECRET ?? fail("set AIPASS_CLIENT_SECRET");

async function subjectToken(): Promise<string> {
  if (process.env.AIPASS_SUBJECT_TOKEN) return process.env.AIPASS_SUBJECT_TOKEN;
  const realm = process.env.KEYCLOAK_URL ?? "http://localhost:8180/realms/sunrise";
  const res = await fetch(`${realm}/protocol/openid-connect/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "coach-cli",
      username: values["hospital-user"] ?? "",
      password: values["hospital-password"] ?? "",
      scope: "openid",
    }),
  });
  const body = (await res.json()) as { access_token?: string; error?: string };
  return body.access_token ?? fail(`the hospital login said ${body.error ?? res.status}`);
}

const res = await fetch(`${values["public-url"]}/api/auth/oauth2/token`, {
  method: "POST",
  headers: {
    authorization: `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString("base64")}`,
    "content-type": "application/x-www-form-urlencoded",
  },
  body: new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: await subjectToken(),
    subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
    resource: `${values["gateway-url"]}/agents/${agent}/mcp`,
  }),
});
const body = (await res.json()) as {
  access_token?: string;
  error?: string;
  error_description?: string;
};
if (!body.access_token) fail(`${body.error ?? res.status}: ${body.error_description ?? ""}`);
process.stdout.write(JSON.stringify({ Authorization: `Bearer ${body.access_token}` }));
