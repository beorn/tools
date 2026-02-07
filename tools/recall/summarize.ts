/**
 * Daily session summary — replaces per-session LLM remember.
 *
 * Produces a single concise summary per day across all sessions,
 * with session refs for traceability. Triggered lazily when
 * unprocessed days are detected.
 */

import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { getDb, closeDb, PROJECTS_DIR } from "../lib/history/db"
import { getCheapModel } from "../lib/llm/types"
import { queryModel } from "../lib/llm/research"
import { isProviderAvailable } from "../lib/llm/providers"

// ============================================================================
// Types
// ============================================================================

interface DaySession {
  id: string
  title: string | null
  project: string
  messageCount: number
  createdAt: number
  updatedAt: number
}

interface DailySummaryResult {
  date: string
  sessionsCount: number
  summary: string | null
  memoryFile: string | null
  skipped: boolean
  reason?: string
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

## Lessons Learned
Approaches that failed, insights gained, patterns discovered. These should be genuinely novel — not obvious restatements.

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
  let sessions: DaySession[]
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

    const rows = db.prepare(query).all(...params) as SessionRecord[]
    sessions = rows.map((r) => ({
      id: r.id,
      title: r.title ?? null,
      project: r.project_path,
      messageCount: r.message_count,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }))
  } finally {
    closeDb()
  }

  if (sessions.length === 0) {
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

  // Filter out trivially short sessions (< 5KB JSONL).
  // Sub-agent transcripts are included since there's no parent_id to filter on;
  // the 30KB context limit and LLM deduplication handles overlap naturally.
  const meaningfulSessions = sessions.filter((s) => {
    const jsonlPath = findSessionJsonl(s.id)
    if (!jsonlPath) return false
    try {
      return fs.statSync(jsonlPath).size > 5_000
    } catch {
      return false
    }
  })
  log(
    `${sessions.length} total sessions, ${meaningfulSessions.length} meaningful (>5KB)`,
  )

  if (meaningfulSessions.length === 0) {
    log(`no meaningful sessions for ${date}`)
    return {
      date,
      sessionsCount: sessions.length,
      summary: null,
      memoryFile: null,
      skipped: true,
      reason: "no_meaningful_sessions",
    }
  }

  // Extract content from each meaningful session's transcript
  const sessionExtracts: string[] = []
  for (const session of meaningfulSessions) {
    const extract = extractSessionContent(session, log)
    if (extract) {
      sessionExtracts.push(extract)
    }
  }

  if (sessionExtracts.length === 0) {
    log(`no extractable content for ${date}`)
    return {
      date,
      sessionsCount: sessions.length,
      summary: null,
      memoryFile: null,
      skipped: true,
      reason: "no_content",
    }
  }

  // Also pull in any beads activity for the day
  const beadsContent = extractBeadsActivity(startMs, endMs, log)

  // Also pull in git commits for the day
  const gitContent = await extractGitCommits(date, log)

  // Build the full context for LLM
  const totalSessions = meaningfulSessions.length
  const totalMessages = meaningfulSessions.reduce(
    (s, sess) => s + (sess.messageCount || 0),
    0,
  )
  const projects = [...new Set(meaningfulSessions.map((s) => s.project))]

  let context = `# Daily Development Summary: ${date}\n\n`
  context += `${totalSessions} sessions, ${totalMessages} messages across ${projects.length} project(s): ${projects.map(displayProject).join(", ")}\n\n`
  context += sessionExtracts.join("\n\n")

  if (beadsContent) {
    context += `\n\n${beadsContent}`
  }
  if (gitContent) {
    context += `\n\n${gitContent}`
  }

  // Truncate to ~30KB for LLM context
  if (context.length > 30000) {
    context = context.slice(0, 30000) + "\n\n[...truncated]"
  }

  log(
    `LLM context: ${context.length} chars from ${sessionExtracts.length} sessions`,
  )

  // Check LLM availability
  const model = getCheapModel()
  if (!model || !isProviderAvailable(model.provider)) {
    log(`no LLM provider available`)
    return {
      date,
      sessionsCount: sessions.length,
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
      sessionsCount: sessions.length,
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
  const header = `# ${date}\n\n${totalSessions} sessions${msgInfo} | ${projects.map(displayProject).join(", ")}\n\n`
  const sessionsIndex = buildSessionIndex(meaningfulSessions)

  fs.writeFileSync(memoryFile, header + synthesis + "\n\n" + sessionsIndex)

  log(`wrote ${memoryFile}`)

  return {
    date,
    sessionsCount: sessions.length,
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
    // Get days with sessions in the last 10 days (local time)
    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000
    const rows = db
      .prepare(
        `SELECT DISTINCT date(updated_at / 1000, 'unixepoch', 'localtime') as day
         FROM sessions WHERE updated_at >= ?
         ORDER BY day DESC`,
      )
      .all(tenDaysAgo) as { day: string }[]
    days = rows.map((r) => r.day)
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
    const result = await summarizeDay(day, opts)
    results.push(result)
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
    // Summarize a specific day
    const result = await summarizeDay(dateArg, {
      verbose: true,
      projectFilter: opts.project,
    })

    if (result.skipped) {
      console.error(`Skipped ${dateArg}: ${result.reason}`)
      return
    }

    // Print the summary to stdout for review
    console.log(result.summary)
    console.error(`\nWrote: ${result.memoryFile}`)
  } else {
    // Summarize all unprocessed days
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

    // Print the most recent summary
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

function buildSessionIndex(sessions: DaySession[]): string {
  const lines = ["---", "## Sessions\n"]
  for (const s of sessions) {
    const time = new Date(s.createdAt).toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
    })
    const title = s.title || displayProject(s.project)
    const msgLabel = s.messageCount > 0 ? ` (${s.messageCount} msgs)` : ""
    lines.push(`- \`${s.id.slice(0, 8)}\` ${time} — ${title}${msgLabel}`)
  }
  return lines.join("\n") + "\n"
}

/**
 * Extract key content from a session's transcript.
 * Samples from beginning, middle, and end of the session.
 * Includes both text and tool_use content (file edits, commands).
 */
function extractSessionContent(
  session: DaySession,
  log: (msg: string) => void,
): string | null {
  const jsonlPath = findSessionJsonl(session.id)
  if (!jsonlPath) {
    log(`no JSONL found for ${session.id.slice(0, 8)}`)
    return null
  }

  try {
    const raw = fs.readFileSync(jsonlPath, "utf8")
    const lines = raw.split("\n").filter(Boolean)

    // Sample from beginning (first 40), middle (40 around center), end (last 40)
    // This captures initial goals, mid-session work, and final outcomes.
    const sampled = sampleLines(lines, 40)

    const messages: string[] = []
    let hasUserText = false

    for (const line of sampled) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entry = JSON.parse(line) as any
        if (entry.type !== "user" && entry.type !== "assistant") continue

        const parts: string[] = []
        const content = entry.message?.content
        if (!Array.isArray(content)) continue

        for (const block of content) {
          if (typeof block === "string") {
            if (block.length > 20) parts.push(block)
            continue
          }
          if (!block || typeof block !== "object") continue

          if (block.type === "text" && block.text && block.text.length > 20) {
            parts.push(truncStr(block.text, 1500))
            if (entry.type === "user") hasUserText = true
          } else if (block.type === "tool_use") {
            // Summarize tool calls — this is where the substance often is
            const summary = summarizeToolUse(block)
            if (summary) parts.push(summary)
          }
          // Skip tool_result (large file dumps, noise)
        }

        if (parts.length > 0) {
          messages.push(`[${entry.type}]: ${parts.join(" | ")}`)
        }
      } catch {
        // Skip unparseable lines
      }
    }

    // Detect likely sub-agent: no real user text input
    if (!hasUserText && messages.length > 0) {
      log(`${session.id.slice(0, 8)} likely sub-agent (no user text)`)
    }

    if (messages.length === 0) return null

    const shortId = session.id.slice(0, 8)
    const title = session.title || displayProject(session.project)
    const time = new Date(session.createdAt).toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
    })

    // Limit per-session extract to ~4KB
    let joined = messages.join("\n")
    if (joined.length > 4000) {
      joined = joined.slice(-4000)
    }

    const subAgentLabel = hasUserText ? "" : " [sub-agent]"
    return `### Session ${shortId} (${time}) — ${title}${subAgentLabel}\n\n${joined}`
  } catch {
    log(`error reading ${session.id.slice(0, 8)}`)
    return null
  }
}

