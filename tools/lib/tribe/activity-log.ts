/**
 * Unified tribe session-activity log.
 *
 * Routed through loggily at `.debug` level on the `tribe:activity` namespace.
 * Loggily writes JSON events to both the configured file sink and any
 * upstream pipeline (OTel, console, etc.) that the daemon sets up.
 *
 * Motivation: on 2026-04-21 a phantom "chief" offer arrived in a sibling
 * session's prompt stream. Forensics required direct sqlite on tribe.db to
 * discover the offer had never travelled through tribe. The activity log is
 * the observability surface that catches that class of incident live.
 *
 * Phases:
 *   1. Tribe daemon — DMs + broadcasts + session lifecycle ✓
 *   2. Recall hook injections — writeInjectActivity() from emit.ts ✓
 *   3. Injection-gate verdicts (follow-up bead)
 *
 * Path: $TRIBE_ACTIVITY_LOG, or ~/.local/share/tribe/activity.jsonl.
 * Disable with TRIBE_ACTIVITY_LOG=off (used by tests; production leaves
 * unset so loggily writes to the default path at debug level).
 *
 * Why debug level + explicit config array: the loggily config pins level
 * to "debug" explicitly, so the activity stream fires regardless of the
 * daemon's wider LOG_LEVEL / DEBUG env. Keeps the contract simple:
 * activity is always observable, always at debug, always in one place.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs"
import { dirname, join } from "node:path"
import { createLogger, type ConditionalLogger } from "loggily"
import { stripLoneSurrogates, truncateSurrogateSafe } from "./validation.ts"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ActivityKind = "dm" | "broadcast" | "event" | "session" | "rename" | "inject" | "gate"
export type ActivitySource = "tribe" | "recall" | "gate"

export interface ActivityEntry {
  ts: number
  source: ActivitySource
  kind: ActivityKind
  session: string
  peer?: string
  type?: string
  preview?: string
  chars?: number
  id?: string
  bead_id?: string | null
  meta?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_DIR_SUFFIX = "/.local/share/tribe"
const DEFAULT_RETAIN_DAYS = 30

/**
 * Return today's activity-log path. Files are date-stamped
 * (`activity-YYYY-MM-DD.jsonl`) and rotate at midnight local time.
 *
 * `TRIBE_ACTIVITY_LOG=<path>` override returns the literal path verbatim
 * (no rotation) so tests can pin to a single tmp file.
 */
export function activityLogPath(now: Date = new Date()): string {
  const override = process.env.TRIBE_ACTIVITY_LOG
  if (override && override !== "off") return override
  return join(activityLogDir(), activityLogFilename(now))
}

/** Return the directory containing activity-* files. */
export function activityLogDir(): string {
  const home = process.env.HOME ?? ""
  return `${home}${DEFAULT_DIR_SUFFIX}`
}

/** Per-day filename for an arbitrary date. Exported for the watch CLI. */
export function activityLogFilename(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `activity-${y}-${m}-${d}.jsonl`
}

/**
 * Remove activity-*.jsonl files whose mtime is older than `keepDays` days.
 * Best-effort: failures are silently ignored (the daemon calls this once
 * on startup; missing files / permission errors should not block boot).
 *
 * Returns the count of files removed.
 */
