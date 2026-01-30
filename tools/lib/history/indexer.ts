/**
 * Claude Session indexer
 *
 * Parses JSONL session files and populates the SQLite database.
 */

import { Database } from "bun:sqlite"
import { createHash } from "crypto"
import { Glob } from "bun"
import * as path from "path"
import * as fs from "fs"
import * as readline from "readline"
import {
  PROJECTS_DIR,
  PLANS_DIR,
  TODOS_DIR,
  MAX_CONTENT_SIZE,
  upsertSession,
  insertMessage,
  insertWrite,
  insertContent,
  getSessionByPath,
  clearTables,
  clearContent,
  setIndexMeta,
  getAllSessionEntries,
  findPlanFiles,
  findTodoFiles,
} from "./db"
import type { TodoItem } from "./types"
import type { JsonlRecord, ToolUse } from "./types"

export interface IndexProgress {
  filesProcessed: number
  messagesIndexed: number
  writesIndexed: number
  currentFile: string
}

// Time window for indexing - sessions older than this are skipped
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

export interface IndexOptions {
  incremental?: boolean // Only index new/updated sessions
  messagesOnly?: boolean // Skip writes table (faster)
  onProgress?: (progress: IndexProgress) => void
}

export async function* findSessionFiles(): AsyncGenerator<string> {
  if (!fs.existsSync(PROJECTS_DIR)) {
    return
  }

  const glob = new Glob("**/*.jsonl")
  for await (const file of glob.scan({ cwd: PROJECTS_DIR, absolute: true })) {
    yield file
  }
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16)
}

