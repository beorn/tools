#!/usr/bin/env bun
/**
 * history.ts - Claude Code session history CLI
 *
 * Fast SQLite + FTS5 indexing for searching and managing Claude Code sessions.
 *
 * Commands:
 *   index                 - Build/rebuild session index (FTS5)
 *   fts <query>           - Fast full-text search (<100ms)
 *   now                   - Active sessions in last 5 minutes
 *   hour                  - Last hour activity summary
 *   day                   - Today's activity summary
 *   similar <query>       - Find similar past questions
 *   list [project]        - List all sessions
 *   show <session-id>     - Show session details
 *   grep <pattern>        - Search ALL session content (sequential scan)
 *   search <pattern>      - Search indexed writes by file path
 *   writes [--date D]     - List recent writes
 *   restore <file-path>   - Restore file content from session
 *   stats                 - Show index statistics
 */

import * as path from "path"
import * as os from "os"
import * as fs from "fs"
import * as readline from "readline"
import { Glob } from "bun"
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
  MAX_CONTENT_SIZE,
  getAllSessionTitles,
  refreshSessionTitles,
  getSessionTitle,
  searchAll,
} from "./lib/history/db"
import type { ContentType } from "./lib/history/types"
import {
  rebuildIndex,
  findSessionFiles,
  extractTextContent,
  projectPathFromRelative,
} from "./lib/history/indexer"
import type { JsonlRecord, WriteRecord } from "./lib/history/types"

// Time windows
const FIVE_MINUTES_MS = 5 * 60 * 1000
const ONE_HOUR_MS = 60 * 60 * 1000
const ONE_DAY_MS = 24 * 60 * 60 * 1000
const THIRTY_DAYS_MS = 30 * ONE_DAY_MS

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString()
}

function formatDateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString()
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
// Commands
// ============================================================================

async function cmdIndex(options: { incremental?: boolean }): Promise<void> {
  console.log(options.incremental ? "Updating session index..." : "Building session index...")
  console.log("(indexing sessions from the last 30 days)\n")

  const db = getDb()

  let lastProgressUpdate = 0
  const result = await rebuildIndex(db, {
    incremental: options.incremental,
    onProgress: (progress) => {
      // Only update progress every 50 files to reduce output
      if (progress.filesProcessed - lastProgressUpdate >= 50) {
        lastProgressUpdate = progress.filesProcessed
        process.stdout.write(`\r${progress.filesProcessed} files, ${progress.messagesIndexed} messages...`)
      }
    },
  })
  process.stdout.write("\r" + " ".repeat(60) + "\r") // Clear progress line

  console.log(`\n\n✓ Indexed content:`)
  console.log(`  ${result.messages.toLocaleString()} messages from ${result.files} session files`)
  if (result.writes > 0) {
    console.log(`  ${result.writes.toLocaleString()} file writes`)
  }
  if (result.summaries > 0) {
    console.log(`  ${result.summaries.toLocaleString()} session summaries`)
  }
  if (result.plans > 0) {
    console.log(`  ${result.plans.toLocaleString()} plan files`)
  }
  if (result.todos > 0) {
    console.log(`  ${result.todos.toLocaleString()} todo lists`)
  }
  if (result.skippedOld > 0) {
    console.log(`  (skipped ${result.skippedOld} sessions older than 30 days)`)
  }

  closeDb()
}

