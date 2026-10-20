import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Outcome } from "./types.ts";

/**
 * Calls one MCP tool as a fresh client, with an optional bearer token, and
 * sorts the answer into ok / refused / unauthorized / error. A 401 or 403 at
 * connect time is "unauthorized"; a tool result flagged `isError` is "refused".
 */
export async function callTool(
  url: string,
  bearer: string | undefined,
  tool: string,
  args: Record<string, unknown>,
  fetchImpl?: typeof fetch,
): Promise<Outcome> {
  const client = new Client({ name: "aipass-check", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: bearer ? { headers: { authorization: `Bearer ${bearer}` } } : undefined,
    fetch: fetchImpl,
  });
  try {
    await client.connect(transport);
  } catch (err) {
    const msg = (err as Error).message;
    if (/\b(401|403)\b|unauthori[sz]ed|invalid_token|forbidden/i.test(msg)) {
      return { status: "unauthorized", text: msg };
    }
    return { status: "error", text: msg };
  }
  try {
    const r = await client.callTool({ name: tool, arguments: args });
    const text = (r.content as { type: string; text?: string }[])
      .map((c) => c.text ?? JSON.stringify(c))
      .join("\n");
    return {
      status: r.isError ? "refused" : "ok",
      text: `${text}${JSON.stringify(r.structuredContent ?? "")}`,
    };
  } catch (err) {
    return { status: "error", text: (err as Error).message };
  } finally {
    await client.close().catch(() => {});
  }
}