export function projectPathFromRelative(relativePath: string): string {
  // Convert encoded path like "-Users-beorn-Code-pim-km" to "/Users/beorn/Code/pim/km"
  const first = relativePath.split(path.sep)[0] || relativePath
  return first.replace(/-/g, "/").replace(/^\//, "/")
}

export function extractTextContent(record: JsonlRecord): string | null {
  const parts: string[] = []

  // Handle user messages
  if (record.type === "user" && record.message) {
    const content = record.message.content
    if (typeof content === "string") {
      parts.push(content)
    } else if (Array.isArray(content)) {
      for (const item of content) {
        if (typeof item === "string") {
          parts.push(item)
        } else if (item && typeof item === "object" && "text" in item) {
          parts.push(String((item as { text: unknown }).text))
        }
      }
    }
  }

  // Handle assistant messages
  if (record.type === "assistant" && record.message) {
    const content = record.message.content
    if (Array.isArray(content)) {
      for (const item of content) {
        if (item && typeof item === "object") {
          const obj = item as Record<string, unknown>
          // Text blocks
          if (obj.type === "text" && typeof obj.text === "string") {
            parts.push(obj.text)
          }
          // Tool use - include the input as searchable text
          if (obj.type === "tool_use" && obj.input) {
            parts.push(JSON.stringify(obj.input))
          }
          // Thinking blocks
          if (obj.type === "thinking" && typeof obj.thinking === "string") {
            parts.push(obj.thinking)
          }
        }
      }
    }
  }

  // Handle tool results
  if (record.type === "tool_result" && record.content) {
    if (typeof record.content === "string") {
      parts.push(record.content)
    } else if (Array.isArray(record.content)) {
      for (const item of record.content) {
        if (typeof item === "string") {
          parts.push(item)
        } else if (item && typeof item === "object" && "text" in item) {
          parts.push(String((item as { text: unknown }).text))
        }
      }
    }
  }

  return parts.length > 0 ? parts.join("\n") : null
}

export function extractToolInfo(record: JsonlRecord): { toolName: string | null; filePaths: string | null } {
  let toolName: string | null = null
  const filePaths: string[] = []

  if (record.type === "assistant" && record.message?.content) {
    for (const item of record.message.content) {
      if (item && typeof item === "object" && (item as ToolUse).type === "tool_use") {
        const toolUse = item as ToolUse
        toolName = toolUse.name
        if (toolUse.input?.file_path) {
          filePaths.push(toolUse.input.file_path)
        }
      }
    }
  }

  if (record.toolName) {
    toolName = record.toolName
  }

  return {
    toolName,
    filePaths: filePaths.length > 0 ? filePaths.join(",") : null,
  }
}

export async function indexSessionFile(
  db: Database,
  filePath: string,
  options: IndexOptions = {},
): Promise<{ messages: number; writes: number }> {
  const relativePath = path.relative(PROJECTS_DIR, filePath)
  const projectPath = projectPathFromRelative(relativePath)
  const stats = fs.statSync(filePath)
  const mtime = stats.mtime.getTime()

  // Check if we can skip (incremental mode)
  if (options.incremental) {
    const existing = getSessionByPath(db, relativePath)
    if (existing && existing.updated_at >= mtime) {
      return { messages: 0, writes: 0 }
    }
  }

  const fileStream = fs.createReadStream(filePath)
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  })

  let sessionId = path.basename(filePath, ".jsonl")
  let firstTimestamp: number | null = null
  let lastTimestamp: number | null = null
  let messageCount = 0
  let writeCount = 0
  const seenUuids = new Set<string>()
  const seenWriteHashes = new Set<string>()

  for await (const line of rl) {
    if (!line.trim()) continue

    try {
      const record = JSON.parse(line) as JsonlRecord

      if (record.sessionId) sessionId = record.sessionId

      const timestamp = record.timestamp ? new Date(record.timestamp).getTime() : Date.now()
      if (firstTimestamp === null) firstTimestamp = timestamp
      lastTimestamp = timestamp

      // Skip if we've seen this UUID (incremental dedup)
      if (record.uuid) {
        if (seenUuids.has(record.uuid)) continue
        seenUuids.add(record.uuid)
      }

      // Index the message
      const textContent = extractTextContent(record)
      const { toolName, filePaths } = extractToolInfo(record)

      if (textContent || toolName) {
        insertMessage(
          db,
          record.uuid || null,
          sessionId,
          record.type,
          textContent,
          toolName,
          filePaths,
          timestamp,
        )
        messageCount++
      }

      // Also index writes for backwards compatibility
      if (!options.messagesOnly && record.type === "assistant" && record.message?.content) {
        for (const item of record.message.content) {
          if (
            item &&
            typeof item === "object" &&
            (item as ToolUse).type === "tool_use" &&
            (item as ToolUse).name === "Write" &&
            (item as ToolUse).input?.file_path &&
            (item as ToolUse).input?.content
          ) {
            const toolUse = item as ToolUse
            const content = toolUse.input.content!
            const hash = hashContent(content)
            const uniqueKey = `${toolUse.input.file_path}:${hash}`

            // Skip exact duplicates
            if (seenWriteHashes.has(uniqueKey)) continue
            seenWriteHashes.add(uniqueKey)

            const contentSize = Buffer.byteLength(content, "utf8")

            insertWrite(
              db,
              sessionId,
              relativePath,
              toolUse.id,
              record.timestamp || new Date().toISOString(),
              toolUse.input.file_path!,
              hash,
              contentSize,
              contentSize <= MAX_CONTENT_SIZE ? content : null,
            )
            writeCount++
          }
        }
      }
    } catch {
      // Skip malformed JSON lines
    }
  }

  // Update session metadata
  upsertSession(
    db,
    sessionId,
    projectPath,
    relativePath,
    firstTimestamp || mtime,
    lastTimestamp || mtime,
    messageCount,
  )

  return { messages: messageCount, writes: writeCount }
}

export interface IndexResult {
  files: number
  messages: number
  writes: number
  plans: number
  todos: number
  summaries: number
  skippedOld: number
}

/**
 * Prune sessions and related data older than the cutoff time
 */
export function pruneOldSessions(db: Database, cutoffTime: number): { sessions: number; messages: number; writes: number } {
  // Get sessions to prune
  const oldSessions = db.prepare(`
    SELECT id FROM sessions WHERE updated_at < ?
  `).all(cutoffTime) as { id: string }[]

  if (oldSessions.length === 0) {
    return { sessions: 0, messages: 0, writes: 0 }
  }

  const sessionIds = oldSessions.map(s => s.id)

  // Delete messages for old sessions
  let messagesDeleted = 0
  for (const id of sessionIds) {
    const result = db.prepare("DELETE FROM messages WHERE session_id = ?").run(id)
    messagesDeleted += result.changes
  }

  // Delete writes for old sessions
  let writesDeleted = 0
  for (const id of sessionIds) {
    const result = db.prepare("DELETE FROM writes WHERE session_id = ?").run(id)
    writesDeleted += result.changes
  }

  // Delete the sessions themselves
  for (const id of sessionIds) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(id)
  }

  // Rebuild FTS index to remove deleted data
  db.prepare("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')").run()

  return { sessions: sessionIds.length, messages: messagesDeleted, writes: writesDeleted }
}