async function cmdFts(
  query: string,
  options: { limit?: number; project?: string; json?: boolean },
): Promise<void> {
  const { limit = 20, project, json } = options
  const startTime = Date.now()

  const db = getDb()
  const { results, total } = ftsSearchWithSnippet(db, query, {
    limit,
    projectFilter: project,
  })
  const duration = Date.now() - startTime

  // Get session titles for display
  const sessionTitles = getAllSessionTitles()

  if (json) {
    console.log(JSON.stringify({
      query,
      total,
      durationMs: duration,
      results: results.map(r => ({
        sessionId: r.session_id,
        sessionTitle: sessionTitles.get(r.session_id) || null,
        projectPath: r.project_path,
        type: r.type,
        timestamp: r.timestamp,
        snippet: r.snippet,
        rank: r.rank,
      })),
    }, null, 2))
    closeDb()
    return
  }

  if (results.length === 0) {
    console.log(`No matches found for "${query}" (searched in ${duration}ms)`)
    closeDb()
    return
  }

  console.log(`Found ${total} matches for "${query}" in ${duration}ms:\n`)

  // Group by session for cleaner output
  const bySession = new Map<string, typeof results>()
  for (const r of results) {
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
      const role = r.type === "user" ? "👤 User" : r.type === "assistant" ? "🤖 Assistant" : r.type
      console.log(`\n${role} (${time}):`)
      console.log("─".repeat(60))
      // Snippet has >>> and <<< markers for highlighting
      const highlighted = r.snippet
        .replace(/>>>/g, "\x1b[1m\x1b[33m")
        .replace(/<<</g, "\x1b[0m")
      console.log(highlighted)
    }

    if (sessionResults.length > 3) {
      console.log(`\n  ... and ${sessionResults.length - 3} more matches in this session`)
    }
    console.log()
  }

  if (total > limit) {
    console.log(`(showing ${results.length} of ${total} matches, use --limit N for more)`)
  }

  closeDb()
}

/**
 * Unified search across all content types: messages, plans, summaries, todos
 */
async function cmdFind(
  query: string,
  options: { limit?: number; project?: string; type?: string; json?: boolean },
): Promise<void> {
  const { limit = 30, project, type, json } = options
  const startTime = Date.now()

  const db = getDb()

  // Parse type filter
  let types: ContentType[] | undefined
  if (type) {
    types = type.split(",").map(t => t.trim()) as ContentType[]
  }

  const { results, total } = searchAll(db, query, {
    limit,
    projectFilter: project,
    types,
  })
  const duration = Date.now() - startTime

  // Get session titles for display
  const sessionTitles = getAllSessionTitles()

  if (json) {
    console.log(JSON.stringify({
      query,
      total,
      durationMs: duration,
      results: results.map(r => ({
        contentType: r.content_type,
        sourceId: r.source_id,
        projectPath: r.project_path,
        title: r.title || sessionTitles.get(r.source_id) || null,
        timestamp: r.timestamp,
        snippet: r.snippet,
        rank: r.rank,
      })),
    }, null, 2))
    closeDb()
    return
  }

  if (results.length === 0) {
    console.log(`No matches found for "${query}" (searched in ${duration}ms)`)
    closeDb()
    return
  }

  const DIM = "\x1b[2m"
  const BOLD = "\x1b[1m"
  const RESET = "\x1b[0m"
  const CYAN = "\x1b[36m"
  const YELLOW = "\x1b[33m"
  const GREEN = "\x1b[32m"
  const MAGENTA = "\x1b[35m"

  console.log(`Found ${total} matches for "${query}" in ${duration}ms:\n`)

  // Group by content type for cleaner output
  const typeIcons: Record<string, string> = {
    message: "💬",
    plan: "📋",
    summary: "📝",
    todo: "✅",
  }
  const typeColors: Record<string, string> = {
    message: CYAN,
    plan: GREEN,
    summary: YELLOW,
    todo: MAGENTA,
  }

  for (const r of results) {
    const icon = typeIcons[r.content_type] || "📄"
    const color = typeColors[r.content_type] || ""
    const relTime = formatRelativeTime(r.timestamp)

    // Build title display
    let titleDisplay = r.title
    if (!titleDisplay && r.content_type === "message") {
      titleDisplay = sessionTitles.get(r.source_id) || null
    }
    const titlePart = titleDisplay ? `${BOLD}${titleDisplay}${RESET}` : `${DIM}${r.source_id.slice(0, 8)}${RESET}`

    // Project path for messages
    const projectPart = r.project_path ? ` ${DIM}${displayProjectPath(r.project_path)}${RESET}` : ""

    console.log(`${icon} ${color}[${r.content_type}]${RESET} ${titlePart}${projectPart} ${DIM}(${relTime})${RESET}`)

    // Show snippet
    const highlighted = r.snippet
      .replace(/>>>/g, "\x1b[1m\x1b[33m")
      .replace(/<<</g, "\x1b[0m")
    const indentedSnippet = highlighted.split("\n").map(line => `   ${line}`).join("\n")
    console.log(indentedSnippet)
    console.log()
  }

  if (total > limit) {
    console.log(`${DIM}(showing ${results.length} of ${total} matches, use --limit N for more)${RESET}`)
  }

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

  // Get session titles
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

async function cmdSimilar(query: string, options: { limit?: number }): Promise<void> {
  const { limit = 5 } = options
  const db = getDb()
  const results = findSimilarQueries(db, query, { limit })

  if (results.length === 0) {
    console.log(`No similar queries found for "${query}"`)
    closeDb()
    return
  }

  console.log(`Similar past queries for "${query}":\n`)

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!
    const displayProject = displayProjectPath(r.project_path)
    const relTime = formatRelativeTime(r.timestamp)

    console.log(`${i + 1}. ${displayProject} (${relTime})`)
    console.log(`   📝 User: ${(r.user_content || "").slice(0, 200)}${(r.user_content?.length || 0) > 200 ? "..." : ""}`)
    if (r.assistant_content) {
      console.log(`   🤖 Response: ${r.assistant_content.slice(0, 200)}${r.assistant_content.length > 200 ? "..." : ""}`)
    }
    console.log()
  }

  closeDb()
}

