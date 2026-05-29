/**
 * @wombatfish/opencode-toolcall-repair — OpenCode plugin.
 *
 * Boots an in-process HTTP repair proxy (see proxy.ts) on plugin load. Open
 * models routed through opencode's `ollama-repair` provider hit the proxy, which
 * fixes tool-call wire-format violations before opencode's AI SDK validates them.
 *
 * The proxy runs inside opencode's own Bun runtime — no child process, no PATH
 * dependency, lifetime tied to opencode (which is the only consumer). A second
 * opencode instance gets EADDRINUSE and reuses the first instance's proxy.
 *
 * Install (per workstation):
 *   1. opencode.json  →  "plugin": ["@wombatfish/opencode-toolcall-repair"]
 *   2. opencode.json  →  add the `ollama-repair` provider (see README), pointed
 *      at http://localhost:11435/v1, and route open models to it.
 */

import type { Plugin } from "@opencode-ai/plugin";
import { startProxy } from "./proxy.ts";

let started = false;

const ToolCallRepairPlugin: Plugin = async () => {
  if (!started) {
    started = true;
    try {
      startProxy();
    } catch (e: unknown) {
      const msg = String((e as { message?: string })?.message ?? e);
      const code = (e as { code?: string })?.code;
      // Port already bound → another opencode instance is serving the proxy.
      if (code !== "EADDRINUSE" && !msg.includes("EADDRINUSE") && !msg.includes("in use")) {
        console.error(`[toolcall-repair] proxy failed to start: ${msg}`);
      }
    }
  }
  return {};
};

export default ToolCallRepairPlugin;
