/**
 * Daily summary rollups from per-session summaries.
 *
 * Second pass of two-pass hierarchical summarization:
 * 1. summarize-session.ts produces cached per-session summaries
 * 2. This module rolls them up into daily summaries with additional context
 *    (beads activity, git commits)
 */

import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { getDb, closeDb } from "../lib/history/db"
import { summarizeSessionBatch, type SessionSummary } from "./summarize-session"
import { findSessionJsonl } from "./extract"
import { getCheapModel } from "../lib/llm/types"
import { queryModel } from "../lib/llm/research"
import { isProviderAvailable } from "../lib/llm/providers"

// ============================================================================
// Types
// ============================================================================

export interface DailySummaryResult {
  date: string
  sessionsCount: number
  summary: string | null
  memoryFile: string | null
  skipped: boolean
  reason?: string
}

interface SessionRecord {
  id: string
  title: string
  project_path: string
  message_count: number
  created_at: number
  updated_at: number
}

// ============================================================================
// Constants
// ============================================================================

const DAILY_SUMMARY_PROMPT = `You are summarizing a full day of Claude Code development sessions. Your audience is the developer reviewing what happened and an AI search index for future recall.

Produce a concise daily summary with these sections (skip empty sections):

## Key Decisions
Decisions made and their rationale. Be specific — include file names, function names, package names.

## Bugs Found
Bugs discovered, their root causes, and fixes applied.

## Mistakes & Dead Ends
Wrong approaches tried, failed commands, debugging dead ends, misconceptions about APIs/libraries, time wasted. Be specific: what was attempted, why it failed, and what the correct approach turned out to be. OMIT this section entirely if no real mistakes occurred — "no missteps" is useless filler.

## Lessons Learned
Insights gained, patterns discovered, non-obvious things that worked. These should be genuinely novel — not obvious restatements. OMIT this section if nothing genuinely novel was learned.

## Architecture Changes
Structural changes, new patterns adopted, refactoring done.

## Open Questions
Unresolved issues, things to revisit, potential follow-up work.

Rules:
- Be concise: 3-6 bullets per section maximum
- Each bullet should be 1-2 sentences
- Include specific file paths, function names, and package names when mentioned
- Tag each bullet with [session-ref:SHORT_ID] where SHORT_ID is the first 8 chars of the session that produced it
- If multiple sessions contribute to the same point, list all refs: [session-ref:AAA,BBB]
- Skip routine operations (file reads, test runs, linting)
- If truly nothing noteworthy happened, respond with just: NONE
- Do NOT invent information not present in the session data`

// ============================================================================
// Core: summarize a single day
// ============================================================================

