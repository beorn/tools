#!/usr/bin/env bun
/**
 * history.ts - Claude Code session history CLI
 *
 * Fast SQLite + FTS5 indexing for searching and managing Claude Code sessions.
 *
 * Usage:
 *   bun history [query] [options]     - Search content
 *   bun history index                 - Build/rebuild index
 *   bun history now/hour/day          - Activity summaries
 *   bun history list/show/stats       - Session management
 *   bun history writes/restore        - File recovery
 *
 * Examples:
 *   bun history "createRepo"              # Search all content
 *   bun history -q -s 1h "how do I"       # Questions only, last hour
 *   bun history -i p,m "refactor"         # Plans and messages
 *   bun history -g "function\\s+\\w+"     # Regex search
 */

import { Command } from "commander"
import * as path from "path"
import * as os from "os"
import * as fs from "fs"
import * as readline from "readline"
import {
  getDb,
  closeDb,
  PROJECTS_DIR,
  DB_PATH,
  ftsSearchWithSnippet,
  getActiveSessionsInWindow,
  getActivitySummary,
  findSimilarQueries,
  getIndexMeta,
  getAllSessionTitles,
  getSessionTitle,
  searchAll,
  type MessageSearchOptions,
} from "./lib/history/db"
import type { ContentType, ContentRecord, MessageRecord, JsonlRecord, WriteRecord } from "./lib/history/types"
import {
  rebuildIndex,
  findSessionFiles,
  extractTextContent,
} from "./lib/history/indexer"

// Time windows
const FIVE_MINUTES_MS = 5 * 60 * 1000
const ONE_HOUR_MS = 60 * 60 * 1000
const ONE_DAY_MS = 24 * 60 * 60 * 1000
const THIRTY_DAYS_MS = 30 * ONE_DAY_MS

// ============================================================================
// Parsing utilities
// ============================================================================

/**
 * Parse time string to timestamp (milliseconds since epoch).
 * Returns undefined if parsing fails.
 *
 * Supported formats:
 *   1h, 2h       - Hours ago
 *   1d, 7d       - Days ago
 *   1w, 2w       - Weeks ago
 *   30d          - 30 days ago
 *   today        - Since midnight today
 *   yesterday    - Since midnight yesterday
 */
function parseTime(timeStr: string): number | undefined {
  const now = Date.now()
  const str = timeStr.toLowerCase().trim()

  // Handle relative time formats: 1h, 2d, 3w
  const match = str.match(/^(\d+)([hdw])$/)
  if (match) {
    const amount = parseInt(match[1]!, 10)
    const unit = match[2]
    switch (unit) {
      case "h":
        return now - amount * ONE_HOUR_MS
      case "d":
        return now - amount * ONE_DAY_MS
      case "w":
        return now - amount * 7 * ONE_DAY_MS
    }
  }

  // Handle special keywords
  switch (str) {
    case "today": {
      const midnight = new Date()
      midnight.setHours(0, 0, 0, 0)
      return midnight.getTime()
    }
    case "yesterday": {
      const midnight = new Date()
      midnight.setHours(0, 0, 0, 0)
      return midnight.getTime() - ONE_DAY_MS
    }
  }

  return undefined
}

/**
 * Parse include string to content types.
 * Accepts comma-separated short codes or full names.
 *
 * Short codes: p=plan, m=message, s=summary, t=todo
 * Full names: plans, messages, summaries, todos
 */
function parseInclude(includeStr: string): ContentType[] {
  const types: ContentType[] = []
  const parts = includeStr.toLowerCase().split(",").map(s => s.trim()).filter(Boolean)

  const shortMap: Record<string, ContentType> = {
    p: "plan",
    m: "message",
    s: "summary",
    t: "todo",
  }

  const longMap: Record<string, ContentType> = {
    plans: "plan",
    plan: "plan",
    messages: "message",
    message: "message",
    summaries: "summary",
    summary: "summary",
    todos: "todo",
    todo: "todo",
  }

  for (const part of parts) {
    if (part.length === 1 && shortMap[part]) {
      const ct = shortMap[part]!
      if (!types.includes(ct)) types.push(ct)
    } else if (longMap[part]) {
      const ct = longMap[part]!
      if (!types.includes(ct)) types.push(ct)
    }
  }

  return types
}

/**
 * Match a project path against a glob pattern.
 */
