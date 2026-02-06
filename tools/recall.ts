#!/usr/bin/env bun
/**
 * recall.ts - Search Claude Code session history with LLM synthesis
 *
 * Searches indexed sessions using FTS5 and optionally synthesizes results
 * through a cheap LLM to extract decisions, approaches, and lessons learned.
 *
 * Usage:
 *   bun recall <query>              # Search + synthesize
 *   bun recall --raw <query>        # Raw results, no LLM
 *   bun recall --since 1w <query>   # Time-scoped
 *   bun recall --json <query>       # JSON output
 *   bun recall --limit 5 <query>    # Limit results
 *   bun recall --timeout 6000 <query> # Custom timeout
 *   bun recall review               # Run memory system diagnostics
 *   bun recall review --json        # Diagnostics as JSON
 */

import * as path from "path"
import { Command } from "commander"
import {
  recall,
  hookRecall,
  remember,
  reviewMemorySystem,
  type RecallOptions,
  type RecallResult,
  type ReviewResult,
} from "./lib/history/recall"

// ANSI codes
const DIM = "\x1b[2m"
const BOLD = "\x1b[1m"
const CYAN = "\x1b[36m"
const YELLOW = "\x1b[33m"
const GREEN = "\x1b[32m"
const RED = "\x1b[31m"
const RESET = "\x1b[0m"

// Status markers
const CHECK = `${GREEN}\u2713${RESET}`
const WARN = `${YELLOW}\u26A0${RESET}`
const CROSS = `${RED}\u2717${RESET}`

// ============================================================================
// Output formatting — search results
// ============================================================================

