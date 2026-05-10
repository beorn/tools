/**
 * Tribe hook dispatch — thin wrapper around recall's hook handlers.
 *
 * `tribe hook <event>` is the unified entry point for Claude Code hooks.
 * It replaces the scattered `recall session-start` / `recall session-end` /
 * `recall hook` commands while calling through to the same functions so that
 * behavior (sentinel files, daemon registration, incremental indexing, delta
 * injection) is preserved byte-for-byte.
 *
 * Events:
 *   session-start — SessionStart hook (reads stdin JSON: session_id, cwd, ...)
 *   prompt        — UserPromptSubmit hook (reads stdin JSON: prompt, ...)
 *   session-end   — SessionEnd hook
 *   pre-compact   — PreCompact hook (currently a no-op passthrough to cmdHook)
 *
 * These handlers control the Claude Code hook protocol (exit codes, stdout
 * JSON). We must not swallow errors or rewrite output — just dispatch.
 *
 * Before forwarding, we consult the autostart config and (if configured)
 * ensure the unified tribe daemon is running. The spawn is detached +
 * unref'd so it never blocks the hook; the overall 300 ms budget guarantees
 * Claude Code never waits on us.
 *
 * km-bear.unified-daemon Phase 5d: collapsed from two parallel probes
 * (lore + tribe) to one — the unified daemon hosts both surfaces.
 */

import { setSuppressConsole } from "loggily"
import { cmdSessionStart, cmdSessionEnd, cmdHook } from "../../../plugins/recall/src/lib/hooks.ts"
import { emitInjectionDebugEvent, installInjectionFileWriter } from "../../../plugins/injection-envelope/src/debug.ts"
import { ensureTribeDaemonIfConfigured } from "./autostart.ts"
import { homedir } from "node:os"
import { join } from "node:path"

export type HookEvent = "session-start" | "prompt" | "session-end" | "pre-compact"

/**
 * One-shot, idempotent muzzle of console output for the hook process.
 *
 * Why: when a Claude Code hook writes anything to stdout/stderr, the
 * harness captures that text and surfaces it to the model in the next
 * turn as `<system-reminder>UserPromptSubmit hook success: <captured></system-reminder>`.
 * Transcript-shaped captured text inside that envelope has triggered the
 * assistant's autocatalytic role-prefix hallucination
 * (`Human: <system-reminder>…`). Upstream issue:
 * https://github.com/anthropics/claude-code/issues/50972.
 *
 * Mitigation — two layers, both idempotent and routed through loggily:
 *
 *   1. `setSuppressConsole(true)` silences loggily's default console
 *      sink while leaving `addWriter({ ns: "injection:*" }, …)` and
 *      explicit pipeline writers untouched.
 *   2. `installInjectionFileWriter(path)` routes injection:* events to
 *      a per-user JSONL so observability is preserved without going
 *      anywhere Claude Code can read.
 *
 * Discipline contract: every other module in the hook code path
 * (`@bearly/recall`, `tribe/autostart`, `tribe/rpc`, …) MUST use a
 * loggily logger for diagnostic output, never raw `console.error` or
 * `process.stderr.write`. Layer 1 only catches loggily-routed traffic;
 * stragglers leak. The only sanctioned `console.log` call in this code
 * path is the hook's JSON response written by `cmdHook` /
 * `cmdSessionStart` / `cmdSessionEnd`. If you find a raw `console.*` in
 * a hook code path, route it through loggily — don't intercept here.
 */
let _muzzled = false
function muzzleHookProcess(): void {
  if (_muzzled) return
  _muzzled = true

  // Layer 1 — silence loggily's default console sink.
  setSuppressConsole(true)

  // Layer 2 — route `injection:*` events to a per-user JSONL.
  const path =
    process.env.INJECTION_DEBUG_LOG ??
    process.env.LOGGILY_FILE ??
    join(homedir(), ".local", "share", "bearly", "injection.jsonl")
  try {
    installInjectionFileWriter(path)
  } catch (err) {
    // The injection-envelope debug recorder owns its own /tmp fallback;
    // record the error there for later forensics. Never write to
    // stderr/stdout — that's the bug we're fixing.
    emitInjectionDebugEvent({
      source: "hook-dispatch",
      action: "error",
      reason: "installInjectionFileWriter_failed",
      errorMessage: err instanceof Error ? err.message : String(err),
    })
  }
}

export async function dispatchHook(event: HookEvent): Promise<void> {
  // Muzzle BEFORE anything else — autostart, recall handlers, daemon
  // RPCs, plugin loading all use loggily and would otherwise leak text
  // into the hook's stdout/stderr. See muzzleHookProcess docstring.
  muzzleHookProcess()

  // Fire-and-check autostart before the real handler runs. Errors are
  // swallowed internally — hooks must never crash here.
  try {
    await ensureTribeDaemonIfConfigured()
  } catch {
    /* never block the hook on autostart failure */
  }

  switch (event) {
    case "session-start":
      await cmdSessionStart()
      return
    case "session-end":
      await cmdSessionEnd()
      return
    case "prompt":
    case "pre-compact":
      // Both feed stdin JSON to the UserPromptSubmit-style handler. cmdHook
      // reads `hook_event_name` from stdin and routes accordingly.
      await cmdHook()
      return
  }
}