function matchProjectGlob(encodedPath: string, pattern: string): boolean {
  const normalPath = encodedPath.replace(/-/g, "/")
  let regexStr = pattern
    .replace(/\*\*/g, "<<<GLOBSTAR>>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<<GLOBSTAR>>>/g, ".*")
    .replace(/\?/g, ".")
  const regex = new RegExp(regexStr, "i")
  return regex.test(normalPath)
}

// ============================================================================
// Formatting utilities
// ============================================================================

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString()
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  if (diff < 60000) return `${Math.round(diff / 1000)}s ago`
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`
  return `${Math.round(diff / 86400000)}d ago`
}

function displayProjectPath(encoded: string): string {
  return encoded.replace(/-/g, "/").replace(/^\//, "/")
}

function highlightMatch(text: string, regex: RegExp): string {
  const YELLOW = "\x1b[33m"
  const BOLD = "\x1b[1m"
  const RESET = "\x1b[0m"
  return text.replace(
    new RegExp(`(${regex.source})`, "gi"),
    `${BOLD}${YELLOW}$1${RESET}`,
  )
}

// ============================================================================
// Search options interface
// ============================================================================

interface SearchOptions {
  include?: string
  grep?: boolean
  question?: boolean
  response?: boolean
  tool?: string
  since?: string
  project?: string
  session?: string
  limit?: string
  json?: boolean
}

// ============================================================================
// Commands
// ============================================================================

async function cmdSearch(
  query: string | undefined,
  options: SearchOptions,
): Promise<void> {
  const {
    include,
    grep: regexMode,
    question,
    response,
    tool,
    since,
    project,
    session,
    limit: limitStr,
    json,
  } = options

  const limit = limitStr ? parseInt(limitStr, 10) : 10

  // Parse time filter
  let sinceTime: number | undefined
  if (since) {
    sinceTime = parseTime(since)
    if (sinceTime === undefined) {
      console.error(`Invalid time format: ${since}`)
      console.error("Valid formats: 1h, 1d, 1w, today, yesterday")
      process.exit(1)
    }
  } else {
    // Default: last 30 days
    sinceTime = Date.now() - THIRTY_DAYS_MS
  }

  // Parse content types
  let types: ContentType[] | undefined
  if (include) {
    types = parseInclude(include)
    if (types.length === 0) {
      console.error(`Invalid include types: ${include}`)
      console.error("Valid types: p,m,s,t or plans,messages,summaries,todos")
      process.exit(1)
    }
  }

  // Determine message type filter
  let messageType: "user" | "assistant" | undefined
  if (question && response) {
    // Both flags = no filter
    messageType = undefined
  } else if (question) {
    messageType = "user"
  } else if (response) {
    messageType = "assistant"
  }

  // If regex mode, delegate to grep
  if (regexMode) {
    if (!query) {
      console.error("Regex mode requires a search pattern")
      process.exit(1)
    }
    await cmdGrep(query, { project, limit })
    return
  }

  // Allow searching without query if filters are provided
  if (!query && !question && !response && !tool && !since) {
    printHelp()
    return
  }

  // Build search description
  const searchDesc: string[] = []
  if (query) searchDesc.push(`"${query}"`)
  if (types) {
    const typeNames = types.map(t => t === "message" ? "messages" : t + "s")
    searchDesc.push(`in ${typeNames.join(", ")}`)
  }
  if (messageType === "user") searchDesc.push("(questions only)")
  else if (messageType === "assistant") searchDesc.push("(responses only)")
  if (tool) searchDesc.push(`with tool ${tool}`)
  if (since) searchDesc.push(`since ${since}`)
  else searchDesc.push("last 30d")
  if (project) searchDesc.push(`in project ${project}`)
  if (session) searchDesc.push(`session ${session.slice(0, 8)}...`)

  const DIM = "\x1b[2m"
  const RESET = "\x1b[0m"
  console.log(`${DIM}Searching: ${searchDesc.join(" ")}${RESET}\n`)

  const startTime = Date.now()
  const db = getDb()

  // Determine which sources to search
  const searchMessages = !types || types.includes("message")
  const contentTypes = types?.filter(t => t !== "message") as ContentType[] | undefined
  const searchContent = !types || (contentTypes && contentTypes.length > 0)

  // Build search options
  const messageOpts: MessageSearchOptions = {
    limit,
    sinceTime,
    messageType,
    toolName: tool,
    sessionId: session,
  }

  // Handle project filter (glob matching)
  if (project) {
    // For now, use substring match but we could enhance to glob
    messageOpts.projectFilter = project.replace(/\*/g, "")
  }

  // Search messages table if needed
  let messageResults: { results: (MessageRecord & { snippet: string; project_path: string; rank: number })[]; total: number } = { results: [], total: 0 }
  if (searchMessages && query) {
    messageResults = ftsSearchWithSnippet(db, query, messageOpts)
  } else if (searchMessages && !query) {
    // No query but have filters - get recent messages
    const recentQuery = `
      SELECT m.*, s.project_path, '' as snippet, 0 as rank
      FROM messages m
      JOIN sessions s ON m.session_id = s.id
      WHERE 1=1
      ${sinceTime ? "AND m.timestamp >= ?" : ""}
      ${messageType ? "AND m.type = ?" : ""}
      ${tool ? "AND m.tool_name = ?" : ""}
      ${session ? "AND m.session_id = ?" : ""}
      ${project ? "AND s.project_path LIKE ?" : ""}
      ORDER BY m.timestamp DESC
      LIMIT ?
    `
    const params: (string | number)[] = []
    if (sinceTime) params.push(sinceTime)
    if (messageType) params.push(messageType)
    if (tool) params.push(tool)
    if (session) params.push(session)
    if (project) params.push(`%${project.replace(/\*/g, "")}%`)
    params.push(limit)

    const results = db.prepare(recentQuery).all(...params) as (MessageRecord & { snippet: string; project_path: string; rank: number })[]
    messageResults = { results, total: results.length }
  }

  // Search content table if needed (plans, summaries, todos)
  let contentResults: { results: (ContentRecord & { snippet: string; rank: number })[]; total: number } = { results: [], total: 0 }
  if (searchContent && contentTypes?.length !== 0 && query) {
    contentResults = searchAll(db, query, {
      limit,
      projectFilter: project?.replace(/\*/g, ""),
      types: contentTypes,
      sinceTime,
    })
  }

  const total = messageResults.total + contentResults.total
  const duration = Date.now() - startTime

  // Get session titles for display
  const sessionTitles = getAllSessionTitles()

  const BOLD = "\x1b[1m"
  const CYAN = "\x1b[36m"
  const YELLOW = "\x1b[33m"
  const GREEN = "\x1b[32m"
  const MAGENTA = "\x1b[35m"

  const typeIcons: Record<string, string> = {
    message: "💬",
    user: "👤",
    assistant: "🤖",
    plan: "📋",
    summary: "📝",
    todo: "✅",
  }
  const typeColors: Record<string, string> = {
    message: CYAN,
    user: CYAN,
    assistant: CYAN,
    plan: GREEN,
    summary: YELLOW,
    todo: MAGENTA,
  }

  if (json) {
    const allResults = [
      ...messageResults.results.map(r => ({
        contentType: "message" as const,
        sourceId: r.session_id,
        projectPath: r.project_path,
        title: sessionTitles.get(r.session_id) || null,
        timestamp: r.timestamp,
        snippet: r.snippet,
        rank: r.rank,
        type: r.type,
      })),
      ...contentResults.results.map(r => ({
        contentType: r.content_type,
        sourceId: r.source_id,
        projectPath: r.project_path,
        title: r.title,
        timestamp: r.timestamp,
        snippet: r.snippet,
        rank: r.rank,
      })),
    ]
    console.log(JSON.stringify({ query, total, durationMs: duration, results: allResults }, null, 2))
    closeDb()
    return
  }

  if (messageResults.results.length === 0 && contentResults.results.length === 0) {
    const queryPart = query ? ` for "${query}"` : ""
    console.log(`No matches found${queryPart} (searched in ${duration}ms)`)
    closeDb()
    return
  }

  const queryPart = query ? ` for "${query}"` : ""
  console.log(`Found ${total} matches${queryPart} in ${duration}ms:\n`)

  // Display message results (grouped by session)
  if (messageResults.results.length > 0) {
    const bySession = new Map<string, typeof messageResults.results>()
    for (const r of messageResults.results) {
      const key = r.session_id
      const existing = bySession.get(key) || []
      existing.push(r)
      bySession.set(key, existing)
    }

    for (const [sessionId, sessionResults] of bySession) {
      const first = sessionResults[0]!
      const displayProject = displayProjectPath(first.project_path)
      const relTime = formatRelativeTime(first.timestamp)
      const title = sessionTitles.get(sessionId)
      const sessionDisplay = title ? `${title} (${sessionId.slice(0, 8)})` : `${sessionId.slice(0, 8)}...`

      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
      console.log(`📁 ${sessionDisplay}  |  ${displayProject}  |  ${relTime}`)
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)

      for (const r of sessionResults.slice(0, 3)) {
        const time = formatTime(r.timestamp)
        const icon = typeIcons[r.type] || "💬"
        const role = r.type === "user" ? "User" : r.type === "assistant" ? "Assistant" : r.type
        console.log(`\n${icon} ${role} (${time}):`)
        console.log("─".repeat(60))
        if (r.snippet) {
          const highlighted = r.snippet
            .replace(/>>>/g, "\x1b[1m\x1b[33m")
            .replace(/<<</g, "\x1b[0m")
          console.log(highlighted)
        } else if (r.content) {
          // No snippet, show truncated content
          const content = r.content.slice(0, 300)
          console.log(content + (r.content.length > 300 ? "..." : ""))
        }
      }

      if (sessionResults.length > 3) {
        console.log(`\n  ... and ${sessionResults.length - 3} more matches in this session`)
      }
      console.log()
    }
  }

  // Display content results (plans, summaries, todos)
  if (contentResults.results.length > 0) {
    if (messageResults.results.length > 0) {
      console.log(`\n${"─".repeat(60)}`)
      console.log(`${BOLD}Other Content${RESET}\n`)
    }

    for (const r of contentResults.results) {
      const icon = typeIcons[r.content_type] || "📄"
      const color = typeColors[r.content_type] || ""
      const relTime = formatRelativeTime(r.timestamp)

      const titleDisplay = r.title || r.source_id.slice(0, 20)
      const projectPart = r.project_path ? ` ${DIM}${displayProjectPath(r.project_path)}${RESET}` : ""

      console.log(`${icon} ${color}[${r.content_type}]${RESET} ${BOLD}${titleDisplay}${RESET}${projectPart} ${DIM}(${relTime})${RESET}`)

      const highlighted = r.snippet
        .replace(/>>>/g, "\x1b[1m\x1b[33m")
        .replace(/<<</g, "\x1b[0m")
      const indentedSnippet = highlighted.split("\n").map(line => `   ${line}`).join("\n")
      console.log(indentedSnippet)
      console.log()
    }
  }

  const shownCount = messageResults.results.length + contentResults.results.length
  if (total > limit) {
    console.log(`${DIM}(showing ${shownCount} of ${total} matches, use -n/--limit <num> to see more)${RESET}`)
  } else if (shownCount === limit && total === limit) {
    // We hit the limit exactly - there may be more
    console.log(`${DIM}(showing ${shownCount} matches, use -n/--limit <num> to see more if needed)${RESET}`)
  }

  closeDb()
}

async function cmdIndex(options: { incremental?: boolean }): Promise<void> {
  console.log(options.incremental ? "Updating session index..." : "Building session index...")
  console.log("(indexing sessions from the last 30 days)\n")

  const db = getDb()

  let lastProgressUpdate = 0
  const result = await rebuildIndex(db, {
    incremental: options.incremental,
    onProgress: (progress) => {
      if (progress.filesProcessed - lastProgressUpdate >= 50) {
        lastProgressUpdate = progress.filesProcessed
        process.stdout.write(`\r${progress.filesProcessed} files, ${progress.messagesIndexed} messages...`)
      }
    },
  })
  process.stdout.write("\r" + " ".repeat(60) + "\r")

  console.log(`\n\n✓ Indexed content:`)
  console.log(`  ${result.messages.toLocaleString()} messages from ${result.files} session files`)
  if (result.writes > 0) console.log(`  ${result.writes.toLocaleString()} file writes`)
  if (result.summaries > 0) console.log(`  ${result.summaries.toLocaleString()} session summaries`)
  if (result.plans > 0) console.log(`  ${result.plans.toLocaleString()} plan files`)
  if (result.todos > 0) console.log(`  ${result.todos.toLocaleString()} todo lists`)
  if (result.skippedOld > 0) console.log(`  (skipped ${result.skippedOld} sessions older than 30 days)`)

  closeDb()
}

async function cmdNow(): Promise<void> {
  const db = getDb()
  const active = getActiveSessionsInWindow(db, FIVE_MINUTES_MS)

  if (active.length === 0) {
    console.log("No active sessions in the last 5 minutes")
    closeDb()
    return
  }

  const sessionTitles = getAllSessionTitles()
  console.log("Active sessions (last 5 minutes):\n")

  for (const session of active) {
    const displayProject = displayProjectPath(session.project_path)
    const relTime = formatRelativeTime(session.last_activity)
    const title = sessionTitles.get(session.session_id)
    const sessionDisplay = title ? `${title} (${session.session_id.slice(0, 8)})` : `${session.session_id.slice(0, 8)}...`
    console.log(`📁 ${displayProject}`)
    console.log(`   Session: ${sessionDisplay}`)
    console.log(`   Messages: ${session.message_count}  |  Last activity: ${relTime}`)
    console.log()
  }

  closeDb()
}

async function cmdHour(): Promise<void> {
  const db = getDb()
  const summary = getActivitySummary(db, ONE_HOUR_MS)

  if (summary.length === 0) {
    console.log("No activity in the last hour")
    closeDb()
    return
  }

  console.log("Activity summary (last hour):\n")

  let totalMessages = 0
  let totalSessions = 0

  for (const project of summary) {
    const displayProject = displayProjectPath(project.project_path)
    const relTime = formatRelativeTime(project.last_activity)
    console.log(`📁 ${displayProject}`)
    console.log(`   ${project.message_count} messages across ${project.session_count} sessions  |  Last: ${relTime}`)
    console.log()
    totalMessages += project.message_count
    totalSessions += project.session_count
  }

  console.log(`Total: ${totalMessages} messages across ${totalSessions} sessions in ${summary.length} projects`)
  closeDb()
}

async function cmdDay(): Promise<void> {
  const db = getDb()
  const summary = getActivitySummary(db, ONE_DAY_MS)

  if (summary.length === 0) {
    console.log("No activity today")
    closeDb()
    return
  }

  console.log("Activity summary (today):\n")

  let totalMessages = 0
  let totalSessions = 0

  for (const project of summary) {
    const displayProject = displayProjectPath(project.project_path)
    const relTime = formatRelativeTime(project.last_activity)
    console.log(`📁 ${displayProject}`)
    console.log(`   ${project.message_count} messages across ${project.session_count} sessions  |  Last: ${relTime}`)
    console.log()
    totalMessages += project.message_count
    totalSessions += project.session_count
  }

  console.log(`Total: ${totalMessages} messages across ${totalSessions} sessions in ${summary.length} projects`)
  closeDb()
}

async function cmdList(projectFilter?: string): Promise<void> {
  console.log("Scanning sessions...\n")

  interface SessionInfo {
    file: string
    sessionId: string
    project: string
    size: number
    mtime: Date
  }

  const sessions: SessionInfo[] = []

  for await (const sessionFile of findSessionFiles()) {
    const relativePath = path.relative(PROJECTS_DIR, sessionFile)
    const project = relativePath.split(path.sep)[0] || ""

    // Use glob matching if pattern contains wildcards, otherwise substring
    if (projectFilter) {
      if (projectFilter.includes("*")) {
        if (!matchProjectGlob(project, projectFilter)) continue
      } else if (!project.toLowerCase().includes(projectFilter.toLowerCase())) {
        continue
      }
    }

    const stats = fs.statSync(sessionFile)
    sessions.push({
      file: relativePath,
      sessionId: path.basename(sessionFile, ".jsonl"),
      project,
      size: stats.size,
      mtime: stats.mtime,
    })
  }

  sessions.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())

  const cutoffTime = Date.now() - THIRTY_DAYS_MS
  const recentSessions = sessions.filter(s => s.mtime.getTime() >= cutoffTime)
  const olderSessions = sessions.filter(s => s.mtime.getTime() < cutoffTime)

  const sessionTitles = getAllSessionTitles()

  if (recentSessions.length === 0) {
    console.log("No sessions in the last 30 days")
  } else {
    const maxNameLen = Math.min(40, Math.max(...recentSessions.map(s => {
      const title = sessionTitles.get(s.sessionId)
      return (title || displayProjectPath(s.project)).length
    })))

    for (const s of recentSessions) {
      const title = sessionTitles.get(s.sessionId)
      const displayProject = displayProjectPath(s.project)
      const date = s.mtime.toLocaleDateString() + " " + s.mtime.toLocaleTimeString()
      const size = formatBytes(s.size).padStart(8)
      const nameDisplay = (title || displayProject).slice(0, 40).padEnd(maxNameLen)
      console.log(`${nameDisplay}  ${s.sessionId}  ${size}  ${date}`)
    }
  }

  const recentTotalSize = recentSessions.reduce((sum, s) => sum + s.size, 0)
  console.log(`Showing ${recentSessions.length} sessions (${formatBytes(recentTotalSize)}) from the last 30 days`)

  if (olderSessions.length > 0) {
    const olderTotalSize = olderSessions.reduce((sum, s) => sum + s.size, 0)
    console.log(`\nNot shown: ${olderSessions.length} sessions (${formatBytes(olderTotalSize)}) older than 30 days`)
  }
}

async function cmdShow(sessionIdOrFile: string): Promise<void> {
  let sessionFile: string | undefined

  for await (const file of findSessionFiles()) {
    const basename = path.basename(file, ".jsonl")
    if (basename.startsWith(sessionIdOrFile) || file.includes(sessionIdOrFile)) {
      sessionFile = file
      break
    }
  }

  if (!sessionFile) {
    console.error(`Session not found: ${sessionIdOrFile}`)
    process.exit(1)
  }

  console.log(`Session: ${path.relative(PROJECTS_DIR, sessionFile)}\n`)

  const stats = fs.statSync(sessionFile)
  const relativePath = path.relative(PROJECTS_DIR, sessionFile)
  const project = relativePath.split(path.sep)[0] || "unknown"
  const sessionId = path.basename(sessionFile, ".jsonl")

  let messageCount = 0
  let firstTimestamp: string | undefined
  let lastTimestamp: string | undefined

  const fileStream = fs.createReadStream(sessionFile)
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity })

  for await (const line of rl) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line) as JsonlRecord
      if (record.timestamp) {
        if (!firstTimestamp) firstTimestamp = record.timestamp
        lastTimestamp = record.timestamp
      }
      if (record.type === "assistant" || record.type === "user") messageCount++
    } catch {
      // Skip malformed lines
    }
  }

  const db = getDb()
  const title = getSessionTitle(db, sessionId)

  console.log(`Session ID:    ${sessionId}`)
  if (title) console.log(`Title:         ${title}`)
  console.log(`Project:       ${displayProjectPath(project)}`)
  console.log(`Size:          ${formatBytes(stats.size)}`)
  console.log(`Messages:      ${messageCount}`)
  if (firstTimestamp) console.log(`Started:       ${new Date(firstTimestamp).toLocaleString()}`)
  if (lastTimestamp) console.log(`Last activity: ${new Date(lastTimestamp).toLocaleString()}`)

  const writes = db
    .prepare("SELECT file_path, timestamp, content_size FROM writes WHERE session_id = ? ORDER BY timestamp")
    .all(sessionId) as { file_path: string; timestamp: string; content_size: number }[]

  if (writes.length > 0) {
    console.log(`\nFile writes (${writes.length}):`)
    for (const w of writes.slice(0, 20)) {
      const time = new Date(w.timestamp).toLocaleTimeString()
      const size = formatBytes(w.content_size)
      const shortPath = w.file_path.replace(os.homedir(), "~")
      console.log(`  ${time}  ${size.padStart(8)}  ${shortPath}`)
    }
    if (writes.length > 20) console.log(`  ... and ${writes.length - 20} more writes`)
  }

  closeDb()
}

async function cmdStats(): Promise<void> {
  const db = getDb()

  const totalWrites = (db.prepare("SELECT COUNT(*) as count FROM writes").get() as { count: number }).count
  const uniqueFiles = (db.prepare("SELECT COUNT(DISTINCT file_path) as count FROM writes").get() as { count: number }).count
  const uniqueSessions = (db.prepare("SELECT COUNT(DISTINCT session_id) as count FROM writes").get() as { count: number }).count
  const totalWriteSize = (db.prepare("SELECT SUM(content_size) as total FROM writes").get() as { total: number }).total
  const storedContent = (db.prepare("SELECT COUNT(*) as count FROM writes WHERE content IS NOT NULL").get() as { count: number }).count

  const totalMessages = (db.prepare("SELECT COUNT(*) as count FROM messages").get() as { count: number }).count
  const totalSessions = (db.prepare("SELECT COUNT(*) as count FROM sessions").get() as { count: number }).count
  const userMessages = (db.prepare("SELECT COUNT(*) as count FROM messages WHERE type = 'user'").get() as { count: number }).count
  const assistantMessages = (db.prepare("SELECT COUNT(*) as count FROM messages WHERE type = 'assistant'").get() as { count: number }).count

  const lastRebuild = getIndexMeta(db, "last_rebuild")
  const rebuildDuration = getIndexMeta(db, "rebuild_duration_ms")

  console.log("Session Index Statistics\n")
  console.log("=== Messages (FTS5) ===")
  console.log(`Total sessions:          ${totalSessions.toLocaleString()}`)
  console.log(`Total messages indexed:  ${totalMessages.toLocaleString()}`)
  console.log(`  User messages:         ${userMessages.toLocaleString()}`)
  console.log(`  Assistant messages:    ${assistantMessages.toLocaleString()}`)
  console.log()
  console.log("=== File Writes ===")
  console.log(`Total writes indexed:    ${totalWrites.toLocaleString()}`)
  console.log(`Unique files:            ${uniqueFiles.toLocaleString()}`)
  console.log(`Unique sessions:         ${uniqueSessions.toLocaleString()}`)
  console.log(`Total content written:   ${formatBytes(totalWriteSize || 0)}`)
  console.log(`Writes with content:     ${storedContent.toLocaleString()} (${totalWrites > 0 ? ((storedContent / totalWrites) * 100).toFixed(1) : 0}%)`)
  console.log()
  console.log("=== Index Info ===")
  console.log(`Last rebuild:            ${lastRebuild ? new Date(lastRebuild).toLocaleString() : "never"}`)
  if (rebuildDuration) console.log(`Rebuild duration:        ${(parseInt(rebuildDuration, 10) / 1000).toFixed(1)}s`)
  console.log(`Database location:       ${DB_PATH}`)

  const topFiles = db.prepare(`
    SELECT file_path, COUNT(*) as count FROM writes
    GROUP BY file_path ORDER BY count DESC LIMIT 10
  `).all() as { file_path: string; count: number }[]

  if (topFiles.length > 0) {
    console.log("\nMost frequently written files:")
    for (const f of topFiles) {
      const shortPath = f.file_path.replace(os.homedir(), "~")
      console.log(`  ${f.count.toString().padStart(4)}x  ${shortPath}`)
    }
  }

  closeDb()
}

async function cmdGrep(
  pattern: string,
  options: { project?: string; limit?: number; context?: number },
): Promise<void> {
  const { project, limit = 50, context: contextLines = 2 } = options

  console.log(`Searching for "${pattern}" in session content...\n`)

  const regex = new RegExp(pattern, "i")
  interface GrepMatch {
    sessionFile: string
    sessionId: string
    timestamp: string
    type: string
    lineNumber: number
    context: string
    matchLine: string
  }
  const matches: GrepMatch[] = []
  let filesSearched = 0

  for await (const sessionFile of findSessionFiles()) {
    const relativePath = path.relative(PROJECTS_DIR, sessionFile)
    const projectName = relativePath.split(path.sep)[0] || ""

    if (project && !projectName.toLowerCase().includes(project.toLowerCase())) continue

    filesSearched++

    const fileContent = fs.readFileSync(sessionFile, "utf8")
    const lines = fileContent.split("\n")

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line?.trim()) continue

      try {
        const record = JSON.parse(line) as JsonlRecord
        const textContent = extractTextContent(record)
        if (!textContent || !regex.test(textContent)) continue

        const contentLines = textContent.split("\n")
        for (let j = 0; j < contentLines.length; j++) {
          const contentLine = contentLines[j]
          if (!contentLine || !regex.test(contentLine)) continue

          const startIdx = Math.max(0, j - contextLines)
          const endIdx = Math.min(contentLines.length, j + contextLines + 1)
          const contextText = contentLines.slice(startIdx, endIdx).join("\n")

          matches.push({
            sessionFile: relativePath,
            sessionId: record.sessionId || path.basename(sessionFile, ".jsonl"),
            timestamp: record.timestamp || "",
            type: record.type || "unknown",
            lineNumber: j + 1,
            context: contextText,
            matchLine: contentLine,
          })

          if (matches.length >= limit) break
        }
        if (matches.length >= limit) break
      } catch {
        // Skip malformed JSON
      }
    }
    if (matches.length >= limit) break
  }

  if (matches.length === 0) {
    console.log(`No matches found for "${pattern}" in ${filesSearched} session files.`)
    return
  }

  console.log(`Found ${matches.length} matches in ${filesSearched} files:\n`)

  const bySession = new Map<string, GrepMatch[]>()
  for (const match of matches) {
    const key = match.sessionId
    const existing = bySession.get(key) || []
    existing.push(match)
    bySession.set(key, existing)
  }

  for (const [sessionId, sessionMatches] of bySession) {
    const firstMatch = sessionMatches[0]!
    const displayProject = displayProjectPath(firstMatch.sessionFile.split(path.sep)[0] || "")
    const date = firstMatch.timestamp ? new Date(firstMatch.timestamp).toLocaleDateString() : "unknown date"

    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
    console.log(`📁 Session: ${sessionId.slice(0, 12)}...  |  Project: ${displayProject}  |  ${date}`)
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)

    for (const match of sessionMatches.slice(0, 5)) {
      const time = match.timestamp ? new Date(match.timestamp).toLocaleTimeString() : ""
      const role = match.type === "user" ? "👤 User" : match.type === "assistant" ? "🤖 Assistant" : match.type

      console.log(`\n${role} (${time}):`)
      console.log("─".repeat(60))
      console.log(highlightMatch(match.context, regex))
    }

    if (sessionMatches.length > 5) console.log(`\n  ... and ${sessionMatches.length - 5} more matches in this session`)
    console.log()
  }

  if (matches.length >= limit) console.log(`\n(showing first ${limit} matches, use -n/--limit for more)`)
}

async function cmdWrites(options: { date?: string }): Promise<void> {
  const db = getDb()

  let query = `SELECT file_path, timestamp, content_hash, content_size, session_id FROM writes`
  const params: string[] = []

  if (options.date) {
    query += ` WHERE timestamp LIKE ?`
    params.push(`${options.date}%`)
  }

  query += ` ORDER BY timestamp DESC LIMIT 100`

  const rows = db.prepare(query).all(...params) as WriteRecord[]

  if (rows.length === 0) {
    console.log(options.date ? `No writes found for date: ${options.date}` : "No writes found")
    closeDb()
    return
  }

  console.log(`Recent writes${options.date ? ` on ${options.date}` : ""}:\n`)

  for (const row of rows) {
    const date = new Date(row.timestamp).toLocaleString()
    const size = formatBytes(row.content_size)
    const shortPath = row.file_path.replace(os.homedir(), "~")
    console.log(`${date}  ${size.padStart(8)}  ${shortPath}`)
  }

  if (rows.length === 100) console.log("\n(showing first 100 results)")
  closeDb()
}

async function cmdRestore(filePath: string, options: { session?: string }): Promise<void> {
  const db = getDb()

  let query = `SELECT * FROM writes WHERE file_path LIKE ?`
  const params: string[] = [`%${filePath}`]

  if (options.session) {
    query += ` AND session_id LIKE ?`
    params.push(`${options.session}%`)
  }

  query += ` ORDER BY timestamp DESC`

  const rows = db.prepare(query).all(...params) as WriteRecord[]

  if (rows.length === 0) {
    console.log(`No writes found for: ${filePath}`)
    closeDb()
    return
  }

  const firstRow = rows[0]!
  if (rows.length === 1 || firstRow.content) {
    if (firstRow.content) {
      console.log(`// File: ${firstRow.file_path}`)
      console.log(`// Written: ${new Date(firstRow.timestamp).toLocaleString()}`)
      console.log(`// Session: ${firstRow.session_id}`)
      console.log(`// Hash: ${firstRow.content_hash}`)
      console.log(`// Size: ${formatBytes(firstRow.content_size)}`)
      console.log("// " + "=".repeat(70))
      console.log(firstRow.content)
    } else {
      console.log(`Content not stored (file was ${formatBytes(firstRow.content_size)}, exceeds 1MB limit)`)
      console.log(`Session file: ${firstRow.session_file}`)
      console.log(`Tool use ID: ${firstRow.tool_use_id}`)
      console.log("\nTo extract manually, search the session file for the tool_use_id")
    }
  } else {
    console.log(`Found ${rows.length} versions of files matching "${filePath}":\n`)

    for (let i = 0; i < Math.min(rows.length, 20); i++) {
      const row = rows[i]!
      const date = new Date(row.timestamp).toLocaleString()
      const hasContent = row.content ? "✓" : "✗"
      console.log(`${i + 1}. ${date}  [${row.content_hash}]  ${hasContent}content  session:${row.session_id.slice(0, 8)}`)
      if (row.file_path !== filePath) console.log(`   ${row.file_path}`)
    }

    console.log("\nTo restore a specific version, use:")
    console.log(`  bun history restore "${firstRow.file_path}" --session <session-id>`)
  }

  closeDb()
}

