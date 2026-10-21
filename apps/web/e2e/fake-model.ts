/**
 * A scripted OpenAI-compatible model for the end-to-end tests (S8), so
 * nothing depends on a real model. It picks a tool from words in the person's
 * question, then answers with exactly what aipass sent back. It keeps every
 * request, so a test can check what a model is ever shown.
 *
 *   GET  /v1/models            fake-model (calls tools), fake-no-tools (never does)
 *   POST /v1/chat/completions  streamed (SSE) or not
 *   GET  /requests             every chat request body so far
 */
import { createServer } from "node:http";
import { E2E } from "./env.ts";

type Msg = { role: string; content?: string | null };
type Body = {
  model: string;
  messages: Msg[];
  stream?: boolean;
  tools?: { function: { name: string } }[];
};

const seen: Body[] = [];

const ROUTES: [RegExp, string, Record<string, unknown>][] = [
  [/a1c/i, "search_labs", { code: "4548-4" }],
  [/medication/i, "list_medications", {}],
  [/vital/i, "search_vitals", {}],
  [/note/i, "get_notes", {}],
];

function decide(b: Body): {
  text?: string;
  tool?: { name: string; args: Record<string, unknown> };
} {
  const tools = new Set((b.tools ?? []).map((t) => t.function.name));
  if (tools.has("ping")) {
    return b.model === "fake-no-tools" ? { text: "pong" } : { tool: { name: "ping", args: {} } };
  }
  const last = b.messages.at(-1);
  if (last?.role === "tool") return { text: `Here's what aipass gave me: ${last.content ?? ""}` };
  const q = last?.content ?? "";
  for (const [words, name, args] of ROUTES) {
    if (words.test(q)) {
      return tools.has(name) ? { tool: { name, args } } : { text: "I can't look that up." };
    }
  }
  return { text: "Hello! Ask me about your record." };
}

createServer((req, res) => {
  if (req.method === "GET" && req.url === "/v1/models") {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({ object: "list", data: [{ id: "fake-model" }, { id: "fake-no-tools" }] }),
    );
    return;
  }
  if (req.method === "GET" && req.url === "/requests") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(seen));
    return;
  }
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    res.statusCode = 404;
    res.end();
    return;
  }
  let raw = "";
  req.on("data", (c) => {
    raw += c;
  });
  req.on("end", () => {
    const body = JSON.parse(raw) as Body;
    seen.push(body);
    const d = decide(body);
    const call = d.tool
      ? [
          {
            index: 0,
            id: `call_${seen.length}`,
            type: "function",
            function: { name: d.tool.name, arguments: JSON.stringify(d.tool.args) },
          },
        ]
      : undefined;
    const finish = call ? "tool_calls" : "stop";
    if (!body.stream) {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: d.text ?? null, tool_calls: call },
              finish_reason: finish,
            },
          ],
        }),
      );
      return;
    }
    res.setHeader("content-type", "text/event-stream");
    const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (d.text) {
      // In two pieces, so streaming is exercised.
      const half = Math.ceil(d.text.length / 2);
      send({
        choices: [{ index: 0, delta: { role: "assistant", content: d.text.slice(0, half) } }],
      });
      send({ choices: [{ index: 0, delta: { content: d.text.slice(half) } }] });
    }
    if (call) send({ choices: [{ index: 0, delta: { tool_calls: call } }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: finish }] });
    res.end("data: [DONE]\n\n");
  });
}).listen(Number(new URL(E2E.model).port), "127.0.0.1", () => {
  console.info(`fake model on ${E2E.model}/v1`);
});
