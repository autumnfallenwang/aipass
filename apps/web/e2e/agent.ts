import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { E2E } from "./env.ts";

/** Plays the AI agent: gets a dev pass from the api, then calls the gateway over MCP. */
export async function asAgent(agentId: string, personId: string) {
  const res = await fetch(`${E2E.api}/dev/passes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: agentId, person: personId }),
  });
  if (!res.ok) throw new Error(`dev pass: ${res.status} ${await res.text()}`);
  const { token } = (await res.json()) as { token: string };
  const client = new Client({ name: "e2e-agent", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${E2E.gateway}/agents/${agentId}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return {
    async call(name: string, args: Record<string, unknown> = {}) {
      const r = await client.callTool({ name, arguments: args });
      const text = (r.content as { text?: string }[]).map((c) => c.text ?? "").join("\n");
      return { text, refused: r.isError === true };
    },
    close: () => client.close(),
  };
}