async function cmdWritesSearch(pattern: string): Promise<void> {
  const db = getDb()

  const sqlPattern = pattern.replace(/\*\*/g, "%").replace(/\*/g, "%").replace(/\?/g, "_")

  const rows = db.prepare(`
    SELECT file_path, timestamp, content_hash, content_size, session_id
    FROM writes WHERE file_path LIKE ? ORDER BY timestamp DESC
  `).all(`%${sqlPattern}%`) as WriteRecord[]

  if (rows.length === 0) {
    console.log(`No writes found matching: ${pattern}`)
    closeDb()
    return
  }

  console.log(`Found ${rows.length} writes matching "${pattern}":\n`)

  const byPath = new Map<string, WriteRecord[]>()
  for (const row of rows) {
    const existing = byPath.get(row.file_path) || []
    existing.push(row)
    byPath.set(row.file_path, existing)
  }

  for (const [fp, versions] of byPath) {
    console.log(`📄 ${fp}`)
    for (const v of versions.slice(0, 5)) {
      const date = new Date(v.timestamp).toLocaleString()
      const size = formatBytes(v.content_size)
      console.log(`   ${date}  ${size}  [${v.content_hash}]  session:${v.session_id.slice(0, 8)}`)
    }
    if (versions.length > 5) console.log(`   ... and ${versions.length - 5} more versions`)
    console.log()
  }

  closeDb()
}

