/**
 * Observability for envelope emission, routed through loggily.
 *
 * Every hook decision (emit / skip / empty / error) flows into the
 * `injection:*` namespace tree:
 * - `injection:wrap`  — successful framed-envelope emission (action="emit")
 * - `injection:skip`  — caller decided not to inject (action="skip" / "empty" / "error")
 *
 * Output discipline — file only, never stderr:
 *
 *   The loggers are constructed with an empty config array (`[]`), which
 *   strips the default `console` sink. This is load-bearing: when a
 *   UserPromptSubmit hook writes anything to stderr, Claude Code captures
 *   that text and surfaces it to the model in the next turn as
 *
 *       <system-reminder>UserPromptSubmit hook success: <stderr></system-reminder>
 *
 *   A transcript-shaped stderr line (loggily's default `HH:MM:SS LEVEL ns
 *   ...` format qualifies) inside that envelope has triggered the
 *   autocatalytic role-prefix hallucination — the model emits
 *   `Human: <system-reminder>...` as a transcript continuation. See
 *   - upstream issue: https://github.com/anthropics/claude-code/issues/50972
 *   - km feedback memory: feedback-autocatalytic-hallucination.md
 *   - 85 violations recorded in 9h on 2026-05-09 motivating this fix.
 *
 *   Therefore: this module never writes to `process.stderr` or
 *   `process.stdout`, even on the error path. All emissions go to a JSONL
 *   file. If the file-writer install fails, we try a /tmp fallback; if
 *   that fails too we drop silently — the cure (echoing into the prompt)
 *   is worse than the disease (a missed debug line).
 *
 * Default output location: `~/.local/share/bearly/injection.jsonl`. Override
 * via `INJECTION_DEBUG_LOG=/path` or the unified `LOGGILY_FILE`. Browse via
 * `tail -f` or the (planned) `bearly inject status` CLI.
 *
 * Provenance:
 *
 *   Every record carries `producer` (=`@bearly/injection-envelope`), `pid`,
 *   and `hookEvent` so a reader can attribute at a glance without
 *   code archaeology. The package name lives in `_PRODUCER_ID` below.
 */

import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { addWriter, createFileWriter, createLogger, type Event } from "loggily"

/** Self-identifying provenance tag stamped on every JSONL record. */
const _PRODUCER_ID = "@bearly/injection-envelope"

export interface InjectionDebugEvent {
  /** Upstream emitter identity — which logical source produced this (recall, tribe, telegram, …). */
  source: string
  /** Claude Code session id, if available. */
  sessionId?: string
  /** What decision did the emitter make. */
  action: "emit" | "skip" | "empty" | "error"
  /**
   * Which Claude Code hook event triggered this emission, if known
   * (UserPromptSubmit / PreToolUse / SessionStart / …). Helps attribute
   * a record to the hook that fired it without inferring from context.
   */
  hookEvent?: string
  /** First ~200 chars of the triggering user prompt, for correlation. */
  prompt?: string
  /** Why skipped / why empty / what failed — free-form string. */
  reason?: string
  /** Number of items (snippets/pointers) in the envelope. */
  itemCount?: number
  /** Total chars of the emitted additionalContext. */
  chars?: number
  /** The full emitted additionalContext — so users can see exactly what the model gets. */
  additionalContext?: string
  /** Error details when `action="error"` (e.g. file write failure summary). Never echoed to stderr. */
  errorMessage?: string
}

// NOTE on muzzling: these loggers are constructed without an explicit
// config array so that legacy `addWriter({ ns: "injection:*" }, fn)`
// subscribers still receive events through loggily's env-pipeline.
//
// Suppressing the console output (the load-bearing change for the
// stderr-echo bug) happens at the *hook entry point* via
// `setSuppressConsole(true)` — see `vendor/bearly/tools/lib/tribe/hook-dispatch.ts`.
// Doing it there muzzles all loggily output for the lifetime of the hook
// process while keeping `addWriter` subscribers wired up.
const wrapLog = createLogger("injection:wrap")
const skipLog = createLogger("injection:skip")

const _installedPaths = new Set<string>()

/**
 * Pipe `injection:*`, `recall:*`, and `tribe:*` events to a JSONL file
 * at `path`. Idempotent per path (calling twice is a no-op). Returns the
 * unsubscribe handle from loggily so callers can detach the writer if
 * needed.
 *
 * Why these three namespaces: every loggily logger in the bearly hook
 * code path lives under one of them. Capturing all three at the hook's
 * file writer install gives a single tail-able trail without each
 * subsystem having to know about the file location. The records carry
 * their own `namespace` field so attribution stays per-subsystem.
 *
 * The directory is created on demand (`mkdir -p`) so the default user
 * path (`~/.local/share/bearly/`) doesn't need to exist beforehand.
 */
export function installInjectionFileWriter(path: string): () => void {
  if (_installedPaths.has(path)) return () => {}
  _installedPaths.add(path)
  try {
    mkdirSync(dirname(path), { recursive: true })
  } catch {
    // mkdir failure is recoverable if the dir already exists with the
    // right perms; let createFileWriter surface the real error.
  }
  const writer = createFileWriter(path)
  const sink = (_formatted: string, _level: string, _ns: string, event: Event): void => {
    // Span events flow past too — we only persist log records.
    if (event.kind !== "log") return
    writer.write(
      JSON.stringify({
        ts: new Date(event.time).toISOString(),
        producer: _PRODUCER_ID,
        pid: process.pid,
        namespace: event.namespace,
        level: event.level,
        msg: event.message,
        ...event.props,
      }),
    )
  }
  // Three independent subscriptions — addWriter's ns filter is OR-only,
  // so we register once per top-level namespace tree. The unsubscribe
  // handles are merged into one for the caller's convenience.
  const unsubs = [
    addWriter({ ns: "injection:*" }, sink),
    addWriter({ ns: "recall:*" }, sink),
    addWriter({ ns: "tribe:*" }, sink),
  ]
  return () => {
    for (const u of unsubs) u()
  }
}

let _envChecked = false
function ensureFileWriter(): void {
  if (_envChecked) return
  _envChecked = true
  // Priority: explicit env var > LOGGILY_FILE > per-user default.
  // The default path keeps observability on without requiring opt-in env
  // vars, while staying off stderr (which Claude Code captures into the
  // prompt as a system-reminder).
  const primaryPath =
    process.env.INJECTION_DEBUG_LOG ??
    process.env.LOGGILY_FILE ??
    join(homedir(), ".local", "share", "bearly", "injection.jsonl")
  try {
    installInjectionFileWriter(primaryPath)
    return
  } catch {
    // Fall through to /tmp fallback below.
  }
  try {
    installInjectionFileWriter(join("/tmp", `bearly-injection-${process.pid}.jsonl`))
  } catch {
    // Both writers failed — drop silently. Never write to stderr; the
    // upstream stderr-echo bug makes that worse than missed observability.
  }
}

export function emitInjectionDebugEvent(event: InjectionDebugEvent): void {
  ensureFileWriter()
  const log = event.action === "emit" ? wrapLog : skipLog
  log.info?.(event.action, { ...event })
}
