import { describe, expect, it, vi } from "vitest";
import { type ChatEvent, type ModelCall, runChat, toToolDefs, withFallback } from "../src/loop.ts";
import type { GatewayTool, ToolPort } from "../src/mcp.ts";
import {
  type AssistantMessage,
  type ChatMessage,
  ModelError,
  type ModelEvent,
} from "../src/model.ts";

const TOOLS: GatewayTool[] = [
  {
    name: "search_labs",
    title: "Lab results",
    description: "The patient's lab results",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { code: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "propose_observation",
    title: "Propose a reading",
    inputSchema: { type: "object", properties: { value: { type: "number" } } },
  },
];

function tools(answers: Record<string, { text: string; refused?: boolean }>) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const port: ToolPort = {
    listTools: async () => TOOLS,
    callTool: async (name, args) => {
      calls.push({ name, args });
      const a = answers[name] ?? { text: "nothing" };
      return { text: a.text, refused: a.refused ?? false };
    },
    close: async () => {},
  };
  return { port, calls };
}

const say = (content: string): AssistantMessage => ({ role: "assistant", content });
const callTool = (id: string, name: string, args: string): AssistantMessage => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id, type: "function", function: { name, arguments: args } }],
});

/** A model that gives these answers in turn, and remembers what it was sent. */
function scripted(...answers: AssistantMessage[]) {
  const seen: ChatMessage[][] = [];
  const call: ModelCall = async function* (req) {
    seen.push(req.messages);
    const m = answers.shift();
    if (!m) throw new Error("no more answers");
    if (m.content) yield { type: "text", delta: m.content } satisfies ModelEvent;
    yield { type: "done", message: m, finishReason: m.tool_calls ? "tool_calls" : "stop" };
  };
  return { call, seen };
}

const user = (content: string): ChatMessage => ({ role: "user", content });

describe("toToolDefs", () => {
  it("turns MCP tools into function tools, without $schema", () => {
    const [labs] = toToolDefs(TOOLS);
    expect(labs).toEqual({
      type: "function",
      function: {
        name: "search_labs",
        description: "The patient's lab results",
        parameters: {
          type: "object",
          properties: { code: { type: "string" } },
          additionalProperties: false,
        },
      },
    });
  });
});

