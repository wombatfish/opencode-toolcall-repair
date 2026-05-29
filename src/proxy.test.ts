import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startProxy } from "./proxy.ts";

// ---- mock upstream (stands in for Ollama) --------------------------------
// Emits a deliberately malformed tool call: `paths` is sent as a bare string
// where the tool schema expects an array.

function sse(...chunks: unknown[]): string {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
}

const mock = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/v1/models") {
      return Response.json({ object: "list", data: [{ id: "deepseek-v4-pro:cloud" }] });
    }
    if (url.pathname === "/v1/chat/completions") {
      const body = await req.json();
      if (body.stream) {
        const stream = sse(
          { id: "1", model: "m", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
          { id: "1", model: "m", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "search", arguments: "" } }] }, finish_reason: null }] },
          { id: "1", model: "m", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"paths":' } }] }, finish_reason: null }] },
          { id: "1", model: "m", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"foo"}' } }] }, finish_reason: null }] },
          { id: "1", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        );
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({
        id: "1",
        choices: [{ message: { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "search", arguments: '{"paths":"foo"}' } }] } }],
      });
    }
    return new Response("not found", { status: 404 });
  },
});

let proxy: ReturnType<typeof startProxy>;
let base: string;

beforeAll(() => {
  proxy = startProxy({ port: 0, upstream: `http://localhost:${mock.port}` });
  base = `http://localhost:${proxy.port}`;
});

afterAll(() => {
  proxy.stop(true);
  mock.stop(true);
});

const reqBody = (stream: boolean) => ({
  model: "search",
  stream,
  tools: [
    {
      type: "function",
      function: { name: "search", parameters: { type: "object", properties: { paths: { type: "array" } } } },
    },
  ],
  messages: [{ role: "user", content: "go" }],
});

describe("repair proxy — end to end", () => {
  test("non-stream: bare string → array in tool_calls", async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reqBody(false)),
    });
    const body = await res.json();
    const args = JSON.parse(body.choices[0].message.tool_calls[0].function.arguments);
    expect(args).toEqual({ paths: ["foo"] });
  });

  test("stream: tool_call args repaired in SSE", async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reqBody(true)),
    });
    const text = await res.text();
    const payloads = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter((p) => p && p !== "[DONE]")
      .map((p) => JSON.parse(p));

    const toolCall = payloads
      .flatMap((p) => p.choices?.[0]?.delta?.tool_calls ?? [])
      .find((tc: { function?: { name?: string } }) => tc.function?.name === "search");

    expect(toolCall).toBeDefined();
    expect(JSON.parse(toolCall.function.arguments)).toEqual({ paths: ["foo"] });

    // finish chunk must not leak raw tool_calls
    const finish = payloads.find((p) => p.choices?.[0]?.finish_reason === "tool_calls");
    expect(finish.choices[0].delta).toEqual({});
  });

  test("passthrough: GET /v1/models", async () => {
    const res = await fetch(`${base}/v1/models`);
    const body = await res.json();
    expect(body.data[0].id).toBe("deepseek-v4-pro:cloud");
  });
});