function formatOutput(
  result: RecallResult,
  options: { raw?: boolean; json?: boolean },
): void {
  const { raw, json } = options

  // JSON mode — print structured output
  if (json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  // No results
  if (result.results.length === 0) {
    console.log(`No results found for "${result.query}"`)
    console.log(`${DIM}(searched in ${result.durationMs}ms)${RESET}`)
    return
  }

  // Synthesis mode (default)
  if (!raw && result.synthesis) {
    console.log(result.synthesis)
    console.log()
    console.log(
      `${DIM}${result.results.length} results from ${countUniqueSessions(result)} sessions (${result.durationMs}ms)${RESET}`,
    )
    if (result.llmCost !== undefined && result.llmCost > 0) {
      console.log(`${DIM}LLM cost: $${result.llmCost.toFixed(4)}${RESET}`)
    }
    return
  }

  // Raw mode — show individual results
  console.log(
    `${BOLD}${result.results.length} results${RESET} for "${result.query}":\n`,
  )

  for (const r of result.results) {
    const date = new Date(r.timestamp).toISOString().split("T")[0]
    const typeLabel = formatType(r.type)
    const sessionLabel = r.sessionTitle
      ? `${r.sessionTitle}`
      : `${r.sessionId.slice(0, 8)}...`

    console.log(
      `${typeLabel} ${BOLD}${sessionLabel}${RESET} ${DIM}(${date})${RESET}`,
    )

    // Format snippet: highlight >>> <<< markers
    const highlighted = r.snippet
      .replace(/>>>/g, `${BOLD}${YELLOW}`)
      .replace(/<<</g, RESET)
    const indented = highlighted
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n")
    console.log(indented)
    console.log()
  }

  console.log(`${DIM}(${result.durationMs}ms)${RESET}`)
}

function formatType(type: string): string {
  switch (type) {
    case "message":
      return `${CYAN}[msg]${RESET}`
    case "plan":
      return `${GREEN}[plan]${RESET}`
    case "summary":
      return `${YELLOW}[summary]${RESET}`
    case "todo":
      return `${YELLOW}[todo]${RESET}`
    case "first_prompt":
      return `${CYAN}[prompt]${RESET}`
    default:
      return `[${type}]`
  }
}

function countUniqueSessions(result: RecallResult): number {
  return new Set(result.results.map((r) => r.sessionId)).size
}

// ============================================================================
// Output formatting — review diagnostics
// ============================================================================

function formatReviewOutput(review: ReviewResult): void {
  const h = review.indexHealth
  const hk = review.hookConfig

  console.log()
  console.log(`${BOLD}Memory System Review${RESET}`)
  console.log("\u2550".repeat(40))
  console.log()

  // ── Index Health ────────────────────────────────────────────────────
  console.log(`${BOLD}Index Health${RESET}`)
  console.log(
    `  Sessions: ${h.sessions.toLocaleString()}  Messages: ${h.messages.toLocaleString()}  Plans: ${h.plans.toLocaleString()}  Summaries: ${h.summaries.toLocaleString()}`,
  )
  console.log(
    `  First prompts: ${h.firstPrompts.toLocaleString()}  Todos: ${h.todos.toLocaleString()}  DB size: ${formatBytes(h.dbSizeBytes)}`,
  )
  if (h.lastRebuild) {
    const staleLabel = h.isStale ? ` ${YELLOW}(stale)${RESET}` : ""
    console.log(`  Last rebuild: ${h.lastRebuild}${staleLabel}`)
  } else {
    console.log(`  Last rebuild: ${RED}never${RESET}`)
  }
  console.log()

  // ── Hook Configuration ──────────────────────────────────────────────
  console.log(`${BOLD}Hook Configuration${RESET}`)
  console.log(
    `  ${hk.userPromptSubmitConfigured ? CHECK : CROSS} UserPromptSubmit hook configured`,
  )
  console.log(
    `  ${hk.sessionEndConfigured ? CHECK : CROSS} SessionEnd hook configured`,
  )
  console.log(
    `  ${hk.recallHookConfigured ? CHECK : CROSS} recall.ts hook command ${hk.recallHookConfigured ? "configured" : "not found in UserPromptSubmit"}`,
  )
  console.log(
    `  ${hk.rememberHookConfigured ? CHECK : CROSS} recall.ts remember command ${hk.rememberHookConfigured ? "configured" : "not found in SessionEnd"}`,
  )
  console.log(
    `  ${hk.sessionMemoryFiles > 0 ? CHECK : WARN} ${hk.sessionMemoryFiles} session memory file${hk.sessionMemoryFiles !== 1 ? "s" : ""} in memory/sessions/`,
  )
  console.log()

  // ── Search Benchmarks ───────────────────────────────────────────────
  console.log(`${BOLD}Search Benchmarks${RESET}`)
  for (const b of review.searchBenchmarks) {
    const parts = [
      `${b.resultCount.toLocaleString()} results`,
      `${b.latencyMs}ms`,
    ]
    if (b.uniqueSessions > 0) {
      parts.push(
        `${b.uniqueSessions} session${b.uniqueSessions !== 1 ? "s" : ""}`,
      )
    }
    if (b.hasTitles) {
      parts.push("titles: yes")
    }
    const queryLabel = b.query.padEnd(16)
    console.log(`  ${DIM}${queryLabel}${RESET} ${"\u2192"} ${parts.join(", ")}`)
  }
  console.log()

  // ── Recall Quality ──────────────────────────────────────────────────
  if (review.recallTest) {
    const rt = review.recallTest
    console.log(`${BOLD}Recall Quality${RESET}`)
    const synthLabel = rt.synthesisOk
      ? `${GREEN}synthesis OK${RESET} (${rt.synthesisLength} chars)`
      : `${RED}synthesis failed${RESET}`
    const costLabel = rt.llmCost !== null ? `, $${rt.llmCost.toFixed(4)}` : ""
    console.log(
      `  Query: "${rt.query}" ${"\u2192"} ${synthLabel}, ${(rt.durationMs / 1000).toFixed(1)}s${costLabel}`,
    )
    console.log(
      `  ${rt.resultCount} results from ${rt.uniqueSessions} session${rt.uniqueSessions !== 1 ? "s" : ""}`,
    )
    console.log()
  }

  // ── Recommendations ─────────────────────────────────────────────────
  if (review.recommendations.length > 0) {
    console.log(`${BOLD}Recommendations${RESET}`)
    for (const rec of review.recommendations) {
      // Determine marker based on content
      const marker =
        rec.includes("good") || rec.includes("working")
          ? CHECK
          : rec.includes("stale") ||
              rec.includes("not found") ||
              rec.includes("failed") ||
              rec.includes("No ") ||
              rec.includes("not configured") ||
              rec.includes("NOT executable") ||
              rec.includes("error") ||
              rec.includes("empty") ||
              rec.includes("corrupt")
            ? CROSS
            : WARN
      console.log(`  ${marker} ${rec}`)
    }
    console.log()
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(0)}MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`
}

// ============================================================================
// CLI
// ============================================================================

function parseOpts(
  opts: Record<string, string | boolean | undefined>,
): RecallOptions {
  return {
    raw: opts.raw === true,
    json: opts.json === true,
    since: opts.since as string | undefined,
    limit: opts.limit ? parseInt(opts.limit as string, 10) : undefined,
    timeout: opts.timeout ? parseInt(opts.timeout as string, 10) : undefined,
    projectFilter: opts.project as string | undefined,
  }
}

/**
 * Resolve the project root directory.
 * Walks up from the script location to find the repo root.
 */
function getProjectRoot(): string {
  // The recall.ts script lives at vendor/beorn-tools/tools/recall.ts
  // So project root is 4 levels up from __dirname
  let dir = path.resolve(import.meta.dir)
  for (let i = 0; i < 3; i++) {
    dir = path.dirname(dir)
  }
  return dir
}

const SUBCOMMANDS = new Set([
  "review",
  "hook",
  "remember",
  "help",
  "--help",
  "-h",
  "--version",
  "-V",
])

const program = new Command()

program
  .name("recall")
  .description("Search Claude Code session history with LLM synthesis")
  .version("1.0.0")

// Search subcommand (also the default when no subcommand matches)
const searchCmd = program
  .command("search")
  .description("Search and synthesize session history")
  .argument("<query>", "Search query")
  .option("--raw", "Return raw results without LLM synthesis")
  .option("--json", "Output as JSON")
  .option(
    "-s, --since <time>",
    "Time filter: 1h, 1d, 1w, today, yesterday (default: 30d)",
  )
  .option("-n, --limit <num>", "Max results (default: 10)")
  .option("-t, --timeout <ms>", "LLM timeout in ms (default: 8000)")
  .option("-p, --project <filter>", "Project filter (substring match)")
  .action(
    async (
      query: string,
      opts: Record<string, string | boolean | undefined>,
    ) => {
      const recallOpts = parseOpts(opts)
      const result = await recall(query, recallOpts)
      formatOutput(result, { raw: recallOpts.raw, json: recallOpts.json })
    },
  )

// Review subcommand
program
  .command("review")
  .description("Run memory system diagnostics")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const projectRoot = getProjectRoot()
    const review = await reviewMemorySystem(projectRoot)

    if (opts.json) {
      console.log(JSON.stringify(review, null, 2))
    } else {
      formatReviewOutput(review)
    }
  })

// Hook subcommand — called by UserPromptSubmit hook
program
  .command("hook")
  .description("Run recall for a hook context (reads prompt from stdin JSON)")
  .action(async () => {
    const startTime = Date.now()
    const stdin = await readStdin()
    const input = JSON.parse(stdin) as { prompt?: string }
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
  })

// Remember subcommand — called by SessionEnd hook
// Reads stdin JSON for transcript_path, session_id; uses CLAUDE_PROJECT_DIR for memory dir
program
  .command("remember")
  .description(
    "Extract lessons from a session transcript and save to memory (reads stdin JSON from SessionEnd hook)",
  )
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const startTime = Date.now()
    const stdin = await readStdin()
    const input = JSON.parse(stdin) as {
      transcript_path?: string
      session_id?: string
    }

    const transcriptPath = input.transcript_path
    const sessionId = input.session_id

    if (!transcriptPath || !sessionId) {
      console.error(
        `[recall remember] missing transcript_path or session_id in stdin`,
      )
      process.exit(0)
    }

    // Determine memory directory
    const projectDir =
      process.env.CLAUDE_PROJECT_DIR || path.dirname(transcriptPath)
    const memoryDir = path.join(projectDir, "memory", "sessions")

    const result = await remember({
      transcriptPath,
      sessionId,
      memoryDir,
    })
    const elapsed = Date.now() - startTime

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2))
    } else if (result.skipped) {
      console.error(
        `[recall remember] skipped: ${result.reason} (${elapsed}ms) session=${sessionId.slice(0, 8)}`,
      )
    } else {
      console.error(
        `[recall remember] saved ${result.lessonsCount ?? 0} lessons to ${result.memoryFile} (${elapsed}ms)`,
      )
    }
  })

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString("utf8")
}

export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  if (argv.length === 0) {
    program.help()
    return
  }

  // If first arg isn't a known subcommand, treat as `search <query> [opts]`
  if (!SUBCOMMANDS.has(argv[0]!)) {
    argv = ["search", ...argv]
  }

  await program.parseAsync(["node", "recall", ...argv])
}

if (import.meta.main) {
  main()
}
