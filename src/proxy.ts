/**
 * Tool-call repair proxy. OpenAI /v1-compatible reverse proxy that sits in
 * front of Ollama (or any OpenAI-compatible upstream) and repairs malformed
 * tool-call arguments on the response before opencode's AI SDK validates them.
 *
 *   opencode → http://localhost:PORT/v1/... → this proxy → UPSTREAM/v1/...
 *
 * Only POST /v1/chat/completions is inspected; everything else is a transparent
 * passthrough (so /v1/models discovery etc. just work).
 *
 * Config (env):
 *   REPAIR_PROXY_PORT   listen port            (default 11435)
 *   REPAIR_UPSTREAM     upstream origin        (default http://localhost:11434)
 */

import {
  buildToolSchemaMap,
  repairNonStreamBody,
  SseToolCallRepairer,
  type RepairLog,
  type ToolDef,
} from "./repair.ts";

function log(msg: string): void {
  console.error(`[toolcall-repair ${new Date().toISOString()}] ${msg}`);
}

const onRepair = (name: string, repairs: RepairLog[]): void => {
  for (const r of repairs) log(`repaired ${name}.${r.field} (${r.kind})`);
};

/** Forward request headers to upstream, dropping hop-by-hop / host headers. */
function forwardHeaders(req: Request): Headers {
  const h = new Headers(req.headers);
  h.delete("host");
  h.delete("content-length");
  h.delete("accept-encoding"); // let upstream send identity; we re-stream
  return h;
}

function upstreamUrl(req: Request, upstream: string): string {
  const url = new URL(req.url);
  return upstream + url.pathname + url.search;
}

/** Transparent passthrough for anything we don't repair. */
async function passthrough(req: Request, upstream: string): Promise<Response> {
  const init: RequestInit = {
    method: req.method,
    headers: forwardHeaders(req),
    body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
  };
  const res = await fetch(upstreamUrl(req, upstream), init);
  return new Response(res.body, { status: res.status, headers: res.headers });
}

/** Repair path: POST /v1/chat/completions. */
async function handleChat(req: Request, upstream: string): Promise<Response> {
  const rawBody = await req.text();

  let tools: ToolDef[] | undefined;
  try {
    tools = JSON.parse(rawBody)?.tools;
  } catch {
    /* malformed request body — forward as-is, repair nothing */
  }
  const toolMap = buildToolSchemaMap(tools);
  if (process.env.REPAIR_DEBUG) log(`chat request: ${Object.keys(toolMap).length} tool schema(s)`);

  const res = await fetch(upstreamUrl(req, upstream), {
    method: "POST",
    headers: forwardHeaders(req),
    body: rawBody,
  });

  // Errors / no tools → nothing to repair, stream straight back.
  if (!res.ok || Object.keys(toolMap).length === 0) {
    return new Response(res.body, { status: res.status, headers: res.headers });
  }

  const ctype = res.headers.get("content-type") ?? "";

  if (ctype.includes("text/event-stream")) {
    return new Response(repairSse(res.body!, toolMap), {
      status: res.status,
      headers: res.headers,
    });
  }

  if (ctype.includes("application/json")) {
    const body = await res.json();
    const repaired = repairNonStreamBody(body, toolMap, onRepair);
    return new Response(JSON.stringify(repaired), {
      status: res.status,
      headers: stripContentLength(res.headers),
    });
  }

  return new Response(res.body, { status: res.status, headers: res.headers });
}

function stripContentLength(h: Headers): Headers {
  const out = new Headers(h);
  out.delete("content-length"); // body length changed
  return out;
}

/** Wrap an upstream SSE byte stream with the tool-call repairer. */
function repairSse(upstream: ReadableStream<Uint8Array>, toolMap: ReturnType<typeof buildToolSchemaMap>): ReadableStream<Uint8Array> {
  const repairer = new SseToolCallRepairer(toolMap, onRepair);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const reader = upstream.getReader();
  let buf = "";

  const emit = (controller: ReadableStreamDefaultController<Uint8Array>, payload: string) =>
    controller.enqueue(encoder.encode(`data: ${payload}\n\n`));

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        // process any trailing buffered line, then flush + terminate
        const tail = buf.trim();
        if (tail.startsWith("data:")) handleData(controller, tail.slice(5).trim());
        for (const o of repairer.flush()) emit(controller, o);
        controller.close();
        return;
      }
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? ""; // keep partial last line
      for (const line of lines) {
        const t = line.trim();
        if (t === "") continue;
        if (!t.startsWith("data:")) continue; // drop comments/keepalives
        handleData(controller, t.slice(5).trim());
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
    },
  });

  function handleData(controller: ReadableStreamDefaultController<Uint8Array>, payload: string) {
    if (payload === "[DONE]") {
      for (const o of repairer.flush()) emit(controller, o);
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      return;
    }
    for (const o of repairer.push(payload)) emit(controller, o);
  }
}

/**
 * Start the repair proxy. Throws synchronously on EADDRINUSE (Bun.serve binds
 * eagerly) — callers running in-process should catch it: a port already in use
 * means another opencode instance is already serving the proxy.
 */
export function startProxy(opts: { port?: number; upstream?: string } = {}): ReturnType<typeof Bun.serve> {
  const port = opts.port ?? Number(process.env.REPAIR_PROXY_PORT ?? 11435);
  const upstream = (opts.upstream ?? process.env.REPAIR_UPSTREAM ?? "http://localhost:11434").replace(/\/+$/, "");

  const server = Bun.serve({
    port,
    idleTimeout: 0, // long-lived streaming responses
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
        try {
          return await handleChat(req, upstream);
        } catch (e) {
          log(`chat handler error: ${(e as Error).message}`);
          return new Response(JSON.stringify({ error: "repair-proxy: " + (e as Error).message }), {
            status: 502,
            headers: { "content-type": "application/json" },
          });
        }
      }
      return passthrough(req, upstream);
    },
  });
  log(`listening on http://localhost:${server.port}  →  upstream ${upstream}`);
  return server;
}

// Standalone mode: `bun run src/proxy.ts`
if (import.meta.main) startProxy();
