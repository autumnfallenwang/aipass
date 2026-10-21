/**
 * The loop between a model and the gateway (S8). The gateway's tools become
 * the model's tools; each tool call goes to the gateway with the pass, where
 * it's checked and recorded like any other app's; results go back until the
 * model answers. The model never sees a credential.
 */
import type { GatewayTool, ToolPort } from "./mcp.ts";
import {
  type AssistantMessage,
  type ChatMessage,
  ModelError,
  type ModelEvent,
  type ModelRequest,
  type ToolDef,
} from "./model.ts";

/** What the person's browser is told, as it happens. */
export type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "tool"; id: string; name: string; title: string; args: Record<string, unknown> }
  | {
      type: "tool_result";
      id: string;
      name: string;
      refused: boolean;
      /** One line, for the person: what came back, or why it was refused. */
      summary: string;
      /** For a proposed change: where the person approves it. */
      approveUrl?: string;
    }
  | { type: "notice"; text: string };

/** One model call; `withFallback` and the api bind it to an endpoint and model. */
export type ModelCall = (req: Omit<ModelRequest, "model">) => AsyncIterable<ModelEvent>;

export const MAX_STEPS = 8;

/** MCP tools as OpenAI function tools. */
export function toToolDefs(tools: GatewayTool[]): ToolDef[] {
  return tools.map((t) => {
    const { $schema: _drop, ...schema } = t.inputSchema;
    return {
      type: "function",
      function: {
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        parameters: { type: "object", properties: {}, ...schema },
      },
    };
  });
}

function parseArgs(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The gateway's first line ("2 record(s) for Maria Santos.", "REFUSED: …"), for the person. */
function summaryOf(text: string): string {
  const first = text.split("\n").find((l) => l.trim()) ?? "";
  return first.length > 300 ? `${first.slice(0, 297)}…` : first;
}

const APPROVE_URL = /approve it with their passkey here: (\S+)/;

/**
 * Tries the first model; if it can't be reached (or is overloaded) before it
 * said anything, the rest of the turn goes to the fallback.
 */
export function withFallback(
  primary: ModelCall,
  fallback: ModelCall | null,
  onSwitch: (err: ModelError) => void,
): ModelCall {
  let current = primary;
  return async function* (req) {
    let said = false;
    try {
      for await (const e of current(req)) {
        said = true;
        yield e;
      }
    } catch (err) {
      if (
        !(err instanceof ModelError) ||
        !err.retryable ||
        said ||
        !fallback ||
        current === fallback
      )
        throw err;
      onSwitch(err);
      current = fallback;
      yield* current(req);
    }
  };
}

/**
 * Runs one turn: the person's latest message (last in `history`) to an answer.
 * Returns the messages this turn added (assistant and tool), for the browser
 * to keep and send back next time.
 */
export async function runChat(p: {
  model: ModelCall;
  tools: ToolPort;
  system: string;
  history: ChatMessage[];
  emit: (e: ChatEvent) => void;
  maxSteps?: number;
}): Promise<ChatMessage[]> {
  const listed = await p.tools.listTools();
  const byName = new Map(listed.map((t) => [t.name, t]));
  const defs = toToolDefs(listed);
  const added: ChatMessage[] = [];
  const conversation = (): ChatMessage[] => [
    { role: "system", content: p.system },
    ...p.history,
    ...added,
  ];

  for (let step = 0; step < (p.maxSteps ?? MAX_STEPS); step++) {
    let message: AssistantMessage | undefined;
    for await (const e of p.model({ messages: conversation(), tools: defs })) {
      if (e.type === "text") p.emit(e);
      else message = e.message;
    }
    if (!message) throw new ModelError("the model ended without an answer");
    added.push(message);
    const calls = message.tool_calls ?? [];
    if (calls.length === 0) return added;

    for (const call of calls) {
      const name = call.function.name;
      const tool = byName.get(name);
      const args = parseArgs(call.function.arguments);
      let text: string;
      let refused: boolean;
      if (!tool) {
        // Fail closed: nothing the gateway didn't offer is ever sent.
        text = `REFUSED: there's no tool called "${name}". Use only the tools listed.`;
        refused = true;
        p.emit({ type: "tool", id: call.id, name, title: name, args: {} });
      } else if (!args) {
        text = `REFUSED: the arguments for ${name} weren't a JSON object.`;
        refused = true;
        p.emit({ type: "tool", id: call.id, name, title: tool.title ?? name, args: {} });
      } else {
        p.emit({ type: "tool", id: call.id, name, title: tool.title ?? name, args });
        const out = await p.tools.callTool(name, args);
        text = out.text;
        refused = out.refused;
      }
      const approveUrl = refused ? undefined : APPROVE_URL.exec(text)?.[1];
      p.emit({
        type: "tool_result",
        id: call.id,
        name,
        refused,
        summary: summaryOf(text),
        ...(approveUrl ? { approveUrl } : {}),
      });
      added.push({ role: "tool", tool_call_id: call.id, content: text });
    }
  }
  p.emit({
    type: "notice",
    text: `Stopped after ${p.maxSteps ?? MAX_STEPS} steps without an answer. Try asking more simply.`,
  });
  return added;
}
