import { describe, expect, test } from "bun:test";
import {
  buildToolSchemaMap,
  repairArguments,
  repairArgString,
  repairNonStreamBody,
  SseToolCallRepairer,
  type JsonSchema,
  type ToolDef,
} from "./repair.ts";

const objSchema = (props: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: "object",
  properties: props,
  required,
});

describe("repairArguments — catalog", () => {
  test("drops null optional field", () => {
    const { args, repairs } = repairArguments(
      { file_path: "/src/main.py", encoding: null },
      objSchema({ file_path: { type: "string" }, encoding: { type: "string" } }, ["file_path"]),
    );
    expect(args).toEqual({ file_path: "/src/main.py" });
    expect(repairs).toEqual([{ field: "encoding", kind: "drop-null" }]);
  });

  test("keeps null on required field", () => {
    const { args, repairs } = repairArguments(
      { x: null },
      objSchema({ x: { type: "string" } }, ["x"]),
    );
    expect(args).toEqual({ x: null });
    expect(repairs).toEqual([]);
  });

  test("wraps bare string in array", () => {
    const { args } = repairArguments({ tags: "foo" }, objSchema({ tags: { type: "array" } }));
    expect(args).toEqual({ tags: ["foo"] });
  });

  test("unwraps string-encoded array", () => {
    const { args } = repairArguments({ tags: '["a","b"]' }, objSchema({ tags: { type: "array" } }));
    expect(args).toEqual({ tags: ["a", "b"] });
  });

  test("malformed string-encoded array falls back to single element", () => {
    const { args } = repairArguments({ tags: "[oops" }, objSchema({ tags: { type: "array" } }));
    expect(args).toEqual({ tags: ["[oops"] });
  });

  test("parses string-encoded object", () => {
    const { args } = repairArguments(
      { cfg: '{"k":"v"}' },
      objSchema({ cfg: { type: "object" } }),
    );
    expect(args).toEqual({ cfg: { k: "v" } });
  });

  test("leaves non-JSON string when object expected", () => {
    const { args } = repairArguments({ cfg: "not json" }, objSchema({ cfg: { type: "object" } }));
    expect(args).toEqual({ cfg: "not json" });
  });

  test("honors union type [array,null]", () => {
    const { args } = repairArguments({ tags: "x" }, objSchema({ tags: { type: ["array", "null"] } }));
    expect(args).toEqual({ tags: ["x"] });
  });

  test("does NOT wrap when string is also a valid type ([string,array])", () => {
    const { args, repairs } = repairArguments({ tags: "x" }, objSchema({ tags: { type: ["string", "array"] } }));
    expect(args).toEqual({ tags: "x" });
    expect(repairs).toEqual([]);
  });

  test("does NOT parse-object when string is also valid ([string,object])", () => {
    const { args, repairs } = repairArguments({ cfg: '{"k":"v"}' }, objSchema({ cfg: { type: ["string", "object"] } }));
    expect(args).toEqual({ cfg: '{"k":"v"}' });
    expect(repairs).toEqual([]);
  });

  test("ignores unknown properties", () => {
    const { args, repairs } = repairArguments({ extra: "y" }, objSchema({ known: { type: "string" } }));
    expect(args).toEqual({ extra: "y" });
    expect(repairs).toEqual([]);
  });

  test("idempotent on valid args", () => {
    const valid = { tags: ["a"], file: "x" };
    const { args, repairs } = repairArguments(
      { ...valid },
      objSchema({ tags: { type: "array" }, file: { type: "string" } }),
    );
    expect(args).toEqual(valid);
    expect(repairs).toEqual([]);
  });
});

describe("repairArgString", () => {
  test("returns original on parse failure", () => {
    const { out, repairs } = repairArgString("{bad json", objSchema({ a: { type: "array" } }));
    expect(out).toBe("{bad json");
    expect(repairs).toEqual([]);
  });

  test("repairs and re-stringifies", () => {
    const { out } = repairArgString('{"tags":"foo"}', objSchema({ tags: { type: "array" } }));
    expect(JSON.parse(out)).toEqual({ tags: ["foo"] });
  });

  test("unchanged string when no repairs", () => {
    const s = '{"tags":["foo"]}';
    expect(repairArgString(s, objSchema({ tags: { type: "array" } })).out).toBe(s);
  });
});