// ============================================================================
// Legacy commands (backwards compatible)
// ============================================================================

interface SessionInfo {
  file: string
  sessionId: string
  project: string
  size: number
  mtime: Date
  messageCount: number
  firstTimestamp?: string
  lastTimestamp?: string
}

async function getSessionInfo(filePath: string): Promise<SessionInfo> {
  const stats = fs.statSync(filePath)
  const relativePath = path.relative(PROJECTS_DIR, filePath)
  const project = relativePath.split(path.sep)[0] || "unknown"

  let messageCount = 0
  let firstTimestamp: string | undefined
  let lastTimestamp: string | undefined
  let sessionId = path.basename(filePath, ".jsonl")

  const fileStream = fs.createReadStream(filePath)
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  })

  for await (const line of rl) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line) as JsonlRecord
      if (record.sessionId) sessionId = record.sessionId
      if (record.timestamp) {
        if (!firstTimestamp) firstTimestamp = record.timestamp
        lastTimestamp = record.timestamp
      }
      if (record.type === "assistant" || record.type === "user") {
        messageCount++
      }
    } catch {
      // Skip malformed lines
    }
  }

  return {
    file: relativePath,
    sessionId,
    project,
    size: stats.size,
    mtime: stats.mtime,
    messageCount,
    firstTimestamp,
    lastTimestamp,
  }
}

