/**
 * @wombatfish/opencode-toolcall-repair — OpenCode plugin.
 *
 * On load, ensures a tool-call repair proxy (proxy.ts) is running as a
 * SEPARATE detached process, then routes open models through it via the
 * `ollama-repair` provider so tool-call wire-format violations are fixed
 * before opencode's AI SDK validates them.
 *
 * Why a separate process and not in-process Bun.serve: opencode is the HTTP
 * client AND would be the server on one event loop — the streaming
 * chat/completions response deadlocks (verified). A detached daemon also
 * survives session churn and owns its own listen socket cleanly.
 *
 * Requires `bun` on PATH (opencode's own ecosystem dependency).
 *
 * Install (per workstation):
 *   1. opencode.json  →  "plugin": ["@wombatfish/opencode-toolcall-repair"]
 *   2. opencode.json  →  add the `ollama-repair` provider (see README),
 *      baseURL http://localhost:11435/v1, and route open models to it.
 *
 * Env: REPAIR_PROXY_PORT (default 11435), REPAIR_UPSTREAM (default
 * http://localhost:11434). Daemon log: <tmpdir>/opencode-toolcall-repair.log
 */

import type { Plugin } from "@opencode-ai/plugin";
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_DIR = dirname(fileURLToPath(import.meta.url)); // .../src
const PROXY = join(PKG_DIR, "proxy.ts");
const PORT = Number(process.env.REPAIR_PROXY_PORT ?? 11435);
const BUN = process.platform === "win32" ? "bun.exe" : "bun";

/** Is something already serving on the proxy port? (orphan guard — no double-spawn) */
async function proxyAlive(port: number): Promise<boolean> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 800);
    const res = await fetch(`http://localhost:${port}/v1/models`, { signal: ctl.signal });
    clearTimeout(timer);
    return res.status > 0; // any HTTP reply means a listener exists
  } catch {
    return false; // connection refused → not running
  }
}

function spawnDaemon(): void {
  let out: number;
  try {
    out = openSync(join(tmpdir(), "opencode-toolcall-repair.log"), "a");
  } catch {
    out = 1;
  }
  const child = spawn(BUN, ["run", PROXY], {
    detached: true,
    stdio: ["ignore", out, out],
    windowsHide: true,
    env: process.env,
  });
  child.on("error", (e) =>
    console.error(`[toolcall-repair] failed to spawn proxy ('${BUN}' on PATH?): ${e.message}`),
  );
  child.unref();
}

let booted = false;

const ToolCallRepairPlugin: Plugin = async () => {
  if (!booted) {
    booted = true;
    if (!(await proxyAlive(PORT))) spawnDaemon();
  }
  return {};
};

export default ToolCallRepairPlugin;
