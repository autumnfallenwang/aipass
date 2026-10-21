/**
 * The chat's side of the gateway: an MCP client holding the person's pass,
 * like any other AI app. It has no other way in.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

export type GatewayTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

export type ToolOutcome = { text: string; refused: boolean };

/** What the loop needs from the gateway; tests pass their own. */
export type ToolPort = {
  instructions?: string;
  listTools(): Promise<GatewayTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolOutcome>;
  close(): Promise<void>;
};

/** Connects to one agent's gateway URL (`…/agents/{id}/mcp`) with a pass. */
export async function connectGateway(
  url: string,
  pass: string,
  opts: { fetch?: typeof fetch } = {},
): Promise<ToolPort> {
  const client = new Client({ name: "aipass-chat", version: "1.1.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${pass}` } },
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    }),
  );
  return {
    instructions: client.getInstructions(),
    async listTools() {
      const { tools } = await client.listTools();
      return tools.map((t) => ({
        name: t.name,
        title: t.title ?? t.annotations?.title,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown>,
      }));
    },
    async callTool(name, args) {
      const r = await client.callTool({ name, arguments: args });
      const text = ((r.content ?? []) as { type: string; text?: string }[])
        .map((c) => (c.type === "text" ? (c.text ?? "") : ""))
        .join("\n");
      return { text, refused: r.isError === true };
    },
    close: () => client.close(),
  };
}