async function cmdList(projectFilter?: string): Promise<void> {
  console.log("Scanning sessions...\n")

  const sessions: SessionInfo[] = []

  for await (const sessionFile of findSessionFiles()) {
    const relativePath = path.relative(PROJECTS_DIR, sessionFile)
    const project = relativePath.split(path.sep)[0] || ""

    if (projectFilter && !project.toLowerCase().includes(projectFilter.toLowerCase())) {
      continue
    }

    const stats = fs.statSync(sessionFile)
    sessions.push({
      file: relativePath,
      sessionId: path.basename(sessionFile, ".jsonl"),
      project,
      size: stats.size,
      mtime: stats.mtime,
      messageCount: 0,
      firstTimestamp: undefined,
      lastTimestamp: undefined,
    })
  }

  // Sort by modification time, newest first
  sessions.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())

  // Split into recent (<30 days) and older (>30 days)
  const cutoffTime = Date.now() - THIRTY_DAYS_MS
  const recentSessions = sessions.filter(s => s.mtime.getTime() >= cutoffTime)
  const olderSessions = sessions.filter(s => s.mtime.getTime() < cutoffTime)

  // Get session titles
  const sessionTitles = getAllSessionTitles()

  // Display recent sessions (flat list, sorted by recency)
  if (recentSessions.length === 0) {
    console.log("No sessions in the last 30 days")
  } else {
    const DIM = "\x1b[2m"
    const RESET = "\x1b[0m"

    // Calculate column widths for alignment
    const maxNameLen = Math.min(40, Math.max(...recentSessions.map(s => {
      const title = sessionTitles.get(s.sessionId)
      return (title || displayProjectPath(s.project)).length
    })))

    for (const s of recentSessions) {
      const title = sessionTitles.get(s.sessionId)
      const displayProject = displayProjectPath(s.project)
      const date = s.mtime.toLocaleDateString() + " " + s.mtime.toLocaleTimeString()
      const size = formatBytes(s.size).padStart(8)

      // Name: title if available, otherwise short project path
      const nameDisplay = (title || displayProject).slice(0, 40).padEnd(maxNameLen)

      // Single line: name  id  size  date
      console.log(`${nameDisplay}  ${s.sessionId}  ${size}  ${date}`)
    }
  }

  // Summary line for recent sessions
  const recentTotalSize = recentSessions.reduce((sum, s) => sum + s.size, 0)
  console.log(`Showing ${recentSessions.length} sessions (${formatBytes(recentTotalSize)}) from the last 30 days`)

  // Summary of older sessions
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

  const info = await getSessionInfo(sessionFile)
  const displayProject = displayProjectPath(info.project)

  // Get session title
  const db = getDb()
  const title = getSessionTitle(db, info.sessionId)

  console.log(`Session ID:    ${info.sessionId}`)
  if (title) {
    console.log(`Title:         ${title}`)
  }
  console.log(`Project:       ${displayProject}`)
  console.log(`Size:          ${formatBytes(info.size)}`)
  console.log(`Messages:      ${info.messageCount}`)
  if (info.firstTimestamp) {
    console.log(`Started:       ${new Date(info.firstTimestamp).toLocaleString()}`)
  }
  if (info.lastTimestamp) {
    console.log(`Last activity: ${new Date(info.lastTimestamp).toLocaleString()}`)
  }

  // Show file writes in this session
  const writes = db
    .prepare(
      "SELECT file_path, timestamp, content_size FROM writes WHERE session_id = ? ORDER BY timestamp",
    )
    .all(info.sessionId) as { file_path: string; timestamp: string; content_size: number }[]

  if (writes.length > 0) {
    console.log(`\nFile writes (${writes.length}):`)
    for (const w of writes.slice(0, 20)) {
      const time = new Date(w.timestamp).toLocaleTimeString()
      const size = formatBytes(w.content_size)
      const shortPath = w.file_path.replace(os.homedir(), "~")
      console.log(`  ${time}  ${size.padStart(8)}  ${shortPath}`)
    }
    if (writes.length > 20) {
      console.log(`  ... and ${writes.length - 20} more writes`)
    }
  }

  closeDb()
}