export async function summarizeDay(
  date: string,
  opts: { projectFilter?: string; verbose?: boolean } = {},
): Promise<DailySummaryResult> {
  const log = opts.verbose
    ? (msg: string) => console.error(`[summarize] ${msg}`)
    : () => {}

  log(`summarizing ${date}...`)

  // Parse date to get day boundaries (local time)
  const dayStart = new Date(`${date}T00:00:00`)
  const dayEnd = new Date(`${date}T23:59:59.999`)
  if (isNaN(dayStart.getTime())) {
    return {
      date,
      sessionsCount: 0,
      summary: null,
      memoryFile: null,
      skipped: true,
      reason: "invalid_date",
    }
  }

  const startMs = dayStart.getTime()
  const endMs = dayEnd.getTime()

  // Query sessions for this day
  const db = getDb()
  let rows: SessionRecord[]
  try {
    const query = opts.projectFilter
      ? `SELECT id, title, project_path, message_count, created_at, updated_at
         FROM sessions WHERE updated_at >= ? AND updated_at <= ? AND project_path LIKE ?
         ORDER BY created_at ASC`
      : `SELECT id, title, project_path, message_count, created_at, updated_at
         FROM sessions WHERE updated_at >= ? AND updated_at <= ?
         ORDER BY created_at ASC`

    const params = opts.projectFilter
      ? [startMs, endMs, `%${opts.projectFilter}%`]
      : [startMs, endMs]

    rows = db.prepare(query).all(...params) as SessionRecord[]
  } finally {
    closeDb()
  }

  if (rows.length === 0) {
    log(`no sessions found for ${date}`)
    return {
      date,
      sessionsCount: 0,
      summary: null,
      memoryFile: null,
      skipped: true,
      reason: "no_sessions",
    }
  }

  // Filter meaningful sessions (> 5KB JSONL)
  const meaningfulSessions = rows.filter((s) => {
    const jsonlPath = findSessionJsonl(s.id)
    if (!jsonlPath) return false
    try {
      return fs.statSync(jsonlPath).size > 5_000
    } catch {
      return false
    }
  })
  log(
    `${rows.length} total sessions, ${meaningfulSessions.length} meaningful (>5KB)`,
  )

  if (meaningfulSessions.length === 0) {
    log(`no meaningful sessions for ${date}`)
    return {
      date,
      sessionsCount: rows.length,
      summary: null,
      memoryFile: null,
      skipped: true,
      reason: "no_meaningful_sessions",
    }
  }

  // Get per-session summaries (cached via summarize-session)
  const sessionSummaries = await summarizeSessionBatch(
    meaningfulSessions.map((s) => ({
      id: s.id,
      title: s.title ?? null,
      createdAt: s.created_at,
    })),
    { verbose: opts.verbose },
  )

  // Filter out sub-agent sessions and sessions with null summary
  const usableSummaries = sessionSummaries.filter(
    (s) => !s.isSubAgent && s.summary != null,
  )
  log(
    `${sessionSummaries.length} session summaries, ${usableSummaries.length} usable (non-sub-agent with content)`,
  )

  if (usableSummaries.length === 0) {
    log(`no usable session summaries for ${date}`)
    return {
      date,
      sessionsCount: rows.length,
      summary: null,
      memoryFile: null,
      skipped: true,
      reason: "no_content",
    }
  }

  // Extract beads activity + git commits
  const beadsContent = await extractBeadsActivity(startMs, endMs, log)
  const gitContent = await extractGitCommits(date, log)

  // Build LLM context from per-session summaries
  const totalMessages = meaningfulSessions.reduce(
    (s, sess) => s + (sess.message_count || 0),
    0,
  )
  const projects = [...new Set(meaningfulSessions.map((s) => s.project_path))]

  let context = `# Daily Development Summary: ${date}\n\n`
  context += `${meaningfulSessions.length} sessions, ${totalMessages} messages across ${projects.length} project(s): ${projects.map(displayProject).join(", ")}\n\n`

  for (const s of usableSummaries) {
    const titlePart = s.title ? ` — ${s.title}` : ""
    context += `### Session ${s.shortId} (${s.time})${titlePart}\n\n${s.summary}\n\n`
  }

  if (beadsContent) {
    context += `\n${beadsContent}`
  }
  if (gitContent) {
    context += `\n${gitContent}`
  }

  // Truncate to ~30KB for LLM context
  if (context.length > 30000) {
    context = context.slice(0, 30000) + "\n\n[...truncated]"
  }

  log(
    `LLM context: ${context.length} chars from ${usableSummaries.length} sessions`,
  )

  // Check LLM availability
  const model = getCheapModel()
  if (!model || !isProviderAvailable(model.provider)) {
    log(`no LLM provider available`)
    return {
      date,
      sessionsCount: rows.length,
      summary: null,
      memoryFile: null,
      skipped: true,
      reason: "no_llm_provider",
    }
  }

  // Synthesize
  const llmStart = Date.now()
  const result = await queryModel({
    question: context,
    model,
    systemPrompt: DAILY_SUMMARY_PROMPT,
  })
  const synthesis = result.response.content
  log(`LLM responded in ${Date.now() - llmStart}ms`)

  if (!synthesis || /^NONE$/im.test(synthesis.trim())) {
    log(`nothing noteworthy for ${date}`)
    return {
      date,
      sessionsCount: rows.length,
      summary: null,
      memoryFile: null,
      skipped: true,
      reason: "nothing_noteworthy",
    }
  }

  // Write the daily summary file
  const memoryDir = getSessionMemoryDir()
  fs.mkdirSync(memoryDir, { recursive: true })

  const memoryFile = path.join(memoryDir, `${date}.md`)
  const msgInfo = totalMessages > 0 ? `, ${totalMessages} messages` : ""
  const header = `# ${date}\n\n${meaningfulSessions.length} sessions${msgInfo} | ${projects.map(displayProject).join(", ")}\n\n`
  const sessionsIndex = buildSessionIndex(usableSummaries)

  fs.writeFileSync(memoryFile, header + synthesis + "\n\n" + sessionsIndex)

  log(`wrote ${memoryFile}`)

  return {
    date,
    sessionsCount: rows.length,
    summary: synthesis,
    memoryFile,
    skipped: false,
  }
}

// ============================================================================
// Detect unprocessed days and summarize them
// ============================================================================

