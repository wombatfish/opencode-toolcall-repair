/**
 * Tool-call wire-format repair core. Pure, no I/O.
 *
 * Repairs the finite catalog of arg-shape violations open models emit
 * (DeepSeek/Qwen/GLM/Kimi/MiniMax/Granite), measured against the tool's
 * JSON schema from the request `tools[]`:
 *
 *   1. Drop null optionals      — null on a non-required field → omit
 *   2. Bare string  → array     — "foo" / "[\"a\",\"b\"]" where schema wants array
 *   3. String-encoded → object  — '{"k":"v"}' where schema wants object
 *
 * Tool-NAME case is deliberately NOT repaired here — opencode already does
 * that in `experimental_repairToolCall` (session/llm.ts).
 */

export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
}

/** OpenAI tool definition as sent in a chat/completions request. */
export interface ToolDef {
  type?: string;
  function?: { name?: string; parameters?: JsonSchema };
}

export type ToolSchemaMap = Record<string, JsonSchema>;

/** Build name → parameters-schema map from a request body's `tools[]`. */
export function buildToolSchemaMap(tools: ToolDef[] | undefined): ToolSchemaMap {
  const map: ToolSchemaMap = {};
  if (!Array.isArray(tools)) return map;
  for (const t of tools) {
    const name = t?.function?.name;
    if (name) map[name] = t.function?.parameters ?? {};
  }
  return map;
}

function typeAccepts(type: string | string[] | undefined, want: string): boolean {
  return type === want || (Array.isArray(type) && type.includes(want));
}

export interface RepairLog {
  field: string;
  kind: "drop-null" | "wrap-array" | "parse-object";
}

/**
 * Repair an arguments object in place against a parameters schema.
 * Returns the (same) object plus a list of repairs applied (for logging).
 * Shallow by design — mirrors the article's finite catalog.
 */
export function repairArguments(
  args: Record<string, unknown>,
  schema: JsonSchema | undefined,
): { args: Record<string, unknown>; repairs: RepairLog[] } {
  const repairs: RepairLog[] = [];
  if (!schema || typeof args !== "object" || args === null) return { args, repairs };

  const props = schema.properties ?? {};
  const required = schema.required ?? [];

  for (const key of Object.keys(args)) {
    const pschema = props[key];
    if (!pschema) continue; // unknown prop — never touch
    const type = pschema.type;
    const value = args[key];

    // 1. Drop null optionals
    if (value === null && !required.includes(key)) {
      delete args[key];
      repairs.push({ field: key, kind: "drop-null" });
      continue;
    }

    // 2. Bare / string-wrapped → array
    if (typeAccepts(type, "array") && typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.startsWith("[")) {
        try {
          const parsed = JSON.parse(trimmed);
          args[key] = Array.isArray(parsed) ? parsed : [value];
        } catch {
          args[key] = [value];
        }
      } else {
        args[key] = [value];
      }
      repairs.push({ field: key, kind: "wrap-array" });
      continue;
    }

    // 3. String-encoded → object
    if (typeAccepts(type, "object") && typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          args[key] = parsed;
          repairs.push({ field: key, kind: "parse-object" });
        }
      } catch {
        /* not JSON — leave the string */
      }
    }
  }

  return { args, repairs };
}

/**
 * Repair a tool-call's stringified `function.arguments` against its schema.
 * Returns the repaired JSON string (or the original on parse failure) plus repairs.
 */
export function repairArgString(
  argsStr: string,
  schema: JsonSchema | undefined,
): { out: string; repairs: RepairLog[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsStr || "{}");
  } catch {
    return { out: argsStr, repairs: [] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { out: argsStr, repairs: [] };
  }
  const { args, repairs } = repairArguments(parsed as Record<string, unknown>, schema);
  if (repairs.length === 0) return { out: argsStr, repairs };
  return { out: JSON.stringify(args), repairs };
}

// ---------------------------------------------------------------------------
// Non-streaming response repair
// ---------------------------------------------------------------------------

interface ChatToolCall {
  function?: { name?: string; arguments?: string };
}
interface ChatChoice {
  message?: { tool_calls?: ChatToolCall[] };
}
interface ChatBody {
  choices?: ChatChoice[];
}

