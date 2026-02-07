/**
 * Hook handlers for UserPromptSubmit and SessionEnd.
 * Called by Claude Code hooks, not directly by users.
 */

import * as path from "path"
import * as os from "os"
import { hookRecall } from "../lib/history/recall"
import { summarizeUnprocessedDays } from "./summarize-daily"

// ============================================================================
// Stdin reader
// ============================================================================

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString("utf8")
}

// ============================================================================
// Hook command — UserPromptSubmit
// ============================================================================

export async function cmdHook(): Promise<void> {
  const startTime = Date.now()
  try {
    const stdin = await readStdin()
    let input: { prompt?: string }
    try {
      input = JSON.parse(stdin) as { prompt?: string }
    } catch (e) {
      console.error(
        `[recall hook] FATAL: invalid JSON on stdin (${Date.now() - startTime}ms): ${String(e)}\nstdin was: ${stdin.slice(0, 200)}`,
      )
      process.exit(1)
      return
    }
    const prompt = input.prompt
    if (!prompt) {
      console.error(
        `[recall hook] no prompt in stdin (${Date.now() - startTime}ms)`,
      )
      process.exit(0)
    }
    const result = await hookRecall(prompt)
    const elapsed = Date.now() - startTime
    if (result.skipped) {
      console.error(
        `[recall hook] skipped: ${result.reason} (${elapsed}ms) prompt="${prompt.slice(0, 60)}"`,
      )
      process.exit(0)
    }
    const synthLen =
      result.hookOutput?.hookSpecificOutput.additionalContext.length ?? 0
    console.error(
      `[recall hook] OK: ${synthLen} chars synthesis (${elapsed}ms) prompt="${prompt.slice(0, 60)}"`,
    )
    console.log(JSON.stringify(result.hookOutput))
  } catch (e) {
    const elapsed = Date.now() - startTime
    console.error(
      `[recall hook] FATAL: unhandled error (${elapsed}ms): ${e instanceof Error ? `${e.message}\n${e.stack}` : String(e)}`,
    )
    process.exit(1)
  }
}

// ============================================================================
// Remember command — SessionEnd
// ============================================================================

/**
 * SessionEnd hook: trigger daily summarization for any unprocessed past days.
 * No per-session LLM call — daily summaries are more useful and less noisy.
 */
export async function cmdRemember(opts: { json?: boolean }): Promise<void> {
  const startTime = Date.now()
  try {
    // Read stdin (required by hook protocol, but we only need session_id for logging)
    const stdin = await readStdin()
    let sessionId = "unknown"
    try {
      const input = JSON.parse(stdin) as { session_id?: string }
      sessionId = input.session_id?.slice(0, 8) ?? "unknown"
    } catch {
      // Best-effort parse
    }

    // Summarize any unprocessed past days (not today — still in progress)
    const results = await summarizeUnprocessedDays({ limit: 3, verbose: false })
    const elapsed = Date.now() - startTime

    const summarized = results.filter((r) => !r.skipped)
    if (summarized.length > 0) {
      console.error(
        `[recall remember] summarized ${summarized.length} day(s): ${summarized.map((r) => r.date).join(", ")} (${elapsed}ms) session=${sessionId}`,
      )
    } else {
      console.error(
        `[recall remember] no unprocessed days (${elapsed}ms) session=${sessionId}`,
      )
    }

    if (opts.json) {
      console.log(JSON.stringify(results, null, 2))
    }
  } catch (e) {
    const elapsed = Date.now() - startTime
    console.error(
      `[recall remember] FATAL: unhandled error (${elapsed}ms): ${e instanceof Error ? `${e.message}\n${e.stack}` : String(e)}`,
    )
    process.exit(1)
  }
}