describe("runChat", () => {
  it("calls the gateway's tool, gives the model the result, and returns the answer", async () => {
    const t = tools({ search_labs: { text: "1 record(s) for Maria Santos.\n[HbA1c 6.9 %]" } });
    const m = scripted(
      callTool("c1", "search_labs", '{"code":"4548-4"}'),
      say("Your A1c was 6.9 %."),
    );
    const events: ChatEvent[] = [];
    const added = await runChat({
      model: m.call,
      tools: t.port,
      system: "You are the Diabetes Coach.",
      history: [user("What was my last A1c?")],
      emit: (e) => events.push(e),
    });
    expect(t.calls).toEqual([{ name: "search_labs", args: { code: "4548-4" } }]);
    expect(events).toEqual([
      {
        type: "tool",
        id: "c1",
        name: "search_labs",
        title: "Lab results",
        args: { code: "4548-4" },
      },
      {
        type: "tool_result",
        id: "c1",
        name: "search_labs",
        refused: false,
        summary: "1 record(s) for Maria Santos.",
      },
      { type: "text", delta: "Your A1c was 6.9 %." },
    ]);
    expect(added.map((x) => x.role)).toEqual(["assistant", "tool", "assistant"]);
    // The second model call saw the system prompt, the question, the call and the result.
    expect(m.seen[1]?.map((x) => x.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(m.seen[1]?.[0]).toEqual({ role: "system", content: "You are the Diabetes Coach." });
  });

  it("shows a refusal as the gateway gave it", async () => {
    const t = tools({
      search_labs: {
        text: "REFUSED: Maria hasn't agreed to lab results.\nThis was checked by aipass",
        refused: true,
      },
    });
    const events: ChatEvent[] = [];
    await runChat({
      model: scripted(callTool("c1", "search_labs", "{}"), say("I can't see your labs.")).call,
      tools: t.port,
      system: "",
      history: [user("labs?")],
      emit: (e) => events.push(e),
    });
    expect(events.find((e) => e.type === "tool_result")).toEqual({
      type: "tool_result",
      id: "c1",
      name: "search_labs",
      refused: true,
      summary: "REFUSED: Maria hasn't agreed to lab results.",
    });
  });

  it("fails closed on a tool the gateway didn't offer: nothing is sent", async () => {
    const t = tools({});
    const m = scripted(callTool("c1", "delete_everything", "{}"), say("Sorry."));
    const events: ChatEvent[] = [];
    const added = await runChat({
      model: m.call,
      tools: t.port,
      system: "",
      history: [user("go")],
      emit: (e) => events.push(e),
    });
    expect(t.calls).toEqual([]);
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({ refused: true });
    expect(added[1]).toMatchObject({ role: "tool", content: expect.stringContaining("REFUSED") });
  });

  it("refuses arguments that aren't a JSON object", async () => {
    const t = tools({});
    await runChat({
      model: scripted(callTool("c1", "search_labs", "[1,2]"), say("ok")).call,
      tools: t.port,
      system: "",
      history: [user("go")],
      emit: () => {},
    });
    expect(t.calls).toEqual([]);
  });

  it("passes on where to approve a proposed change", async () => {
    const t = tools({
      propose_observation: {
        text: "Proposed (nothing written yet): blood glucose 142 mg/dL.\nMaria Santos must approve it with their passkey here: http://localhost:3000/approve/apr_1\nThe proposal expires",
      },
    });
    const events: ChatEvent[] = [];
    await runChat({
      model: scripted(
        callTool("c1", "propose_observation", '{"value":142}'),
        say("Approve it, please."),
      ).call,
      tools: t.port,
      system: "",
      history: [user("add 142")],
      emit: (e) => events.push(e),
    });
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({
      approveUrl: "http://localhost:3000/approve/apr_1",
    });
  });

  it("stops after the step limit", async () => {
    const t = tools({ search_labs: { text: "1 record(s)" } });
    const loopForever: ModelCall = async function* () {
      yield {
        type: "done",
        message: callTool(`c${Math.random()}`, "search_labs", "{}"),
        finishReason: "tool_calls",
      };
    };
    const events: ChatEvent[] = [];
    await runChat({
      model: loopForever,
      tools: t.port,
      system: "",
      history: [user("go")],
      emit: (e) => events.push(e),
      maxSteps: 3,
    });
    expect(t.calls).toHaveLength(3);
    expect(events.at(-1)).toEqual({
      type: "notice",
      text: "Stopped after 3 steps without an answer. Try asking more simply.",
    });
  });
});

describe("withFallback", () => {
  const down: ModelCall = async function* () {
    yield* [];
    throw new ModelError("couldn't reach the model endpoint (fetch failed)");
  };
  const answer: ModelCall = async function* () {
    yield { type: "done", message: say("from the fallback"), finishReason: "stop" };
  };

  it("switches to the fallback when the first model can't be reached", async () => {
    const onSwitch = vi.fn();
    const call = withFallback(down, answer, onSwitch);
    const out: ModelEvent[] = [];
    for await (const e of call({ messages: [] })) out.push(e);
    expect(out).toEqual([
      { type: "done", message: say("from the fallback"), finishReason: "stop" },
    ]);
    expect(onSwitch).toHaveBeenCalledOnce();
  });

  it("doesn't switch when the request itself was wrong", async () => {
    const wrong: ModelCall = async function* () {
      yield* [];
      throw new ModelError("the model endpoint answered 400: bad", 400);
    };
    const call = withFallback(wrong, answer, () => {});
    await expect(async () => {
      for await (const _ of call({ messages: [] })) {
        // drain
      }
    }).rejects.toThrow("answered 400");
  });

  it("without a fallback, the error goes to the caller", async () => {
    const call = withFallback(down, null, () => {});
    await expect(async () => {
      for await (const _ of call({ messages: [] })) {
        // drain
      }
    }).rejects.toThrow("couldn't reach");
  });
});
