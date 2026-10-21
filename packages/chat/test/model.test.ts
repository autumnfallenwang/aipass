import { describe, expect, it } from "vitest";
import {
  listModels,
  ModelError,
  type ModelEvent,
  probeEndpoint,
  streamChat,
} from "../src/model.ts";

const EP = { baseUrl: "http://model.test/v1/", apiKey: "sk-test" };

/** A fetch that answers with server-sent events, one `data:` line per chunk. */
function sseFetch(chunks: unknown[], seen: Request[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push(new Request(url, init));
    const body = `${chunks.map((c) => `data: ${typeof c === "string" ? c : JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`;
    // Split mid-line, as a real network would.
    const bytes = new TextEncoder().encode(body);
    const stream = new ReadableStream<Uint8Array>({
      start(ctl) {
        for (let i = 0; i < bytes.length; i += 7) ctl.enqueue(bytes.slice(i, i + 7));
        ctl.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
}

function jsonFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

async function collect(it: AsyncIterable<ModelEvent>) {
  const out: ModelEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const choice = (delta: unknown, finish: string | null = null) => ({
  choices: [{ index: 0, delta, finish_reason: finish }],
});

describe("streamChat", () => {
  it("streams text, then the whole message", async () => {
    const seen: Request[] = [];
    const events = await collect(
      streamChat(
        EP,
        { model: "m", messages: [{ role: "user", content: "hi" }] },
        {
          fetch: sseFetch(
            [choice({ role: "assistant", content: "Hel" }), choice({ content: "lo" }, "stop")],
            seen,
          ),
        },
      ),
    );
    expect(events).toEqual([
      { type: "text", delta: "Hel" },
      { type: "text", delta: "lo" },
      { type: "done", message: { role: "assistant", content: "Hello" }, finishReason: "stop" },
    ]);
    const req = seen[0];
    expect(req?.url).toBe("http://model.test/v1/chat/completions");
    expect(req?.headers.get("authorization")).toBe("Bearer sk-test");
    const body = (await req?.json()) as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body).not.toHaveProperty("tools");
  });

  it("assembles tool calls sent in pieces, in order", async () => {
    const events = await collect(
      streamChat(
        EP,
        {
          model: "m",
          messages: [{ role: "user", content: "labs and meds" }],
          tools: [{ type: "function", function: { name: "search_labs", parameters: {} } }],
        },
        {
          fetch: sseFetch([
            choice({
              tool_calls: [{ index: 0, id: "c1", function: { name: "search_", arguments: "" } }],
            }),
            choice({
              tool_calls: [{ index: 0, function: { name: "labs", arguments: '{"code":' } }],
            }),
            choice({
              tool_calls: [
                { index: 1, id: "c2", function: { name: "get_medications", arguments: "{}" } },
              ],
            }),
            choice(
              { tool_calls: [{ index: 0, function: { arguments: '"4548-4"}' } }] },
              "tool_calls",
            ),
          ]),
        },
      ),
    );
    expect(events).toEqual([
      {
        type: "done",
        finishReason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "search_labs", arguments: '{"code":"4548-4"}' },
            },
            { id: "c2", type: "function", function: { name: "get_medications", arguments: "{}" } },
          ],
        },
      },
    ]);
  });

  it("takes an answer that came in one piece despite stream: true", async () => {
    const events = await collect(
      streamChat(
        EP,
        { model: "m", messages: [] },
        {
          fetch: jsonFetch(200, {
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [{ id: "x", function: { name: "search_labs", arguments: "" } }],
                },
                finish_reason: "tool_calls",
              },
            ],
          }),
        },
      ),
    );
    expect(events.at(-1)).toEqual({
      type: "done",
      finishReason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "x", type: "function", function: { name: "search_labs", arguments: "{}" } },
        ],
      },
    });
  });

  it("reports the endpoint's own error, and whether another model is worth trying", async () => {
    const bad = streamChat(
      EP,
      { model: "m", messages: [] },
      {
        fetch: jsonFetch(400, { error: { message: "model 'm' not found" } }),
      },
    );
    const err = await collect(bad).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).message).toBe(
      "the model endpoint answered 400: model 'm' not found",
    );
    expect((err as ModelError).retryable).toBe(false);

    const down = streamChat(
      EP,
      { model: "m", messages: [] },
      {
        fetch: (async () => {
          throw new TypeError("fetch failed");
        }) as unknown as typeof fetch,
      },
    );
    const err2 = (await collect(down).catch((e: unknown) => e)) as ModelError;
    expect(err2.message).toBe("couldn't reach the model endpoint (fetch failed)");
    expect(err2.retryable).toBe(true);
  });

  it("stops on an error sent inside the stream", async () => {
    const err = await collect(
      streamChat(
        EP,
        { model: "m", messages: [] },
        {
          fetch: sseFetch([choice({ content: "par" }), { error: { message: "overloaded" } }]),
        },
      ),
    ).catch((e: unknown) => e);
    expect((err as ModelError).message).toBe("the model stopped: overloaded");
  });
});

describe("listModels and probeEndpoint", () => {
  it("lists model ids", async () => {
    expect(
      await listModels(EP, {
        fetch: jsonFetch(200, { object: "list", data: [{ id: "a" }, { id: "b" }] }),
      }),
    ).toEqual(["a", "b"]);
  });

  it("says when the list isn't OpenAI-shaped", async () => {
    await expect(listModels(EP, { fetch: jsonFetch(200, { models: [] }) })).rejects.toThrow(
      "the endpoint's model list isn't in the OpenAI format",
    );
  });

  it("checks that the chosen model calls a tool", async () => {
    let n = 0;
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      n++;
      if (String(url).endsWith("/models"))
        return jsonFetch(200, { data: [{ id: "m" }] })(url, init);
      return sseFetch([
        choice(
          { tool_calls: [{ index: 0, id: "p", function: { name: "ping", arguments: "{}" } }] },
          "tool_calls",
        ),
      ])(url, init);
    }) as typeof fetch;
    const r = await probeEndpoint(EP, "m", { fetch: fetchFn });
    expect(n).toBe(2);
    expect(r.models).toEqual(["m"]);
    expect(r.toolCall).toMatchObject({ model: "m", ok: true, detail: "it called the tool" });
  });

  it("flags a model that answers without calling the tool", async () => {
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) =>
      String(url).endsWith("/models")
        ? jsonFetch(200, { data: [{ id: "m" }] })(url, init)
        : sseFetch([choice({ content: "pong" }, "stop")])(url, init)) as typeof fetch;
    const r = await probeEndpoint(EP, "m", { fetch: fetchFn });
    expect(r.toolCall?.ok).toBe(false);
  });
});