describe("buildToolSchemaMap", () => {
  test("maps function name to parameters", () => {
    const tools: ToolDef[] = [
      { type: "function", function: { name: "search", parameters: objSchema({ q: { type: "string" } }) } },
    ];
    expect(buildToolSchemaMap(tools).search).toEqual(objSchema({ q: { type: "string" } }));
  });

  test("handles undefined", () => {
    expect(buildToolSchemaMap(undefined)).toEqual({});
  });
});

describe("repairNonStreamBody", () => {
  test("repairs tool_calls arguments in a full response", () => {
    const tools = buildToolSchemaMap([
      { type: "function", function: { name: "search", parameters: objSchema({ paths: { type: "array" } }) } },
    ]);
    const body = {
      choices: [
        { message: { tool_calls: [{ function: { name: "search", arguments: '{"paths":"foo"}' } }] } },
      ],
    };
    repairNonStreamBody(body, tools);
    expect(JSON.parse(body.choices[0].message.tool_calls[0].function.arguments)).toEqual({ paths: ["foo"] });
  });
});

describe("SseToolCallRepairer — streaming", () => {
  const tools = buildToolSchemaMap([
    { type: "function", function: { name: "search", parameters: objSchema({ paths: { type: "array" } }) } },
  ]);

  test("prose chunks pass through verbatim", () => {
    const r = new SseToolCallRepairer(tools);
    const raw = '{"choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}';
    expect(r.push(raw)).toEqual([raw]);
  });

  test("non-JSON payload passes through", () => {
    const r = new SseToolCallRepairer(tools);
    expect(r.push("garbage")).toEqual(["garbage"]);
  });

  test("buffers fragments, repairs at finish, strips raw tool_calls from finish chunk", () => {
    const r = new SseToolCallRepairer(tools);
    // role chunk
    expect(r.push('{"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}').length).toBe(1);
    // tool-call opening + fragments (buffered, emit nothing)
    expect(r.push('{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"search","arguments":""}}]},"finish_reason":null}]}')).toEqual([]);
    expect(r.push('{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"paths\\":"}}]},"finish_reason":null}]}')).toEqual([]);
    expect(r.push('{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"foo\\"}"}}]},"finish_reason":null}]}')).toEqual([]);
    // finish chunk → flush: [repaired, finish]
    const out = r.push('{"id":"x","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}');
    expect(out.length).toBe(2);

    const repaired = JSON.parse(out[0]);
    const tc = repaired.choices[0].delta.tool_calls[0];
    expect(tc.id).toBe("call_1");
    expect(tc.function.name).toBe("search");
    expect(JSON.parse(tc.function.arguments)).toEqual({ paths: ["foo"] });
    expect(repaired.choices[0].finish_reason).toBeNull();

    const finish = JSON.parse(out[1]);
    expect(finish.choices[0].finish_reason).toBe("tool_calls");
    expect(finish.choices[0].delta).toEqual({});
  });

  test("handles two parallel tool calls", () => {
    const r = new SseToolCallRepairer(tools);
    r.push('{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"search","arguments":"{\\"paths\\":\\"x\\"}"}}]},"finish_reason":null}]}');
    r.push('{"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"b","function":{"name":"search","arguments":"{\\"paths\\":\\"y\\"}"}}]},"finish_reason":null}]}');
    const out = r.push('{"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}');
    const calls = JSON.parse(out[0]).choices[0].delta.tool_calls;
    expect(calls.length).toBe(2);
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ paths: ["x"] });
    expect(JSON.parse(calls[1].function.arguments)).toEqual({ paths: ["y"] });
  });

  test("flush emits buffered calls when stream ends without finish_reason", () => {
    const r = new SseToolCallRepairer(tools);
    r.push('{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"search","arguments":"{\\"paths\\":\\"z\\"}"}}]},"finish_reason":null}]}');
    const out = r.flush();
    expect(out.length).toBe(1);
    expect(JSON.parse(JSON.parse(out[0]).choices[0].delta.tool_calls[0].function.arguments)).toEqual({ paths: ["z"] });
  });
});