export function pruneOldActivityLogs(keepDays: number = DEFAULT_RETAIN_DAYS, now: Date = new Date()): number {
  const dir = activityLogDir()
  if (!existsSync(dir)) return 0
  const cutoff = now.getTime() - keepDays * 86_400_000
  let removed = 0
  try {
    for (const name of readdirSync(dir)) {
      if (!/^activity-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue
      const path = join(dir, name)
      try {
        if (statSync(path).mtimeMs < cutoff) {
          unlinkSync(path)
          removed++
        }
      } catch {
        // skip one file, keep going
      }
    }
  } catch {
    // dir read failure → nothing to prune
  }
  return removed
}

function isDisabled(): boolean {
  return process.env.TRIBE_ACTIVITY_LOG === "off"
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

let parentEnsuredFor: string | null = null
let warned = false
let cachedLogger: ConditionalLogger | null = null
let cachedLoggerPath: string | null = null

function ensureParent(path: string): void {
  if (parentEnsuredFor === path) return
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  parentEnsuredFor = path
}

function getLogger(): ConditionalLogger | null {
  if (isDisabled()) return null
  // Recompute the path on every call so date rollover at midnight rotates
  // to the next day's file without requiring daemon restart. Cache hits
  // when the path is unchanged (same day, or env override pinned).
  const path = activityLogPath()
  if (cachedLogger && cachedLoggerPath === path) return cachedLogger
  ensureParent(path)
  // Explicit config array. `level: debug` pins the level; `format: json`
  // makes the downstream Writable receive JSON-serialized strings. The
  // Writable writes synchronously (`appendFileSync`) so tail-f readers and
  // tests both see events immediately — no buffered flush ambiguity.
  //
  // The Writable closes over `path` at construction time, but `getLogger()`
  // re-runs and re-binds when the day rolls — so post-rollover events
  // append to the new day's file, not the old one.
  cachedLogger = createLogger("tribe:activity", [
    { level: "debug", format: "json" },
    {
      objectMode: false,
      write: (data: unknown) => {
        try {
          const line =
            typeof data === "string" ? (data.endsWith("\n") ? data : data + "\n") : JSON.stringify(data) + "\n"
          appendFileSync(path, line, "utf8")
        } catch (err) {
          if (!warned) {
            warned = true
            console.error(
              `[tribe:activity-log] write failed (${String(err)}); path=${path} — further failures silenced`,
            )
          }
        }
      },
    },
  ])
  cachedLoggerPath = path
  return cachedLogger
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Write one entry at `debug` level on the `tribe:activity` namespace.
 * Append-only, synchronous, best-effort. Failed writes never break message
 * delivery — they warn once to stderr and subsequent failures are silenced.
 */
export function writeActivity(entry: ActivityEntry): void {
  const log = getLogger()
  if (!log) return
  // Passing the entry as `data` means loggily inlines its fields at top
  // level in the JSON output, alongside `time`, `level`, `name`, `msg`.
  log.debug?.("activity", entry as unknown as Record<string, unknown>)
}

/**
 * Derive an ActivityEntry from the onMessageInserted callback payload.
 *
 * Maps the internal `direct|broadcast|event` message kinds to activity kinds:
 *   - `direct`    → `dm`
 *   - `broadcast` with type='session' → `session` (joined/left broadcasts)
 *   - `broadcast` with type='notify' and content starting 'Member "' → `rename`
 *   - other `broadcast` → `broadcast`
 *   - `event` → `event` (journal-only rows, rarely reached since logEvent
 *     bypasses onMessageInserted)
 */
export function activityFromMessage(msg: {
  id: string
  ts: number
  type: string
  kind: "direct" | "broadcast" | "event"
  sender: string
  recipient: string
  content: string
  bead_id: string | null
}): ActivityEntry {
  let kind: ActivityKind
  if (msg.kind === "event") {
    kind = "event"
  } else if (msg.kind === "direct") {
    kind = "dm"
  } else if (msg.type === "session") {
    kind = "session"
  } else if (msg.type === "notify" && msg.content.startsWith('Member "')) {
    kind = "rename"
  } else {
    kind = "broadcast"
  }

  const clean = msg.content.replace(/\s+/g, " ").trim()
  const preview = stripLoneSurrogates(
    clean.length <= 200 ? clean : truncateSurrogateSafe(clean, 199) + "…",
  )

  return {
    ts: msg.ts,
    source: "tribe",
    kind,
    session: msg.sender,
    peer: msg.recipient === "*" ? undefined : msg.recipient,
    type: msg.type,
    preview,
    id: msg.id,
    bead_id: msg.bead_id,
  }
}

/**
 * Record a recall hook injection. Called from injection-envelope.emitHookJson
 * whenever a UserPromptSubmit additionalContext is about to land in the
 * Claude Code session.
 *
 * Unlike tribe messages (which carry short broadcasts/DMs and benefit from
 * 200-char preview caps), injections are the whole payload of interest. We
 * log the **full** content verbatim so `tail -f | jq '.preview'` shows what
 * actually reached the prompt. Whitespace is still collapsed for single-line
 * jq output; `chars` reports the post-collapse length.
 *
 * Session attribution: $CLAUDE_SESSION_ID when Claude Code sets it, else
 * `pid-<pid>` as a last resort.
 */
export function writeInjectActivity(content: string, extra?: { meta?: Record<string, unknown> }): void {
  const session = process.env.CLAUDE_SESSION_ID ?? `pid-${process.pid}`
  const collapsed = content.replace(/\s+/g, " ").trim()
  writeActivity({
    ts: Date.now(),
    source: "recall",
    kind: "inject",
    session,
    preview: collapsed,
    chars: collapsed.length,
    meta: extra?.meta,
  })
}

/**
 * Record a PreToolUse injection-gate verdict. Called from
 * tools/injection-gate.ts after `evaluateGate()` decides allow / ask / deny.
 *
 * `preview` carries the human-readable reason so `tail -f | jq '.preview'`
 * shows why a tool was blocked without needing to look up the manifest. The
 * `meta.reasonCode` field carries the structured slug for filtering /
 * aggregation (e.g. `injection-only-entities`, `shingle-overlap`,
 * `allow-explicit-auth`).
 */
export function writeGateActivity(args: {
  decision: "allow" | "ask" | "deny"
  toolName: string
  reason: string
  reasonCode?: string
  sessionId?: string
  meta?: Record<string, unknown>
}): void {
  const session = args.sessionId ?? process.env.CLAUDE_SESSION_ID ?? `pid-${process.pid}`
  const reasonClean = args.reason.replace(/\s+/g, " ").trim()
  const preview = stripLoneSurrogates(
    reasonClean.length <= 200 ? reasonClean : truncateSurrogateSafe(reasonClean, 199) + "…",
  )
  writeActivity({
    ts: Date.now(),
    source: "gate",
    kind: "gate",
    session,
    type: args.decision,
    preview,
    meta: {
      tool: args.toolName,
      reasonCode: args.reasonCode,
      ...args.meta,
    },
  })
}

/** Reset cached state. Tests only. */
export function __resetActivityLogState(): void {
  parentEnsuredFor = null
  warned = false
  cachedLogger = null
  cachedLoggerPath = null
}