export async function summarizeUnprocessedDays(
  opts: { limit?: number; verbose?: boolean; projectFilter?: string } = {},
): Promise<DailySummaryResult[]> {
  const limit = opts.limit ?? 10
  const log = opts.verbose
    ? (msg: string) => console.error(`[summarize] ${msg}`)
    : () => {}

  const memoryDir = getSessionMemoryDir()
  const existingSummaries = new Set<string>()

  if (fs.existsSync(memoryDir)) {
    for (const entry of fs.readdirSync(memoryDir)) {
      if (entry.endsWith(".md")) {
        existingSummaries.add(entry.replace(/\.md$/, ""))
      }
    }
  }

  // Get distinct days from sessions table
  const db = getDb()
  let days: string[]
  try {
    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000
    const dbRows = db
      .prepare(
        `SELECT DISTINCT date(updated_at / 1000, 'unixepoch', 'localtime') as day
         FROM sessions WHERE updated_at >= ?
         ORDER BY day DESC`,
      )
      .all(tenDaysAgo) as { day: string }[]
    days = dbRows.map((r) => r.day)
  } finally {
    closeDb()
  }

  // Filter out today (still in progress) and already-summarized days
  const today = localDateStr(new Date())
  const unprocessed = days
    .filter((d) => d !== today && !existingSummaries.has(d))
    .slice(0, limit)

  if (unprocessed.length === 0) {
    log(`no unprocessed days found`)
    return []
  }

  log(`${unprocessed.length} unprocessed day(s): ${unprocessed.join(", ")}`)

  const results: DailySummaryResult[] = []
  for (const day of unprocessed) {
    const r = await summarizeDay(day, opts)
    results.push(r)
  }

  return results
}

// ============================================================================
// CLI command
// ============================================================================

export async function cmdSummarize(
  dateArg?: string,
  opts: { verbose?: boolean; project?: string } = {},
): Promise<void> {
  if (dateArg) {
    const result = await summarizeDay(dateArg, {
      verbose: true,
      projectFilter: opts.project,
    })

    if (result.skipped) {
      console.error(`Skipped ${dateArg}: ${result.reason}`)
      return
    }

    console.log(result.summary)
    console.error(`\nWrote: ${result.memoryFile}`)
  } else {
    const results = await summarizeUnprocessedDays({
      verbose: true,
      projectFilter: opts.project,
    })

    if (results.length === 0) {
      console.log("All recent days are already summarized.")
      return
    }

    for (const result of results) {
      if (result.skipped) {
        console.error(`${result.date}: skipped (${result.reason})`)
      } else {
        console.error(
          `${result.date}: ${result.sessionsCount} sessions → ${result.memoryFile}`,
        )
      }
    }

    const latest = results.find((r) => !r.skipped)
    if (latest?.summary) {
      console.log(`\n${"=".repeat(60)}`)
      console.log(`Daily Summary: ${latest.date}`)
      console.log(`${"=".repeat(60)}\n`)
      console.log(latest.summary)
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

function getSessionMemoryDir(): string {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd()
  const encodedPath = projectDir.replace(/\//g, "-")
  return path.join(
    os.homedir(),
    ".claude",
    "projects",
    encodedPath,
    "memory",
    "sessions",
  )
}

function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

function displayProject(projectPath: string): string {
  return projectPath.replace(/^-Users-beorn-/, "~/").replace(/-/g, "/")
}

function buildSessionIndex(sessions: SessionSummary[]): string {
  const lines = ["---", "## Sessions\n"]
  for (const s of sessions) {
    const title = s.title || "untitled"
    const cached = s.cached ? " (cached)" : ""
    lines.push(`- \`${s.shortId}\` ${s.time} — ${title}${cached}`)
  }
  return lines.join("\n") + "\n"
}

async function extractBeadsActivity(
  startMs: number,
  endMs: number,
  log: (msg: string) => void,
): Promise<string | null> {
  const db = getDb()
  try {
    const beadRows = db
      .prepare(
        `SELECT title, content, source_id FROM content
         WHERE content_type = 'bead' AND timestamp >= ? AND timestamp <= ?
         ORDER BY timestamp ASC LIMIT 20`,
      )
      .all(startMs, endMs) as {
      title: string
      content: string
      source_id: string
    }[]

    if (beadRows.length === 0) return null

    log(`${beadRows.length} beads active on this day`)

    const lines = ["### Beads Activity\n"]
    for (const r of beadRows) {
      const snippet =
        r.content.length > 500 ? r.content.slice(0, 500) + "..." : r.content
      lines.push(`**${r.title}** (${r.source_id})\n${snippet}\n`)
    }
    return lines.join("\n")
  } catch {
    return null
  } finally {
    closeDb()
  }
}

async function extractGitCommits(
  date: string,
  log: (msg: string) => void,
): Promise<string | null> {
  try {
    const proc = Bun.spawn(
      [
        "git",
        "log",
        `--after=${date}T00:00:00`,
        `--before=${date}T23:59:59`,
        "--oneline",
        "--no-merges",
        "-30",
      ],
      {
        cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const stdout = await new Response(proc.stdout).text()
    await proc.exited

    if (!stdout.trim()) return null

    const lines = stdout.trim().split("\n")
    log(`${lines.length} git commits on ${date}`)

    return `### Git Commits\n\n\`\`\`\n${stdout.trim()}\n\`\`\``
  } catch {
    return null
  }
}
