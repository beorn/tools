/**
 * Per-session LLM summarization with file-based caching.
 *
 * First pass of a two-pass hierarchical summarization system:
 * extract single session → send to cheap LLM → cache result.
 */

import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { extractSessionContent, type SessionExtract } from "./extract"
import { getCheapModel } from "../lib/llm/types"
import { queryModel } from "../lib/llm/research"
import { isProviderAvailable } from "../lib/llm/providers"

// ============================================================================
// Types
// ============================================================================

export interface SessionSummary {
  id: string
  shortId: string
  title: string | null
  time: string
  isSubAgent: boolean
  summary: string | null // null if skipped
  cached: boolean
}

// ============================================================================
// Constants
// ============================================================================

const SESSION_SUMMARY_PROMPT = `You are summarizing a single Claude Code coding session. Be specific and concise.

Produce a 3-8 line summary covering:
- What was the goal/task?
- What was done? (specific files, functions, packages)
- What was the outcome? (bugs fixed, features added, decisions made)
- Any mistakes, failed approaches, or wrong turns? (wrong commands, debugging dead ends, misconceptions about APIs, time wasted on bad approaches — be specific about what was tried and why it failed)
- Any lessons learned or open questions?

Rules:
- Be specific: include file names, function names, package names
- Each line should be a complete thought, 1-2 sentences
- Skip routine operations (file reads, test runs, linting)
- If truly nothing noteworthy, respond with just: NONE
- Do NOT invent information not present in the session data`

const MIN_CONTENT_LENGTH = 100

// ============================================================================
// Cache
// ============================================================================

function getCacheDir(): string {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd()
  const encodedPath = projectDir.replace(/\//g, "-")
  return path.join(
    os.homedir(),
    ".claude",
    "projects",
    encodedPath,
    "memory",
    "session-summaries",
  )
}

function getCachePath(shortId: string): string {
  return path.join(getCacheDir(), `${shortId}.md`)
}

export function getSessionSummaryCache(sessionId: string): string | null {
  const shortId = sessionId.slice(0, 8)
  const cachePath = getCachePath(shortId)
  try {
    return fs.readFileSync(cachePath, "utf8")
  } catch {
    return null
  }
}

function writeCache(shortId: string, content: string): void {
  const cacheDir = getCacheDir()
  fs.mkdirSync(cacheDir, { recursive: true })
  fs.writeFileSync(getCachePath(shortId), content)
}

// ============================================================================
// Summarize a single session
// ============================================================================

export async function summarizeSession(
  sessionId: string,
  opts?: { title?: string | null; createdAt?: number; verbose?: boolean },
): Promise<SessionSummary> {
  const log = opts?.verbose
    ? (msg: string) => console.error(`[summarize-session] ${msg}`)
    : () => {}

  // Extract content first (needed for metadata even if cached)
  const extract = extractSessionContent(sessionId, {
    title: opts?.title,
    createdAt: opts?.createdAt,
  })

  if (!extract) {
    log(`${sessionId.slice(0, 8)}: no content extracted`)
    return {
      id: sessionId,
      shortId: sessionId.slice(0, 8),
      title: opts?.title ?? null,
      time: "",
      isSubAgent: false,
      summary: null,
      cached: false,
    }
  }

  // Check cache (sessions are immutable after ending)
  const cached = getSessionSummaryCache(sessionId)
  if (cached) {
    log(`${extract.shortId}: cached`)
    return {
      id: extract.id,
      shortId: extract.shortId,
      title: extract.title,
      time: extract.time,
      isSubAgent: extract.isSubAgent,
      summary: cached,
      cached: true,
    }
  }

  // Skip sub-agent sessions
  if (extract.isSubAgent) {
    log(`${extract.shortId}: sub-agent, skipping`)
    return {
      id: extract.id,
      shortId: extract.shortId,
      title: extract.title,
      time: extract.time,
      isSubAgent: true,
      summary: null,
      cached: false,
    }
  }

  // Skip content that's too short
  if (extract.content.length < MIN_CONTENT_LENGTH) {
    log(
      `${extract.shortId}: content too short (${extract.content.length} chars)`,
    )
    return {
      id: extract.id,
      shortId: extract.shortId,
      title: extract.title,
      time: extract.time,
      isSubAgent: false,
      summary: null,
      cached: false,
    }
  }

  // Check LLM availability
  const model = getCheapModel()
  if (!model || !isProviderAvailable(model.provider)) {
    log(`${extract.shortId}: no LLM provider available`)
    return {
      id: extract.id,
      shortId: extract.shortId,
      title: extract.title,
      time: extract.time,
      isSubAgent: false,
      summary: null,
      cached: false,
    }
  }

  // Build context for LLM
  let context = extract.content
  if (context.length > 30000) {
    context = context.slice(0, 30000) + "\n\n[...truncated]"
  }

  log(`${extract.shortId}: sending to LLM (${context.length} chars)`)
  const startTime = Date.now()

  const result = await queryModel({
    question: context,
    model,
    systemPrompt: SESSION_SUMMARY_PROMPT,
  })

  const summary = result.response.content
  log(`${extract.shortId}: LLM responded in ${Date.now() - startTime}ms`)

  // Handle empty / NONE responses
  if (!summary || /^NONE$/im.test(summary.trim())) {
    log(`${extract.shortId}: nothing noteworthy`)
    return {
      id: extract.id,
      shortId: extract.shortId,
      title: extract.title,
      time: extract.time,
      isSubAgent: false,
      summary: null,
      cached: false,
    }
  }

  // Cache the result
  writeCache(extract.shortId, summary)
  log(`${extract.shortId}: cached summary`)

  return {
    id: extract.id,
    shortId: extract.shortId,
    title: extract.title,
    time: extract.time,
    isSubAgent: false,
    summary,
    cached: false,
  }
}

// ============================================================================
// Batch summarize
// ============================================================================

export async function summarizeSessionBatch(
  sessions: Array<{ id: string; title?: string | null; createdAt?: number }>,
  opts?: { verbose?: boolean },
): Promise<SessionSummary[]> {
  const log = opts?.verbose
    ? (msg: string) => console.error(`[summarize-session] ${msg}`)
    : () => {}

  log(`processing ${sessions.length} sessions`)

  const results: SessionSummary[] = []
  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i]!
    log(`[${i + 1}/${sessions.length}] ${session.id.slice(0, 8)}`)
    const result = await summarizeSession(session.id, {
      title: session.title,
      createdAt: session.createdAt,
      verbose: opts?.verbose,
    })
    results.push(result)
  }

  const summarized = results.filter((r) => r.summary !== null).length
  const cached = results.filter((r) => r.cached).length
  log(
    `done: ${summarized} summarized (${cached} from cache), ${results.length - summarized} skipped`,
  )

  return results
}
