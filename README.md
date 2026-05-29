# @wombatfish/opencode-toolcall-repair

OpenCode plugin that fixes the finite set of **tool-call wire-format violations** open models emit (DeepSeek, Qwen, GLM, Kimi, MiniMax, Granite…) — the "harness gap," not a model gap.

The model's reasoning is fine; it just gets the wire shape wrong: sends `null` for an optional field instead of omitting it, a bare `"foo"` where the schema wants `["foo"]`, or a stringified `'{"k":"v"}'` where it wants an object. OpenCode's AI SDK Zod-validates tool args and **rejects** these before they execute, so the call dies (routed to opencode's `invalid` tool).

This plugin runs a tiny in-process OpenAI-compatible proxy that repairs those args **before** opencode validates them.

```
opencode → http://localhost:11435/v1 (this proxy) → http://localhost:11434 (Ollama)
                         │ per request: read tools[] JSON schemas
                         │ per response: repair tool_calls[].function.arguments
```

## What it repairs

Schema-driven, from the request's `tools[].function.parameters`:

| # | Violation | Fix |
|---|-----------|-----|
| 1 | `null` on a non-required field | omit the field |
| 2 | bare string / `"[\"a\",\"b\"]"` where schema wants `array` | `["..."]` / parsed array |
| 3 | `'{"k":"v"}'` where schema wants `object` | parsed object |

Tool-**name** case is **not** repaired here — opencode already does that in `experimental_repairToolCall`.

**Out of scope** (reasoning failures no format fix can solve): wrong tool, wrong order, hallucinated parameter, context-boundary loss.

## Install (per workstation)

1. Add the plugin to `opencode.json`:

   ```json
   { "plugin": ["@wombatfish/opencode-toolcall-repair"] }
   ```

   OpenCode auto-installs it (Bun). For local dev before publishing, point at the source:
   `"plugin": ["file:///D:/Projects/opencode-toolcall-repair"]`.

2. Add a provider that routes through the proxy, and point your open models at it:

   ```json
   {
     "provider": {
       "ollama-repair": {
         "npm": "@ai-sdk/openai-compatible",
         "name": "Ollama (repaired)",
         "options": { "baseURL": "http://localhost:11435/v1" },
         "models": {
           "deepseek-v4-pro:cloud": { "name": "DeepSeek V4 Pro (repaired)" }
         }
       }
     }
   }
   ```

That's it. Select a model under **Ollama (repaired)**; keep the direct Ollama provider alongside for A/B.

## How it runs

The plugin spawns the proxy as a **separate detached `bun` process** on load (port-probe first, so a second opencode session reuses the running daemon instead of double-spawning). It must be a separate process, not in-process: opencode is the HTTP client, and an in-process `Bun.serve` makes it the server too — the streaming chat/completions response deadlocks on the shared event loop (verified). A separate daemon also owns its listen socket cleanly.

Requires **`bun` on PATH** (opencode's own ecosystem dependency). Daemon log: `<tmpdir>/opencode-toolcall-repair.log`.

Because it speaks the stable OpenAI HTTP wire format, the package has **no `ai`/AI-SDK version coupling** — it survives opencode upgrades.

### Config (env)

| Var | Default | Meaning |
|-----|---------|---------|
| `REPAIR_PROXY_PORT` | `11435` | proxy listen port (must match the provider `baseURL`) |
| `REPAIR_UPSTREAM` | `http://localhost:11434` | upstream origin (Ollama) |

## Develop

```sh
bun install
bun test                 # unit (repair core + SSE) + integration (proxy vs mock upstream)
bun run start            # run the proxy standalone
```

## Publish

Tag `vX.Y.Z` → GitHub Actions publishes to npm via **trusted publishing (OIDC)**. Configure the trusted publisher for this package on npmjs.com first (no long-lived token).

## License

MIT
