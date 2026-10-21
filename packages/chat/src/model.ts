/**
 * A client for any OpenAI-compatible chat endpoint (D16): chat completions
 * with tool calling, streamed. Hosted or local, a gateway or a model server,
 * it's the same format.
 */
import * as z from "zod";

/** Where a model lives: its `/v1` base URL and, if it needs one, a key. */
export type ModelEndpoint = { baseUrl: string; apiKey?: string | null };

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type AssistantMessage = Extract<ChatMessage, { role: "assistant" }>;

export type ToolDef = {
  type: "function";
  function: { name: string; description?: string; parameters: Record<string, unknown> };
};

export type ModelEvent =
  | { type: "text"; delta: string }
  | { type: "done"; message: AssistantMessage; finishReason: string | null };

export type ModelRequest = {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  toolChoice?: "auto" | "required" | "none";
  maxTokens?: number;
};

export type CallOptions = { fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number };

/** A model endpoint said no, or couldn't be reached. `status` is absent when it couldn't be reached. */
export class ModelError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
  /** Worth trying another model: the endpoint is down or overloaded, not the request wrong. */
  get retryable(): boolean {
    return this.status === undefined || this.status === 429 || this.status >= 500;
  }
}

const base = (ep: ModelEndpoint) => ep.baseUrl.replace(/\/+$/, "");

function headers(ep: ModelEndpoint, extra: Record<string, string> = {}): Record<string, string> {
  return {
    accept: "application/json",
    ...(ep.apiKey ? { authorization: `Bearer ${ep.apiKey}` } : {}),
    ...extra,
  };
}

function signalOf(opts: CallOptions, defaultMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? defaultMs);
  return opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
}

/** The endpoint's own words for a failed call, without echoing anything we sent. */
async function failure(res: Response): Promise<ModelError> {
  const body = (await res.json().catch(() => null)) as {
    error?: { message?: unknown } | string;
  } | null;
  const said = typeof body?.error === "string" ? body.error : body?.error?.message;
  const detail = typeof said === "string" ? said.slice(0, 300) : res.statusText;
  return new ModelError(`the model endpoint answered ${res.status}: ${detail}`, res.status);
}

async function send(url: string, init: RequestInit, opts: CallOptions, defaultMs: number) {
  try {
    return await (opts.fetch ?? fetch)(url, {
      ...init,
      redirect: "error",
      signal: signalOf(opts, defaultMs),
    });
  } catch (err) {
    const e = err as Error;
    const why = e.name === "TimeoutError" ? "it took too long" : e.message;
    throw new ModelError(`couldn't reach the model endpoint (${why})`);
  }
}

const ModelList = z.object({ data: z.array(z.object({ id: z.string() })) });

/** The model ids the endpoint offers (`GET /models`). */
export async function listModels(ep: ModelEndpoint, opts: CallOptions = {}): Promise<string[]> {
  const res = await send(`${base(ep)}/models`, { headers: headers(ep) }, opts, 15_000);
  if (!res.ok) throw await failure(res);
  const parsed = ModelList.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new ModelError("the endpoint's model list isn't in the OpenAI format");
  return parsed.data.data.map((m) => m.id);
}

const Delta = z.object({
  choices: z
    .array(
      z.object({
        delta: z
          .object({
            content: z.string().nullish(),
            tool_calls: z
              .array(
                z.object({
                  index: z.number().int().nonnegative(),
                  id: z.string().nullish(),
                  function: z
                    .object({ name: z.string().nullish(), arguments: z.string().nullish() })
                    .nullish(),
                }),
              )
              .nullish(),
          })
          .nullish(),
        finish_reason: z.string().nullish(),
      }),
    )
    .default([]),
});

const Whole = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullish(),
          tool_calls: z
            .array(
              z.object({
                id: z.string(),
                function: z.object({ name: z.string(), arguments: z.string().nullish() }),
              }),
            )
            .nullish(),
        }),
        finish_reason: z.string().nullish(),
      }),
    )
    .min(1),
});

/** Gathers streamed text and tool-call pieces into one assistant message. */
class Assembler {
  text = "";
  finishReason: string | null = null;
  private calls = new Map<number, { id: string; name: string; args: string }>();

  add(chunk: z.infer<typeof Delta>): string {
    let delta = "";
    for (const choice of chunk.choices) {
      if (choice.delta?.content) delta += choice.delta.content;
      for (const tc of choice.delta?.tool_calls ?? []) {
        const c = this.calls.get(tc.index) ?? { id: "", name: "", args: "" };
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.name += tc.function.name;
        if (tc.function?.arguments) c.args += tc.function.arguments;
        this.calls.set(tc.index, c);
      }
      if (choice.finish_reason) this.finishReason = choice.finish_reason;
    }
    this.text += delta;
    return delta;
  }