// ============================================================================
// Help display
// ============================================================================

function printHelp(): void {
  const DIM = "\x1b[2m"
  const BOLD = "\x1b[1m"
  const RESET = "\x1b[0m"
  const CYAN = "\x1b[36m"
  const YELLOW = "\x1b[33m"

  console.log(`
${BOLD}History${RESET} - Search and manage Claude Code session history
`)

  // Show live stats
  try {
    const db = getDb()
    const totalSessions = (db.prepare("SELECT COUNT(*) as count FROM sessions").get() as { count: number }).count
    const totalMessages = (db.prepare("SELECT COUNT(*) as count FROM messages").get() as { count: number }).count
    const totalWrites = (db.prepare("SELECT COUNT(*) as count FROM writes").get() as { count: number }).count
    const activeNow = getActiveSessionsInWindow(db, FIVE_MINUTES_MS)

    console.log(`${BOLD}Index Stats${RESET}`)
    console.log(`  ${totalSessions.toLocaleString()} sessions  │  ${totalMessages.toLocaleString()} messages  │  ${totalWrites.toLocaleString()} file writes`)
    console.log()

    if (activeNow.length > 0) {
      console.log(`${BOLD}${CYAN}Active Now${RESET}`)
      for (const s of activeNow) {
        const project = displayProjectPath(s.project_path)
        const relTime = formatRelativeTime(s.last_activity)
        console.log(`  ${project} ${DIM}(${s.message_count} msgs, ${relTime})${RESET}`)
      }
      console.log()
    }

    closeDb()
  } catch {
    console.log(`${DIM}No index found. Run 'bun history index' to build.${RESET}`)
    console.log()
  }

  console.log(`${BOLD}Usage${RESET}
  bun history [query] [options]

${BOLD}Search Options${RESET}
  ${CYAN}-i, --include <types>${RESET}   Content types: p,m,s,t or plans,messages,summaries,todos
  ${CYAN}-g, --grep${RESET}              Regex mode (slower, scans files)
  ${CYAN}-q, --question${RESET}          Only user questions (type=user)
  ${CYAN}-r, --response${RESET}          Only assistant responses (type=assistant)
  ${CYAN}-t, --tool <name>${RESET}       Messages with specific tool (Write, Bash, etc.)
  ${CYAN}-s, --since <time>${RESET}      Time window: 1h, 1d, 1w, today, yesterday ${DIM}(default: 30d)${RESET}
  ${CYAN}-p, --project <glob>${RESET}    Project glob match (e.g., "*km*", "*/pim/*")
  ${CYAN}--session <id>${RESET}          Specific session
  ${CYAN}-n, --limit <num>${RESET}       Max results ${DIM}(default: 10)${RESET}
  ${CYAN}--json${RESET}                  JSON output

${BOLD}Commands${RESET}
  ${YELLOW}Activity${RESET}
    now                  Active sessions (last 5 minutes)
    hour                 Last hour summary
    day                  Today's summary

  ${YELLOW}Sessions${RESET}
    list [project]       List all sessions
    show <session-id>    Show session details
    stats                Full index statistics

  ${YELLOW}File Recovery${RESET}
    writes-search <pat>  Search writes by file path
    writes [--date D]    List recent writes
    restore <file>       Restore file content

  ${YELLOW}Indexing${RESET}
    index                Build/rebuild FTS5 index
    index --incremental  Only index new sessions

${BOLD}Examples${RESET}
  ${DIM}# Basic search (all content)${RESET}
  bun history "createRepo"

  ${DIM}# Questions only, last hour${RESET}
  bun history -q -s 1h "how do I"

  ${DIM}# All questions from today (no query needed)${RESET}
  bun history -q -s today

  ${DIM}# Plans and messages about refactoring${RESET}
  bun history -i p,m "refactor"

  ${DIM}# Regex search for function patterns${RESET}
  bun history -g "function\\s+\\w+Async"

  ${DIM}# All Write operations in km project today${RESET}
  bun history -t Write -p "*km*" -s 1d

  ${DIM}# Assistant responses mentioning errors, last week${RESET}
  bun history -r -s 1w "error"
`)
}