/** Sample lines from beginning, middle, and end of array. */
function sampleLines(lines: string[], perSection: number): string[] {
  if (lines.length <= perSection * 3) return lines
  const start = lines.slice(0, perSection)
  const midPoint = Math.floor(lines.length / 2)
  const half = Math.floor(perSection / 2)
  const middle = lines.slice(midPoint - half, midPoint + half)
  const end = lines.slice(-perSection)
  return [...start, ...middle, ...end]
}

/** Truncate text to max length. */
function truncStr(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "..." : text
}

/** Summarize a tool_use block into a brief description. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function summarizeToolUse(block: any): string | null {
  const name = block.name as string | undefined
  const input = block.input as Record<string, unknown> | undefined
  if (!name || !input) return null

  switch (name) {
    case "Edit":
    case "MultiEdit":
      return `[Edit] ${fileBasename(input.file_path as string)}`
    case "Write":
      return `[Write] ${fileBasename(input.file_path as string)}`
    case "Read":
      return null // too noisy
    case "Bash": {
      const cmd = input.command as string | undefined
      return cmd ? `[Bash] ${truncStr(cmd, 120)}` : null
    }
    case "Grep":
      return `[Search] "${truncStr(String(input.pattern || ""), 50)}"`
    case "Glob":
      return null // too noisy
    case "Task":
      return `[Task] ${truncStr(String(input.description || input.prompt || ""), 80)}`
    default:
      return `[${name}]`
  }
}

function fileBasename(filePath: string | undefined): string {
  if (!filePath) return "?"
  return filePath.split("/").pop() || filePath
}

/**
 * Find JSONL file for a session ID using the DB's jsonl_path.
 */
function findSessionJsonl(sessionId: string): string | null {
  const db = getDb()
  try {
    const row = db
      .prepare("SELECT jsonl_path FROM sessions WHERE id = ?")
      .get(sessionId) as { jsonl_path: string } | undefined

    if (!row?.jsonl_path) return null

    // jsonl_path in DB is relative to PROJECTS_DIR
    const fullPath = row.jsonl_path.startsWith("/")
      ? row.jsonl_path
      : path.join(PROJECTS_DIR, row.jsonl_path)

    return fs.existsSync(fullPath) ? fullPath : null
  } catch {
    return null
  } finally {
    closeDb()
  }
}

/**
 * Extract beads (issues) activity for the day from the indexed content.
 */
function extractBeadsActivity(
  startMs: number,
  endMs: number,
  log: (msg: string) => void,
): string | null {
  const db = getDb()
  try {
    const rows = db
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

    if (rows.length === 0) return null

    log(`${rows.length} beads active on this day`)

    const lines = ["### Beads Activity\n"]
    for (const r of rows) {
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

/**
 * Extract git commits for the day.
 */
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