async function cmdSearch(pattern: string): Promise<void> {
  const db = getDb()

  // Convert glob pattern to SQL LIKE pattern
  const sqlPattern = pattern
    .replace(/\*\*/g, "%")
    .replace(/\*/g, "%")
    .replace(/\?/g, "_")

  const rows = db
    .prepare(`
      SELECT file_path, timestamp, content_hash, content_size, session_id
      FROM writes
      WHERE file_path LIKE ?
      ORDER BY timestamp DESC
    `)
    .all(`%${sqlPattern}%`) as WriteRecord[]

  if (rows.length === 0) {
    console.log(`No writes found matching: ${pattern}`)
    closeDb()
    return
  }

  console.log(`Found ${rows.length} writes matching "${pattern}":\n`)

  // Group by file path
  const byPath = new Map<string, WriteRecord[]>()
  for (const row of rows) {
    const existing = byPath.get(row.file_path) || []
    existing.push(row)
    byPath.set(row.file_path, existing)
  }

  for (const [filePath, versions] of byPath) {
    console.log(`📄 ${filePath}`)
    for (const v of versions.slice(0, 5)) {
      const date = new Date(v.timestamp).toLocaleString()
      const size = formatBytes(v.content_size)
      console.log(`   ${date}  ${size}  [${v.content_hash}]  session:${v.session_id.slice(0, 8)}`)
    }
    if (versions.length > 5) {
      console.log(`   ... and ${versions.length - 5} more versions`)
    }
    console.log()
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

    if (project && !projectName.toLowerCase().includes(project.toLowerCase())) {
      continue
    }

    filesSearched++

    const fileContent = fs.readFileSync(sessionFile, "utf8")
    const lines = fileContent.split("\n")

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line?.trim()) continue

      try {
        const record = JSON.parse(line) as JsonlRecord

        const textContent = extractTextContent(record)
        if (!textContent) continue

        if (!regex.test(textContent)) continue

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

  // Group by session
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

      const highlighted = highlightMatch(match.context, regex)
      console.log(highlighted)
    }

    if (sessionMatches.length > 5) {
      console.log(`\n  ... and ${sessionMatches.length - 5} more matches in this session`)
    }
    console.log()
  }

  if (matches.length >= limit) {
    console.log(`\n(showing first ${limit} matches, use --limit N for more)`)
  }
}

async function cmdWrites(dateFilter?: string): Promise<void> {
  const db = getDb()

  let query = `
    SELECT file_path, timestamp, content_hash, content_size, session_id
    FROM writes
  `
  const params: string[] = []

  if (dateFilter) {
    query += ` WHERE timestamp LIKE ?`
    params.push(`${dateFilter}%`)
  }

  query += ` ORDER BY timestamp DESC LIMIT 100`

  const rows = db.prepare(query).all(...params) as WriteRecord[]

  if (rows.length === 0) {
    console.log(dateFilter ? `No writes found for date: ${dateFilter}` : "No writes found")
    closeDb()
    return
  }

  console.log(`Recent writes${dateFilter ? ` on ${dateFilter}` : ""}:\n`)

  for (const row of rows) {
    const date = new Date(row.timestamp).toLocaleString()
    const size = formatBytes(row.content_size)
    const shortPath = row.file_path.replace(os.homedir(), "~")
    console.log(`${date}  ${size.padStart(8)}  ${shortPath}`)
  }

  if (rows.length === 100) {
    console.log("\n(showing first 100 results)")
  }

  closeDb()
}