// ============================================================================
// CLI with Commander.js
// ============================================================================

const program = new Command()

program
  .name("history")
  .description("Search and manage Claude Code session history")
  .version("1.0.0")
  .allowUnknownOption(false)

// Default command: search
program
  .argument("[query]", "Search query")
  .option("-i, --include <types>", "Content types: p,m,s,t or plans,messages,summaries,todos")
  .option("-g, --grep", "Regex mode (slower, scans files)")
  .option("-q, --question", "Only user questions")
  .option("-r, --response", "Only assistant responses")
  .option("-t, --tool <name>", "Messages with specific tool")
  .option("-s, --since <time>", "Time window: 1h, 1d, 1w, today, yesterday (default: 30d)")
  .option("-p, --project <glob>", "Project glob match")
  .option("--session <id>", "Specific session")
  .option("-n, --limit <num>", "Max results (default: 10)")
  .option("--json", "JSON output")
  .action(async (query: string | undefined, options: SearchOptions) => {
    await cmdSearch(query, options)
  })

// Subcommands
program
  .command("index")
  .description("Build/rebuild FTS5 index")
  .option("--incremental", "Only index new sessions")
  .action(async (options: { incremental?: boolean }) => {
    await cmdIndex(options)
  })

program
  .command("now")
  .description("Active sessions (last 5 minutes)")
  .action(cmdNow)

