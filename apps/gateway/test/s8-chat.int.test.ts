/**
 * S8: the built-in chat's loop against the real gateway, Postgres and HAPI,
 * with a scripted model. The chat is an ordinary app: every tool call is
 * checked, refused where it should be, and recorded with the app's name.
 * See docs/PLAN.md § S8.
 */
import {
  type ChatEvent,
  type ChatMessage,
  connectGateway,
  type ModelCall,
  runChat,
} from "@aipass/chat";
import { agents, CHAT_CLIENT_ID, receipts, verifyReceiptChain } from "@aipass/db";
import { agentUrl } from "@aipass/shared";
import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, GATEWAY, type Harness } from "./harness.ts";

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.close();
});
beforeEach(async () => {
  await h.reset();
});

/**
 * A model that calls one tool for the person's question, then answers with
 * what the gateway sent back, so the test can see exactly what got through.
 */
function scriptedModel(tool: string, args: Record<string, unknown> = {}): ModelCall {
  return async function* (req) {
    const last = req.messages.at(-1);
    if (last?.role === "tool") {
      yield { type: "text", delta: `From your record: ${last.content}` };
      yield {
        type: "done",
        message: { role: "assistant", content: `From your record: ${last.content}` },
        finishReason: "stop",
      };
      return;
    }
    expect(req.tools?.map((t) => t.function.name)).toContain(tool);
    yield {
      type: "done",
      finishReason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: tool, arguments: JSON.stringify(args) },
          },
        ],
      },
    };
  };
}

async function chat(
  agent: string,
  question: string,
  model: ModelCall,
  clientId: string = CHAT_CLIENT_ID,
) {
  const pass = await h.pass(agent, "maria", { claims: { client_id: clientId } });
  const tools = await connectGateway(agentUrl(GATEWAY, agent), pass, { fetch: h.appFetch });
  const events: ChatEvent[] = [];
  try {
    const added = await runChat({
      model,
      tools,
      system: "You are a test.",
      history: [{ role: "user", content: question } satisfies ChatMessage],
      emit: (e) => events.push(e),
    });
    const answer = added.at(-1);
    return {
      events,
      answer: answer?.role === "assistant" ? (answer.content ?? "") : "",
      result: events.find((e) => e.type === "tool_result"),
    };
  } finally {
    await tools.close();
  }
}

async function latest() {
  const [r] = await h.db.select().from(receipts).orderBy(desc(receipts.seq)).limit(1);
  return r;
}

describe("S8: the built-in chat through the gateway", () => {
  it("answers from the record, and the receipt names the chat app", async () => {
    const r = await chat(
      "diabetes-coach",
      "What was my last A1c?",
      scriptedModel("search_labs", { code: "4548-4" }),
    );
    expect(r.result).toMatchObject({ type: "tool_result", name: "search_labs", refused: false });
    expect(r.answer).toContain("6.9 %");
    const receipt = await latest();
    expect(receipt).toMatchObject({
      agentId: "diabetes-coach",
      tool: "search_labs",
      decision: "allow",
      clientId: CHAT_CLIENT_ID,
    });
    // The new field is in the hash, and the chain still verifies.
    expect(await verifyReceiptChain(h.db)).toBeNull();
  });

  it("offers the model only the gateway's tools", async () => {
    let offered: string[] = [];
    const model: ModelCall = async function* (req) {
      offered = req.tools?.map((t) => t.function.name) ?? [];
      yield { type: "done", message: { role: "assistant", content: "Hi." }, finishReason: "stop" };
    };
    await chat("diabetes-coach", "hi", model);
    expect(offered).toContain("search_labs");
    expect(offered).toContain("propose_observation");
    expect(offered).not.toContain("delete_record");
  });

  it("a refusal reaches the person in the gateway's words", async () => {
    const r = await chat(
      "scheduling-assistant",
      "What was my last A1c?",
      scriptedModel("search_labs"),
    );
    expect(r.result).toMatchObject({ refused: true });
    expect(r.result && "summary" in r.result ? r.result.summary : "").toContain("REFUSED");
    expect(r.answer).toContain("not in the Scheduling Assistant role");
    expect(await latest()).toMatchObject({ decision: "refuse", clientId: CHAT_CLIENT_ID });
  });

  it("mental-health records stay private, whatever the model asks for", async () => {
    const r = await chat(
      "diabetes-coach",
      "Show me my medications",
      scriptedModel("list_medications"),
    );
    expect(r.result).toMatchObject({ refused: false });
    expect(r.answer).toContain("withheld");
    expect(r.answer).not.toContain("sertraline");
    expect(r.answer).not.toContain("Sertraline");
  });

  it("Stop works on the chat's very next call", async () => {
    await h.db.update(agents).set({ status: "stopped" }).where(eq(agents.id, "diabetes-coach"));
    const r = await chat("diabetes-coach", "What was my last A1c?", scriptedModel("search_labs"));
    expect(r.result).toMatchObject({ refused: true });
    expect(r.answer).toContain("stopped");
  });

  it("the chat can't act as an agent it isn't approved for", async () => {
    const r = await chat(
      "diabetes-coach",
      "What was my last A1c?",
      scriptedModel("search_labs"),
      "some-other-app",
    );
    expect(r.result).toMatchObject({ refused: true });
    expect(r.answer).toContain("this app isn't approved to act as Diabetes Coach");
  });
});