/** Repair `choices[].message.tool_calls[].function.arguments` in a full JSON body. */
export function repairNonStreamBody(
  body: ChatBody,
  tools: ToolSchemaMap,
  onRepair?: (name: string, r: RepairLog[]) => void,
): ChatBody {
  for (const choice of body.choices ?? []) {
    for (const tc of choice.message?.tool_calls ?? []) {
      const name = tc.function?.name;
      if (!name || tc.function?.arguments == null) continue;
      const { out, repairs } = repairArgString(tc.function.arguments, tools[name]);
      if (repairs.length) {
        tc.function.arguments = out;
        onRepair?.(name, repairs);
      }
    }
  }
  return body;
}

// ---------------------------------------------------------------------------
// Streaming response repair
// ---------------------------------------------------------------------------

interface StreamToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}
interface StreamChoice {
  index?: number;
  delta?: { content?: string | null; tool_calls?: StreamToolCallDelta[] };
  finish_reason?: string | null;
}
interface StreamChunk {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: StreamChoice[];
}

interface BufferedCall {
  id?: string;
  name?: string;
  args: string;
}

/**
 * Stateful SSE tool-call repairer (chosen strategy: buffer tool-calls, stream prose).
 *
 * Prose `delta.content` chunks pass through verbatim. Tool-call fragments are
 * accumulated per `index`; at `finish_reason` the assembled args are repaired
 * against the schema and emitted as a single complete tool-call chunk, followed
 * by the finish chunk (with tool_calls stripped so the raw fragments don't leak).
 *
 * `push`/`flush` take + return JSON strings (one SSE `data:` payload each) so
 * the unit tests need no HTTP server.
 */
export class SseToolCallRepairer {
  private state = new Map<number, BufferedCall>();
  constructor(
    private readonly tools: ToolSchemaMap,
    private readonly onRepair?: (name: string, r: RepairLog[]) => void,
  ) {}

  /** Feed one SSE data payload (the raw JSON string after `data: `). */
  push(raw: string): string[] {
    let obj: StreamChunk;
    try {
      obj = JSON.parse(raw);
    } catch {
      return [raw]; // non-JSON payload — passthrough
    }

    const choice = obj.choices?.[0];
    const delta = choice?.delta;
    const hasToolCalls = Array.isArray(delta?.tool_calls);
    const finish = choice?.finish_reason ?? null;

    if (hasToolCalls) this.accumulate(delta!.tool_calls!);

    if (finish != null && this.state.size > 0) {
      const out = [this.repairedChunk(obj), this.finishChunk(obj, choice!)];
      this.state.clear();
      return out;
    }

    if (hasToolCalls) return []; // buffered, nothing to emit yet

    return [raw]; // pure prose / role / finish-without-tools → verbatim
  }

  /** Emit any tool-calls still buffered if the stream ended without finish_reason. */
  flush(): string[] {
    if (this.state.size === 0) return [];
    const synthetic: StreamChunk = { object: "chat.completion.chunk" };
    const out = [this.repairedChunk(synthetic)];
    this.state.clear();
    return out;
  }

  private accumulate(deltas: StreamToolCallDelta[]): void {
    for (const tc of deltas) {
      const idx = tc.index ?? 0;
      const entry = this.state.get(idx) ?? { args: "" };
      if (tc.id) entry.id = tc.id;
      if (tc.function?.name) entry.name = tc.function.name;
      if (tc.function?.arguments) entry.args += tc.function.arguments;
      this.state.set(idx, entry);
    }
  }

  private repairedChunk(env: StreamChunk): string {
    const tool_calls = [...this.state.entries()].map(([idx, c]) => {
      const { out, repairs } = repairArgString(c.args, c.name ? this.tools[c.name] : undefined);
      if (repairs.length && c.name) this.onRepair?.(c.name, repairs);
      return { index: idx, id: c.id, type: "function", function: { name: c.name, arguments: out } };
    });
    const chunk: StreamChunk = {
      id: env.id,
      object: env.object ?? "chat.completion.chunk",
      created: env.created,
      model: env.model,
      choices: [{ index: 0, delta: { tool_calls }, finish_reason: null }],
    };
    return JSON.stringify(chunk);
  }

  private finishChunk(obj: StreamChunk, choice: StreamChoice): string {
    return JSON.stringify({ ...obj, choices: [{ ...choice, delta: {} }] });
  }
}