export async function rebuildIndex(
  db: Database,
  options: IndexOptions = {},
): Promise<IndexResult> {
  const startTime = Date.now()
  const cutoffTime = Date.now() - THIRTY_DAYS_MS

  // Clear existing data unless incremental
  if (!options.incremental) {
    clearTables(db, options.messagesOnly ? ["sessions", "messages"] : ["writes", "sessions", "messages"])
    clearContent(db)
  } else {
    // In incremental mode, prune sessions older than 30 days
    pruneOldSessions(db, cutoffTime)
  }

  let totalFiles = 0
  let totalMessages = 0
  let totalWrites = 0
  let totalPlans = 0
  let totalTodos = 0
  let totalSummaries = 0
  let skippedOld = 0

  // Index session files
  for await (const sessionFile of findSessionFiles()) {
    // Skip sessions older than 30 days
    const stats = fs.statSync(sessionFile)
    if (stats.mtime.getTime() < cutoffTime) {
      skippedOld++
      continue
    }

    totalFiles++

    const relativePath = path.relative(PROJECTS_DIR, sessionFile)
    options.onProgress?.({
      filesProcessed: totalFiles,
      messagesIndexed: totalMessages,
      writesIndexed: totalWrites,
      currentFile: relativePath,
    })

    const { messages, writes } = await indexSessionFile(db, sessionFile, options)
    totalMessages += messages
    totalWrites += writes
  }

  // Index session summaries from sessions-index.json
  const sessionEntries = getAllSessionEntries()
  for (const entry of sessionEntries) {
    if (entry.summary) {
      insertContent(
        db,
        "summary",
        entry.sessionId,
        entry.projectPath || null,
        entry.customTitle || null,
        entry.summary,
        entry.modified ? new Date(entry.modified).getTime() : Date.now(),
      )
      totalSummaries++
    }
  }

  // Index plan files
  for (const planFile of findPlanFiles()) {
    try {
      const stats = fs.statSync(planFile)
      const content = fs.readFileSync(planFile, "utf8")
      const filename = path.basename(planFile, ".md")

      // Extract title from first heading or filename
      const titleMatch = content.match(/^#\s+(.+)$/m)
      const title = titleMatch ? titleMatch[1] : filename

      insertContent(
        db,
        "plan",
        filename,
        null, // Plans aren't project-specific
        title,
        content,
        stats.mtime.getTime(),
      )
      totalPlans++
    } catch {
      // Skip files we can't read
    }
  }

  // Index todo files
  for (const todoFile of findTodoFiles()) {
    try {
      const stats = fs.statSync(todoFile)
      const content = fs.readFileSync(todoFile, "utf8")
      const todos = JSON.parse(content) as TodoItem[]
      const filename = path.basename(todoFile, ".json")

      // Combine all todos into searchable content
      const todoContent = todos
        .map(t => `[${t.status}] ${t.content}${t.activeForm ? ` (${t.activeForm})` : ""}`)
        .join("\n")

      if (todoContent.trim()) {
        insertContent(
          db,
          "todo",
          filename,
          null,
          `Todo list (${todos.length} items)`,
          todoContent,
          stats.mtime.getTime(),
        )
        totalTodos++
      }
    } catch {
      // Skip files we can't read
    }
  }

  // Store metadata
  const duration = Date.now() - startTime
  setIndexMeta(db, "last_rebuild", new Date().toISOString())
  setIndexMeta(db, "rebuild_duration_ms", String(duration))
  setIndexMeta(db, "total_files", String(totalFiles))
  setIndexMeta(db, "total_messages", String(totalMessages))
  setIndexMeta(db, "total_plans", String(totalPlans))
  setIndexMeta(db, "total_todos", String(totalTodos))
  setIndexMeta(db, "total_summaries", String(totalSummaries))

  return { files: totalFiles, messages: totalMessages, writes: totalWrites, plans: totalPlans, todos: totalTodos, summaries: totalSummaries, skippedOld }
}