program
  .command("hour")
  .description("Last hour summary")
  .action(cmdHour)

program
  .command("day")
  .description("Today's summary")
  .action(cmdDay)

program
  .command("list [project]")
  .description("List all sessions")
  .action(cmdList)

program
  .command("show <session-id>")
  .description("Show session details")
  .action(cmdShow)

program
  .command("stats")
  .description("Full index statistics")
  .action(cmdStats)

program
  .command("writes")
  .description("List recent writes")
  .option("--date <date>", "Filter by date")
  .action(cmdWrites)

program
  .command("writes-search <pattern>")
  .alias("ws")
  .description("Search writes by file path")
  .action(cmdWritesSearch)

program
  .command("restore <file>")
  .description("Restore file content")
  .option("--session <id>", "Specific session")
  .action(cmdRestore)

// Override help to use our custom format
program.configureHelp({
  helpWidth: 100,
})

// Handle no args - show help
program.hook("preAction", (thisCommand) => {
  // If no args and no options, show help
  const opts = thisCommand.opts()
  const args = thisCommand.args
  if (args.length === 0 && Object.keys(opts).length === 0 && thisCommand.name() === "history") {
    // Will be handled in action
  }
})

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  // If no args, show help
  if (argv.length === 0) {
    printHelp()
    return
  }

  try {
    await program.parseAsync(["node", "history", ...argv])
  } catch (err) {
    // Commander handles errors
    if (err instanceof Error && err.message.includes("unknown option")) {
      console.error(err.message)
      process.exit(1)
    }
    throw err
  }
}

if (import.meta.main) {
  main()
}