async function cmdRestore(filePath: string, sessionId?: string): Promise<void> {
  const db = getDb()

  let query = `SELECT * FROM writes WHERE file_path LIKE ?`
  const params: string[] = [`%${filePath}`]

  if (sessionId) {
    query += ` AND session_id LIKE ?`
    params.push(`${sessionId}%`)
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
      if (row.file_path !== filePath) {
        console.log(`   ${row.file_path}`)
      }
    }

    console.log("\nTo restore a specific version, use:")
    console.log(`  bun history restore "${firstRow.file_path}" --session <session-id>`)
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

  // New message stats
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
  if (rebuildDuration) {
    console.log(`Rebuild duration:        ${(parseInt(rebuildDuration, 10) / 1000).toFixed(1)}s`)
  }
  console.log(`Database location:       ${DB_PATH}`)

  // Top 10 most written files
  const topFiles = db.prepare(`
    SELECT file_path, COUNT(*) as count
    FROM writes
    GROUP BY file_path
    ORDER BY count DESC
    LIMIT 10
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

function printHelp(): void {
  const DIM = "\x1b[2m"
  const BOLD = "\x1b[1m"
  const RESET = "\x1b[0m"
  const CYAN = "\x1b[36m"
  const YELLOW = "\x1b[33m"

  console.log(`
${BOLD}History${RESET} - Search and manage Claude Code session history
`)

  // Try to show live stats
  try {
    const db = getDb()

    // Get stats
    const totalSessions = (db.prepare("SELECT COUNT(*) as count FROM sessions").get() as { count: number }).count
    const totalMessages = (db.prepare("SELECT COUNT(*) as count FROM messages").get() as { count: number }).count
    const totalWrites = (db.prepare("SELECT COUNT(*) as count FROM writes").get() as { count: number }).count

    // Get recent activity (last 24 hours)
    const oneDayAgo = Date.now() - ONE_DAY_MS
    const recentSessions = db.prepare(`
      SELECT s.project_path, s.id as session_id, s.updated_at as last_activity, s.message_count as msg_count
      FROM sessions s
      WHERE s.updated_at > ?
      ORDER BY s.updated_at DESC
      LIMIT 5
    `).all(oneDayAgo) as { project_path: string; session_id: string; last_activity: number; msg_count: number }[]

    // Get active now (last 5 min)
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

    if (recentSessions.length > 0) {
      // Get session titles
      const sessionTitles = getAllSessionTitles()

      console.log(`${BOLD}Recent Sessions${RESET} ${DIM}(last 24h)${RESET}`)
      for (const s of recentSessions) {
        const project = displayProjectPath(s.project_path)
        const relTime = formatRelativeTime(s.last_activity)
        const title = sessionTitles.get(s.session_id)
        const sessionDisplay = title
          ? `${CYAN}${title}${RESET} ${DIM}(${s.session_id.slice(0, 8)})${RESET}`
          : s.session_id.slice(0, 8)
        console.log(`  ${sessionDisplay}  ${project} ${DIM}(${s.msg_count} msgs, ${relTime})${RESET}`)
      }
      console.log()
    }

    closeDb()
  } catch {
    console.log(`${DIM}No index found. Run 'bun history index' to build.${RESET}`)
    console.log()
  }

  console.log(`${BOLD}Commands${RESET}

  ${YELLOW}Search (find anything)${RESET}
    find <query>         Search ALL content: messages, plans, todos, summaries
    fts <query>          Search session messages only
    similar <query>      Find similar past questions
    grep <pattern>       Regex search (slow, no index needed)

  ${YELLOW}Activity${RESET}
    now                  Active sessions (last 5 minutes)
    hour                 Last hour summary
    day                  Today's summary

  ${YELLOW}Sessions${RESET}
    list [project]       List all sessions
    show <session-id>    Show session details
    stats                Full index statistics

  ${YELLOW}File Recovery${RESET}
    search <pattern>     Search writes by file path
    writes [--date D]    List recent writes
    restore <file>       Restore file content

  ${YELLOW}Indexing${RESET}
    index                Build/rebuild FTS5 index
    index --incremental  Only index new sessions

${BOLD}Options${RESET}
  --limit <n>          Max results (default: 30)
  --project <name>     Filter by project
  --type <types>       Filter by type: message,plan,summary,todo
  --json               Output as JSON

${BOLD}Examples${RESET}
  ${DIM}# Find anything${RESET}
  bun history find "test infrastructure"
  bun history find "refactor" --type plan,summary

  ${DIM}# Search sessions only${RESET}
  bun history fts "createBoard" --project km

  ${DIM}# Check what's happening${RESET}
  bun history now

  ${DIM}# Recover lost work${RESET}
  bun history restore src/index.ts
`)
}

// ============================================================================
// Main entry point
// ============================================================================

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = argv
  const command = args[0]

  function getArg(name: string): string | undefined {
    const idx = args.indexOf(name)
    if (idx === -1) return undefined
    return args[idx + 1]
  }

  function hasFlag(name: string): boolean {
    return args.includes(name)
  }

  switch (command) {
    case "index":
    case "rebuild":
      await cmdIndex({ incremental: hasFlag("--incremental") })
      break

    case "find":
    case "f": {
      if (!args[1]) {
        console.error("Usage: bun history find <query>")
        process.exit(1)
      }
      // Join all non-flag arguments as the query
      const findQuery = args.slice(1).filter((a, i, arr) => {
        if (a.startsWith("--")) return false
        if (i > 0 && ["--limit", "--project", "--type"].includes(arr[i - 1]!)) return false
        return true
      }).join(" ")
      await cmdFind(findQuery, {
        limit: getArg("--limit") ? parseInt(getArg("--limit")!, 10) : undefined,
        project: getArg("--project"),
        type: getArg("--type"),
        json: hasFlag("--json"),
      })
      break
    }

    case "fts": {
      if (!args[1]) {
        console.error("Usage: bun history fts <query>")
        process.exit(1)
      }
      // Join all non-flag arguments as the query
      const ftsQuery = args.slice(1).filter((a, i, arr) => {
        if (a.startsWith("--")) return false
        if (i > 0 && ["--limit", "--project"].includes(arr[i - 1]!)) return false
        return true
      }).join(" ")
      await cmdFts(ftsQuery, {
        limit: getArg("--limit") ? parseInt(getArg("--limit")!, 10) : undefined,
        project: getArg("--project"),
        json: hasFlag("--json"),
      })
      break
    }

    case "now":
      await cmdNow()
      break

    case "hour":
      await cmdHour()
      break

    case "day":
      await cmdDay()
      break

    case "similar":
      if (!args[1]) {
        console.error("Usage: bun history similar <query>")
        process.exit(1)
      }
      const similarQuery = args.slice(1).filter((a, i, arr) => {
        if (a.startsWith("--")) return false
        if (i > 0 && ["--limit"].includes(arr[i - 1]!)) return false
        return true
      }).join(" ")
      await cmdSimilar(similarQuery, {
        limit: getArg("--limit") ? parseInt(getArg("--limit")!, 10) : undefined,
      })
      break

    case "list":
      await cmdList(args[1])
      break

    case "show":
      if (!args[1]) {
        console.error("Usage: bun history show <session-id>")
        process.exit(1)
      }
      await cmdShow(args[1])
      break

    case "search":
      if (!args[1]) {
        console.error("Usage: bun history search <pattern>")
        process.exit(1)
      }
      await cmdSearch(args[1])
      break

    case "grep": {
      if (!args[1]) {
        console.error("Usage: bun history grep <pattern> [--project name] [--limit n] [--context n]")
        process.exit(1)
      }
      const grepOptions: { project?: string; limit?: number; context?: number } = {}
      grepOptions.project = getArg("--project")
      const limitArg = getArg("--limit")
      if (limitArg) grepOptions.limit = parseInt(limitArg, 10)
      const contextArg = getArg("--context")
      if (contextArg) grepOptions.context = parseInt(contextArg, 10)
      await cmdGrep(args[1], grepOptions)
      break
    }

    case "writes": {
      const dateFilter = getArg("--date")
      await cmdWrites(dateFilter)
      break
    }

    case "restore": {
      if (!args[1]) {
        console.error("Usage: bun history restore <file-path> [--session <id>]")
        process.exit(1)
      }
      const sessionId = getArg("--session")
      await cmdRestore(args[1], sessionId)
      break
    }

    case "stats":
      await cmdStats()
      break

    case "help":
    case "--help":
    case "-h":
      printHelp()
      break

    default:
      if (command) {
        console.error(`Unknown command: ${command}`)
      }
      printHelp()
      process.exit(command ? 1 : 0)
  }
}

if (import.meta.main) {
  main()
}