  message(): AssistantMessage {
    const toolCalls = [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([i, c]) => ({
        id: c.id || `call_${i}`,
        type: "function" as const,
        function: { name: c.name, arguments: c.args || "{}" },
      }));
    return {
      role: "assistant",
      content: this.text || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    };
  }
}

/** Server-sent events: yields each `data:` payload until `[DONE]`. */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  let buffer = "";
  for await (const piece of body.pipeThrough(new TextDecoderStream())) {
    buffer += piece;
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      if (line.startsWith("data:")) {
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        if (data) yield data;
      }
      nl = buffer.indexOf("\n");
    }
  }
}

/**
 * One chat-completions call, streamed: text as it arrives, then the whole
 * assistant message (text and tool calls). An endpoint that ignores `stream`
 * and answers in one piece works too.
 */
export async function* streamChat(
  ep: ModelEndpoint,
  req: ModelRequest,
  opts: CallOptions = {},
): AsyncGenerator<ModelEvent> {
  const res = await send(
    `${base(ep)}/chat/completions`,
    {
      method: "POST",
      headers: headers(ep, { "content-type": "application/json", accept: "text/event-stream" }),
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        stream: true,
        ...(req.tools?.length ? { tools: req.tools, tool_choice: req.toolChoice ?? "auto" } : {}),
        ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
      }),
    },
    opts,
    180_000,
  );
  if (!res.ok) throw await failure(res);
  const a = new Assembler();
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("text/event-stream") || !res.body) {
    const whole = Whole.safeParse(await res.json().catch(() => null));
    if (!whole.success) throw new ModelError("the model's answer isn't in the OpenAI format");
    const choice = whole.data.choices[0];
    const m = choice?.message;
    const text = m?.content ?? "";
    if (text) yield { type: "text", delta: text };
    const calls = (m?.tool_calls ?? []).map((c) => ({
      id: c.id,
      type: "function" as const,
      function: { name: c.function.name, arguments: c.function.arguments || "{}" },
    }));
    yield {
      type: "done",
      message: {
        role: "assistant",
        content: text || null,
        ...(calls.length ? { tool_calls: calls } : {}),
      },
      finishReason: choice?.finish_reason ?? null,
    };
    return;
  }
  try {
    for await (const data of sseData(res.body)) {
      let json: unknown;
      try {
        json = JSON.parse(data);
      } catch {
        throw new ModelError("the model sent a piece of its answer that isn't JSON");
      }
      const said = (json as { error?: { message?: string } }).error;
      if (said)
        throw new ModelError(
          `the model stopped: ${String(said.message ?? "error").slice(0, 300)}`,
          500,
        );
      const chunk = Delta.safeParse(json);
      if (!chunk.success) continue;
      const delta = a.add(chunk.data);
      if (delta) yield { type: "text", delta };
    }
  } catch (err) {
    if (err instanceof ModelError) throw err;
    throw new ModelError(`the model's answer broke off (${(err as Error).message})`);
  }
  yield { type: "done", message: a.message(), finishReason: a.finishReason };
}

export type ProbeResult = {
  models: string[];
  /** Whether the chosen model called a tool when asked to: the built-in chat depends on it. */
  toolCall: { model: string; ok: boolean; detail: string; ms: number } | null;
};

const PING: ToolDef = {
  type: "function",
  function: {
    name: "ping",
    description: "Answers pong. Call it when asked to.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
};

/** The admin's Test button: list the models, then (for one of them) try a tool call. */
export async function probeEndpoint(
  ep: ModelEndpoint,
  model: string | null,
  opts: CallOptions = {},
): Promise<ProbeResult> {
  const models = await listModels(ep, opts);
  if (!model) return { models, toolCall: null };
  const started = Date.now();
  let done: Extract<ModelEvent, { type: "done" }> | undefined;
  try {
    for await (const e of streamChat(
      ep,
      {
        model,
        messages: [
          { role: "system", content: "You are testing a connection. Do what you're asked." },
          { role: "user", content: "Call the ping tool now." },
        ],
        tools: [PING],
        maxTokens: 1024,
      },
      { ...opts, timeoutMs: opts.timeoutMs ?? 90_000 },
    )) {
      if (e.type === "done") done = e;
    }
  } catch (err) {
    return {
      models,
      toolCall: { model, ok: false, detail: (err as Error).message, ms: Date.now() - started },
    };
  }
  const called = done?.message.tool_calls?.some((c) => c.function.name === "ping") ?? false;
  return {
    models,
    toolCall: {
      model,
      ok: called,
      detail: called
        ? "it called the tool"
        : "it answered without calling the tool, so the chat may not be able to read records",
      ms: Date.now() - started,
    },
  };
}
