/**
 * recall.ts - Search Claude Code session history and synthesize results via cheap LLM
 *
 * Combines FTS5 search across messages, plans, summaries, and todos with
 * optional LLM synthesis to extract decisions, approaches, and lessons learned.
 */

import * as fs from "fs"
import * as path from "path"
import {
  getDb,
  closeDb,
  DB_PATH,
  PROJECTS_DIR,
  ftsSearchWithSnippet,
  searchAll,
  getAllSessionTitles,
  getIndexMeta,
  type MessageSearchOptions,
  type ContentSearchOptions,
} from "./db"
import type { ContentType } from "./types"
import { indexProjectSources } from "./indexer"
import {
  getCheapModels,
  getCheapModel,
  estimateCost,
  formatCost,
  type Model,
} from "../llm/types"
import { queryModel } from "../llm/research"
import { isProviderAvailable } from "../llm/providers"

// Verbose stderr logging — all recall operations log what they do
let _logEnabled = true
export function setRecallLogging(enabled: boolean): void {
  _logEnabled = enabled
}
function log(msg: string): void {
  if (_logEnabled) console.error(`[recall] ${msg}`)
}

// Time constants
const ONE_HOUR_MS = 60 * 60 * 1000
const ONE_DAY_MS = 24 * ONE_HOUR_MS
const THIRTY_DAYS_MS = 30 * ONE_DAY_MS

// ============================================================================
// Types
// ============================================================================

export interface RecallOptions {
  limit?: number // Max results to include (default 10)
  raw?: boolean // Return raw results without LLM synthesis
  since?: string // Time filter (1h, 1d, 1w, etc.)
  json?: boolean // Return structured JSON
  timeout?: number // Total timeout in ms (default 4000)
  snippetTokens?: number // Snippet window size (default 200)
  projectFilter?: string // Project filter
}

export interface RecallResult {
  query: string
  synthesis: string | null // LLM synthesis (null if raw mode or no results)
  results: RecallSearchResult[]
  durationMs: number
  llmCost?: number
  timing?: {
    searchMs: number
    llmMs?: number
  }
}

export interface RecallSearchResult {
  type: ContentType
  sessionId: string
  sessionTitle: string | null
  timestamp: number
  snippet: string
  rank: number
}

// ============================================================================
// Time parsing
// ============================================================================

/**
 * Parse a relative time string to an absolute timestamp (ms since epoch).
 *
 * Supported formats:
 *   1h, 2h       - Hours ago
 *   1d, 7d       - Days ago
 *   1w, 2w       - Weeks ago
 *   today        - Since midnight today
 *   yesterday    - Since midnight yesterday
 *
 * Returns undefined if parsing fails.
 */
export function parseTimeToMs(timeStr: string): number | undefined {
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

// ============================================================================
// Synthesis prompt
// ============================================================================

const SYNTHESIS_PROMPT = `You are a knowledge retrieval assistant. Given search results from prior Claude Code sessions, synthesize the most useful information.

Extract and present:
- Decisions made and their rationale
- Approaches tried (including what failed and why)
- Key file paths and code patterns mentioned
- Warnings, caveats, or lessons learned
- Any unresolved issues or open questions

Rules:
- Be concise: 3-8 bullet points maximum
- Use plain text, no markdown headers
- Include specific file paths when mentioned
- If the results aren't relevant to the query, say "No relevant prior knowledge found."
- Do NOT invent information not present in the search results`

// ============================================================================
// Core recall function
// ============================================================================

/**
 * Search session history and optionally synthesize results via cheap LLM.
 *
 * Searches both the messages FTS table and the unified content table
 * (plans, summaries, todos), merges results by rank, deduplicates by session,
 * and optionally passes them through a cheap LLM for synthesis.
 */
export async function recall(
  query: string,
  options: RecallOptions = {},
): Promise<RecallResult> {
  const {
    limit = 10,
    raw = false,
    since,
    json = false,
    timeout = 4000,
    snippetTokens = 200,
    projectFilter,
  } = options

  const startTime = Date.now()
  const sinceLabel = since ?? "30d"
  log(
    `search query="${query.slice(0, 80)}" limit=${limit} since=${sinceLabel} raw=${raw} timeout=${timeout}ms`,
  )

  const db = getDb()

  try {
    // Parse time filter (default: 30 days)
    let sinceTime: number | undefined
    if (since) {
      sinceTime = parseTimeToMs(since)
      if (sinceTime === undefined) {
        log(`invalid time filter: "${since}"`)
        return {
          query,
          synthesis: null,
          results: [],
          durationMs: Date.now() - startTime,
        }
      }
    } else {
      sinceTime = Date.now() - THIRTY_DAYS_MS
    }

    // Search messages table with FTS5
    const messageOpts: MessageSearchOptions = {
      limit: limit * 2, // Fetch extra for dedup
      sinceTime,
      projectFilter,
      snippetTokens,
    }

    const searchStart = Date.now()
    const messageResults = ftsSearchWithSnippet(db, query, messageOpts)
    const msgMs = Date.now() - searchStart
    log(
      `FTS5 messages: ${messageResults.total} total, ${messageResults.results.length} returned (${msgMs}ms)`,
    )

    // Search session-scoped content (plans, summaries, todos, first_prompts) with time filter
    const sessionContentOpts: ContentSearchOptions = {
      limit: limit * 2,
      sinceTime,
      projectFilter,
      snippetTokens,
      types: ["plan", "summary", "todo", "first_prompt"] as ContentType[],
    }

    const contentStart = Date.now()
    const sessionContentResults = searchAll(db, query, sessionContentOpts)
    const sessionMs = Date.now() - contentStart

    // Search project knowledge sources (beads, memory, docs) WITHOUT time filter
    const projectStart = Date.now()
    const projectContentOpts: ContentSearchOptions = {
      limit: limit * 2,
      projectFilter,
      snippetTokens,
      types: [
        "bead",
        "session_memory",
        "project_memory",
        "doc",
        "claude_md",
        "llm_research",
      ] as ContentType[],
    }

    const projectContentResults = searchAll(db, query, projectContentOpts)
    const projectMs = Date.now() - projectStart

    // Merge both content result sets
    const contentResults = {
      results: [
        ...sessionContentResults.results,
        ...projectContentResults.results,
      ],
      total: sessionContentResults.total + projectContentResults.total,
    }
    const searchMs = Date.now() - searchStart
    log(
      `FTS5 search: ${searchMs}ms (messages=${msgMs}ms session=${sessionMs}ms project=${projectMs}ms)`,
    )

    // Get session titles for enrichment
    const sessionTitles = getAllSessionTitles()

    // Merge results into a unified list
    const merged: RecallSearchResult[] = []

    for (const r of messageResults.results) {
      merged.push({
        type: "message",
        sessionId: r.session_id,
        sessionTitle: sessionTitles.get(r.session_id) ?? null,
        timestamp: r.timestamp,
        snippet: r.snippet || (r.content?.slice(0, 500) ?? ""),
        rank: r.rank,
      })
    }

    for (const r of contentResults.results) {
      merged.push({
        type: r.content_type as RecallSearchResult["type"],
        sessionId: r.source_id,
        sessionTitle: r.title ?? sessionTitles.get(r.source_id) ?? null,
        timestamp: r.timestamp,
        snippet: r.snippet || r.content.slice(0, 500),
        rank: r.rank,
      })
    }

    // Sort by rank (bm25 — lower is better)
    merged.sort((a, b) => a.rank - b.rank)

    // Dedup: keep best result per session
    const seen = new Set<string>()
    const deduped: RecallSearchResult[] = []
    for (const result of merged) {
      const key = `${result.sessionId}:${result.type}`
      if (!seen.has(key)) {
        seen.add(key)
        deduped.push(result)
      }
      if (deduped.length >= limit) break
    }

    const uniqueSessions = new Set(deduped.map((r) => r.sessionId)).size
    log(
      `merged: ${merged.length} raw → ${deduped.length} deduped from ${uniqueSessions} sessions (${Date.now() - searchStart}ms total search)`,
    )

    // No results — return early
    if (deduped.length === 0) {
      log(`no results found (${Date.now() - startTime}ms total)`)
      return {
        query,
        synthesis: null,
        results: [],
        durationMs: Date.now() - startTime,
      }
    }

    // Raw mode — return results as-is without LLM
    if (raw) {
      log(
        `raw mode — returning ${deduped.length} results without synthesis (${Date.now() - startTime}ms total)`,
      )
      return {
        query,
        synthesis: null,
        results: deduped,
        durationMs: Date.now() - startTime,
        timing: { searchMs },
      }
    }

    // Attempt LLM synthesis with AbortController for clean timeout
    const llmStart = Date.now()
    const synthesis = await synthesizeResults(query, deduped, timeout)
    const llmMs = Date.now() - llmStart

    const totalMs = Date.now() - startTime
    if (synthesis.text) {
      log(
        `synthesis OK: ${synthesis.text.length} chars, cost=$${(synthesis.cost ?? 0).toFixed(4)} (${totalMs}ms total, search=${searchMs}ms llm=${llmMs}ms${synthesis.aborted ? " ABORTED" : ""})`,
      )
    } else {
      log(
        `synthesis returned null (${totalMs}ms total, search=${searchMs}ms llm=${llmMs}ms${synthesis.aborted ? " ABORTED" : ""})`,
      )
    }

    return {
      query,
      synthesis: synthesis.text,
      results: deduped,
      durationMs: totalMs,
      llmCost: synthesis.cost,
      timing: { searchMs, llmMs },
    }
  } finally {
    closeDb()
  }
}

// ============================================================================
// LLM synthesis
// ============================================================================

interface SynthesisResult {
  text: string | null
  cost?: number
  aborted?: boolean
}

// ── LLM Race Infrastructure ──────────────────────────────────────────────

export interface LlmRaceModelResult {
  model: string
  ms: number
  status: "ok" | "timeout" | "error"
  tokens?: { input: number; output: number }
  cost?: number // USD
}

export interface LlmRaceResult {
  winner: string | null
  text: string | null
  cost?: number
  timedOut: boolean
  totalMs: number
  perModel: LlmRaceModelResult[]
  totalCost: number // sum of ALL models called (winner + losers)
}

/**
 * Race multiple LLM models — first valid response wins.
 * Returns per-model timing diagnostics regardless of outcome.
 */
export async function raceLlmModels(
  context: string,
  systemPrompt: string,
  models: Model[],
  timeoutMs: number,
): Promise<LlmRaceResult> {
  const raceStart = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  // Track per-model results (settled after race completes)
  const modelResults: LlmRaceModelResult[] = models.map((m) => ({
    model: m.modelId,
    ms: 0,
    status: "timeout" as const,
  }))

  // Race all models
  const racePromises = models.map(async (model, i) => {
    const result = await queryModel({
      question: context,
      model,
      systemPrompt,
      abortSignal: controller.signal,
    })

    const elapsed = Date.now() - raceStart
    const mr = modelResults[i]!
    mr.ms = elapsed

    // Track tokens + compute cost from actual usage
    const usage = result.response.usage
    if (usage) {
      mr.tokens = { input: usage.promptTokens, output: usage.completionTokens }
      mr.cost = estimateCost(model, usage.promptTokens, usage.completionTokens)
    }

    // queryModel catches errors internally — check for abort/error
    if (controller.signal.aborted) {
      mr.status = "timeout"
      return null
    }
    if (result.response.error) {
      mr.status = "error"
      return null
    }

    const content = result.response.content
    if (!content) {
      mr.status = "error"
      return null
    }

    mr.status = "ok"
    return {
      text: content,
      cost: mr.cost,
      model: model.modelId,
    }
  })

  try {
    const winner = await Promise.any(
      racePromises.map((p) =>
        p.then((r) => {
          if (!r) throw new Error("empty")
          clearTimeout(timer)
          controller.abort()
          return r
        }),
      ),
    )

    const totalCost = modelResults.reduce((s, m) => s + (m.cost ?? 0), 0)
    return {
      winner: winner.model,
      text: winner.text,
      cost: winner.cost,
      timedOut: false,
      totalMs: Date.now() - raceStart,
      perModel: modelResults,
      totalCost,
    }
  } catch {
    clearTimeout(timer)
    controller.abort()
    const totalMs = Date.now() - raceStart
    const totalCost = modelResults.reduce((s, m) => s + (m.cost ?? 0), 0)
    return {
      winner: null,
      text: null,
      timedOut: totalMs >= timeoutMs - 50,
      totalMs,
      perModel: modelResults,
      totalCost,
    }
  }
}

async function synthesizeResults(
  query: string,
  results: RecallSearchResult[],
  timeoutMs: number,
): Promise<SynthesisResult> {
  const models = getCheapModels(2).filter((m) =>
    isProviderAvailable(m.provider),
  )
  if (models.length === 0) {
    log(`no LLM providers available for synthesis`)
    return { text: null }
  }

  const context = formatResultsForLlm(query, results)
  const modelNames = models.map((m) => m.modelId).join(", ")
  log(
    `LLM synthesis: racing [${modelNames}] context=${context.length} chars timeout=${timeoutMs}ms`,
  )

  const race = await raceLlmModels(context, SYNTHESIS_PROMPT, models, timeoutMs)

  if (race.winner) {
    log(`LLM winner: ${race.winner} in ${race.totalMs}ms`)
  } else {
    log(
      `LLM synthesis ${race.timedOut ? "aborted" : "failed"} after ${race.totalMs}ms (models: [${modelNames}])`,
    )
  }

  return {
    text: race.text,
    cost: race.cost,
    aborted: race.timedOut,
  }
}

function formatResultsForLlm(
  query: string,
  results: RecallSearchResult[],
): string {
  const lines: string[] = [
    `Query: "${query}"`,
    "",
    `Found ${results.length} relevant results from prior sessions:`,
    "",
  ]

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!
    const date = new Date(r.timestamp).toISOString().split("T")[0]
    const sessionLabel = r.sessionTitle
      ? `${r.sessionTitle} (${r.sessionId.slice(0, 8)})`
      : r.sessionId.slice(0, 8)

    lines.push(`--- Result ${i + 1} [${r.type}] ${date} - ${sessionLabel} ---`)

    // Clean snippet markers
    const cleanSnippet = r.snippet
      .replace(/>>>/g, "")
      .replace(/<<</g, "")
      .trim()
    lines.push(cleanSnippet)
    lines.push("")
  }

  lines.push("---")
  lines.push(
    "Synthesize the above results into concise, actionable bullet points relevant to the query.",
  )

  return lines.join("\n")
}

// ============================================================================
// Review / Diagnostics
// ============================================================================

export interface ReviewResult {
  indexHealth: {
    sessions: number
    messages: number
    plans: number
    summaries: number
    firstPrompts: number
    todos: number
    beads: number
    sessionMemory: number
    projectMemory: number
    docs: number
    claudeMd: number
    dbSizeBytes: number
    lastRebuild: string | null
    isStale: boolean
  }
  hookConfig: {
    userPromptSubmitConfigured: boolean
    sessionEndConfigured: boolean
    recallHookConfigured: boolean
    rememberHookConfigured: boolean
    sessionMemoryFiles: number
  }
  searchBenchmarks: {
    query: string
    resultCount: number
    latencyMs: number
    avgSnippetLength: number
    uniqueSessions: number
    hasTitles: boolean
  }[]
  recallTest: {
    query: string
    synthesisOk: boolean
    synthesisLength: number
    llmCost: number | null
    durationMs: number
    resultCount: number
    uniqueSessions: number
  } | null
  llmRaceBenchmark: {
    models: string[]
    queries: number
    results: {
      query: string
      searchMs: number
      winner: string | null
      timedOut: boolean
      totalMs: number
      perModel: LlmRaceModelResult[]
      raceCost: number
    }[]
    summary: {
      winsByModel: Record<string, number>
      timeoutCount: number
      timeoutPct: number
      p50Ms: number
      p95Ms: number
      avgSearchMs: number
      avgLlmMs: number
      totalCost: number
      costPerQuery: number
    }
  } | null
  recommendations: string[]
}

/**
 * Run a full diagnostic review of the memory system.
 *
 * Checks index health, hook configuration, search quality, and recall synthesis.
 * Returns a structured ReviewResult with actionable recommendations.
 *
 * @param projectRoot - Absolute path to the project root (for finding settings.json)
 */
export async function reviewMemorySystem(
  projectRoot: string,
): Promise<ReviewResult> {
  const startTime = Date.now()
  log(`review: starting diagnostics for ${projectRoot}`)
  const recommendations: string[] = []

  // ── Index Health ──────────────────────────────────────────────────────
  log(`review: checking index health...`)
  const db = getDb()
  let indexHealth: ReviewResult["indexHealth"]
  try {
    const sessions =
      (db.prepare("SELECT COUNT(*) as n FROM sessions").get() as { n: number })
        .n ?? 0
    const messages =
      (db.prepare("SELECT COUNT(*) as n FROM messages").get() as { n: number })
        .n ?? 0

    // Content table counts by type
    const contentCounts = db
      .prepare(
        "SELECT content_type, COUNT(*) as n FROM content GROUP BY content_type",
      )
      .all() as { content_type: string; n: number }[]
    const countByType = new Map(contentCounts.map((r) => [r.content_type, r.n]))

    const plans = countByType.get("plan") ?? 0
    const summaries = countByType.get("summary") ?? 0
    const firstPrompts = countByType.get("first_prompt") ?? 0
    const todos = countByType.get("todo") ?? 0
    const beads = countByType.get("bead") ?? 0
    const sessionMemory = countByType.get("session_memory") ?? 0
    const projectMemory = countByType.get("project_memory") ?? 0
    const docs = countByType.get("doc") ?? 0
    const claudeMd = countByType.get("claude_md") ?? 0

    // DB file size
    let dbSizeBytes = 0
    try {
      dbSizeBytes = fs.statSync(DB_PATH).size
    } catch {
      // ignore
    }

    // Last rebuild time
    const lastRebuild = getIndexMeta(db, "last_rebuild") ?? null
    const isStale = lastRebuild
      ? Date.now() - new Date(lastRebuild).getTime() > ONE_HOUR_MS
      : true

    indexHealth = {
      sessions,
      messages,
      plans,
      summaries,
      firstPrompts,
      todos,
      beads,
      sessionMemory,
      projectMemory,
      docs,
      claudeMd,
      dbSizeBytes,
      lastRebuild,
      isStale,
    }

    // Index health recommendations
    if (isStale) {
      const ago = lastRebuild
        ? formatTimeSince(new Date(lastRebuild).getTime())
        : "never"
      recommendations.push(
        `Index is stale (${ago}) — run \`bun recall index --incremental\``,
      )
    }
    if (firstPrompts === 0) {
      recommendations.push(
        "No first_prompt content indexed — run full index rebuild: `bun recall index`",
      )
    }
    if (plans === 0) {
      recommendations.push(
        "No plans indexed — no plan files found in ~/.claude/plans/",
      )
    }
    if (sessions === 0) {
      recommendations.push(
        "No sessions indexed — run `bun recall index` to build the index",
      )
    }
  } finally {
    closeDb()
  }

  log(
    `review: index has ${indexHealth.sessions} sessions, ${indexHealth.messages} messages, ${indexHealth.plans} plans, ${indexHealth.firstPrompts} first_prompts, ${indexHealth.beads} beads, ${indexHealth.docs} docs`,
  )

  // ── Hook Configuration ────────────────────────────────────────────────
  log(`review: checking hook configuration...`)
  const hookConfig = checkHookConfig(projectRoot, recommendations)

  // ── Search Benchmarks ─────────────────────────────────────────────────
  const benchmarkQueries = [
    { query: "bug fix", label: '"bug fix"' },
    { query: "inline edit", label: '"inline edit"' },
    { query: "test", label: '"test" (1d)', since: "1d" },
    {
      query: "refactor",
      label: "plans only",
      types: ["plan", "summary"] as ContentType[],
    },
  ]

  log(`review: running ${benchmarkQueries.length} search benchmarks...`)
  const searchBenchmarks: ReviewResult["searchBenchmarks"] = []
  for (const bq of benchmarkQueries) {
    try {
      const bench = runSearchBenchmark(bq.query, bq.label, bq.since, bq.types)
      searchBenchmarks.push(bench)
    } catch {
      // If a benchmark query fails (e.g. empty FTS), record zeros
      searchBenchmarks.push({
        query: bq.label,
        resultCount: 0,
        latencyMs: 0,
        avgSnippetLength: 0,
        uniqueSessions: 0,
        hasTitles: false,
      })
    }
  }

  // Search quality recommendations
  const totalResults = searchBenchmarks.reduce(
    (sum, b) => sum + b.resultCount,
    0,
  )
  if (totalResults === 0) {
    recommendations.push(
      "All benchmark queries returned 0 results — index may be empty or corrupt",
    )
  } else {
    const allFromOneSess = searchBenchmarks.every(
      (b) => b.uniqueSessions <= 1 && b.resultCount > 0,
    )
    if (allFromOneSess) {
      recommendations.push(
        "Results only from 1 session per query — index may be incomplete",
      )
    }
    const avgLatency =
      searchBenchmarks.reduce((sum, b) => sum + b.latencyMs, 0) /
      searchBenchmarks.length
    const diverseSessions = searchBenchmarks.reduce(
      (sum, b) => sum + b.uniqueSessions,
      0,
    )
    if (avgLatency < 500 && totalResults > 0 && diverseSessions > 2) {
      recommendations.push(
        `Search quality is good — ${totalResults} results across ${diverseSessions} sessions in ${Math.round(avgLatency)}ms avg`,
      )
    }
  }

  // ── Recall Quality Test ───────────────────────────────────────────────
  log(`review: testing recall quality with live LLM synthesis...`)
  let recallTest: ReviewResult["recallTest"] = null
  try {
    const testQuery = "inline edit"
    const startTime = Date.now()
    const result = await recall(testQuery, {
      limit: 5,
      timeout: 8000,
    })
    const durationMs = Date.now() - startTime
    const uniqueSessions = new Set(result.results.map((r) => r.sessionId)).size

    recallTest = {
      query: testQuery,
      synthesisOk: result.synthesis !== null && result.synthesis.length > 0,
      synthesisLength: result.synthesis?.length ?? 0,
      llmCost: result.llmCost ?? null,
      durationMs,
      resultCount: result.results.length,
      uniqueSessions,
    }

    // Recall quality recommendations
    if (!recallTest.synthesisOk) {
      recommendations.push(
        "LLM synthesis failed — check API keys (OPENAI_API_KEY, etc.)",
      )
    } else {
      if (recallTest.synthesisLength < 50) {
        recommendations.push(
          `Synthesis too short (${recallTest.synthesisLength} chars) — may not be useful`,
        )
      } else if (recallTest.synthesisLength > 2000) {
        recommendations.push(
          `Synthesis too long (${recallTest.synthesisLength} chars) — consider reducing --limit`,
        )
      }
      if (durationMs > 8000) {
        recommendations.push(
          `Synthesis is slow (${(durationMs / 1000).toFixed(1)}s) — consider reducing --limit`,
        )
      }
      if (
        recallTest.synthesisOk &&
        recallTest.synthesisLength >= 50 &&
        recallTest.synthesisLength <= 2000 &&
        durationMs <= 8000
      ) {
        const cost = recallTest.llmCost
          ? `$${recallTest.llmCost.toFixed(4)}`
          : "N/A"
        recommendations.push(
          `Synthesis working — ${recallTest.synthesisLength} chars in ${(durationMs / 1000).toFixed(1)}s (${cost})`,
        )
      }
    }
  } catch {
    recommendations.push("Recall test threw an error — check DB and LLM setup")
  }

  // ── LLM Race Benchmark ─────────────────────────────────────────────────
  log(`review: running LLM race benchmark...`)
  let llmRaceBenchmark: ReviewResult["llmRaceBenchmark"] = null
  const raceModels = getCheapModels(2).filter((m) =>
    isProviderAvailable(m.provider),
  )

  if (raceModels.length > 0) {
    const raceQueries = [
      "inline edit",
      "bug fix",
      "refactor",
      "test failure",
      "keyboard input",
    ]
    const raceTimeoutMs = 10000 // generous for benchmarking
    const raceResults: NonNullable<
      ReviewResult["llmRaceBenchmark"]
    >["results"] = []

    for (const q of raceQueries) {
      try {
        // Do a quick FTS5 search to build context
        const searchStart = Date.now()
        const db = getDb()
        const msgResults = ftsSearchWithSnippet(db, q, {
          limit: 10,
          sinceTime: Date.now() - THIRTY_DAYS_MS,
          snippetTokens: 200,
        })
        const contentResults = searchAll(db, q, {
          limit: 10,
          types: [
            "bead",
            "session_memory",
            "doc",
            "llm_research",
          ] as ContentType[],
          snippetTokens: 200,
        })
        closeDb()
        const searchMs = Date.now() - searchStart

        // Build minimal results for context
        const sessionTitles = getAllSessionTitles()
        const fakeResults: RecallSearchResult[] = [
          ...msgResults.results.slice(0, 5).map((r) => ({
            type: "message" as ContentType,
            sessionId: r.session_id,
            sessionTitle: sessionTitles.get(r.session_id) ?? null,
            timestamp: r.timestamp,
            snippet: r.snippet || r.content?.slice(0, 300) || "",
            rank: r.rank,
          })),
          ...contentResults.results.slice(0, 3).map((r) => ({
            type: r.content_type as ContentType,
            sessionId: r.source_id,
            sessionTitle: r.title ?? null,
            timestamp: r.timestamp,
            snippet: r.snippet || r.content.slice(0, 300),
            rank: r.rank,
          })),
        ]

        if (fakeResults.length === 0) {
          log(`review: race benchmark skipping "${q}" — no search results`)
          continue
        }

        const context = formatResultsForLlm(q, fakeResults)
        log(
          `review: racing "${q}" context=${context.length} chars across [${raceModels.map((m) => m.modelId).join(", ")}]`,
        )

        const race = await raceLlmModels(
          context,
          SYNTHESIS_PROMPT,
          raceModels,
          raceTimeoutMs,
        )

        raceResults.push({
          query: q,
          searchMs,
          winner: race.winner,
          timedOut: race.timedOut,
          totalMs: race.totalMs,
          perModel: race.perModel,
          raceCost: race.totalCost,
        })

        log(
          `review: "${q}" → ${race.winner ?? "TIMEOUT"} in ${race.totalMs}ms [${race.perModel.map((m) => `${m.model}=${m.ms}ms(${m.status})`).join(", ")}]`,
        )
      } catch (err) {
        log(
          `review: race benchmark error for "${q}": ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    if (raceResults.length > 0) {
      // Compute summary stats
      const winsByModel: Record<string, number> = {}
      for (const r of raceResults) {
        if (r.winner) {
          winsByModel[r.winner] = (winsByModel[r.winner] ?? 0) + 1
        }
      }

      const timeoutCount = raceResults.filter((r) => r.timedOut).length
      const successfulMs = raceResults
        .filter((r) => r.winner)
        .map((r) => r.totalMs)
        .sort((a, b) => a - b)

      const allLlmMs = raceResults.map((r) => r.totalMs).sort((a, b) => a - b)

      const totalCost = raceResults.reduce((s, r) => s + r.raceCost, 0)
      llmRaceBenchmark = {
        models: raceModels.map((m) => m.modelId),
        queries: raceResults.length,
        results: raceResults,
        summary: {
          winsByModel,
          timeoutCount,
          timeoutPct: Math.round((timeoutCount / raceResults.length) * 100),
          p50Ms: percentile(allLlmMs, 50),
          p95Ms: percentile(allLlmMs, 95),
          avgSearchMs: Math.round(
            raceResults.reduce((s, r) => s + r.searchMs, 0) /
              raceResults.length,
          ),
          avgLlmMs: Math.round(
            raceResults.reduce((s, r) => s + r.totalMs, 0) / raceResults.length,
          ),
          totalCost,
          costPerQuery:
            raceResults.length > 0 ? totalCost / raceResults.length : 0,
        },
      }

      // Recommendations based on benchmark
      if (llmRaceBenchmark.summary.timeoutPct > 50) {
        recommendations.push(
          `LLM race: ${llmRaceBenchmark.summary.timeoutPct}% timeouts at ${raceTimeoutMs}ms — providers are slow`,
        )
      }
      if (llmRaceBenchmark.summary.p95Ms > 8000) {
        recommendations.push(
          `LLM race P95: ${(llmRaceBenchmark.summary.p95Ms / 1000).toFixed(1)}s — consider making raw mode the default`,
        )
      }
      const topWinner = Object.entries(winsByModel).sort(
        (a, b) => b[1] - a[1],
      )[0]
      if (topWinner) {
        recommendations.push(
          `LLM race winner: ${topWinner[0]} won ${topWinner[1]}/${raceResults.length} (P50=${(llmRaceBenchmark.summary.p50Ms / 1000).toFixed(1)}s, P95=${(llmRaceBenchmark.summary.p95Ms / 1000).toFixed(1)}s)`,
        )
      }
    }
  } else {
    recommendations.push(
      "No cheap LLM providers available for race benchmark — check API keys",
    )
  }

  log(
    `review: completed in ${Date.now() - startTime}ms — ${recommendations.length} recommendations`,
  )

  return {
    indexHealth,
    hookConfig,
    searchBenchmarks,
    recallTest,
    llmRaceBenchmark,
    recommendations,
  }
}

function percentile(sorted: number[], pct: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.ceil((pct / 100) * sorted.length) - 1
  return sorted[Math.max(0, idx)]!
}

// ── Helpers ─────────────────────────────────────────────────────────────

function checkHookConfig(
  projectRoot: string,
  recommendations: string[],
): ReviewResult["hookConfig"] {
  const settingsPath = path.join(projectRoot, ".claude", "settings.json")
  let userPromptSubmitConfigured = false
  let sessionEndConfigured = false

  try {
    const raw = fs.readFileSync(settingsPath, "utf8")
    const settings = JSON.parse(raw) as {
      hooks?: Record<string, unknown[]>
    }
    if (settings.hooks) {
      userPromptSubmitConfigured = "UserPromptSubmit" in settings.hooks
      sessionEndConfigured = "SessionEnd" in settings.hooks
    }
  } catch {
    recommendations.push(
      "Could not read .claude/settings.json — hook config unknown",
    )
  }

  if (!userPromptSubmitConfigured) {
    recommendations.push(
      "UserPromptSubmit hook not configured — auto-recall is disabled",
    )
  }
  if (!sessionEndConfigured) {
    recommendations.push(
      "SessionEnd hook not configured — session lessons won't be saved",
    )
  }

  // Check hook commands point to recall.ts
  let recallHookConfigured = false
  let rememberHookConfigured = false
  try {
    const raw = fs.readFileSync(settingsPath, "utf8")
    const settings = JSON.parse(raw) as {
      hooks?: Record<string, { hooks?: { command?: string }[] }[]>
    }
    const hookEntries = settings.hooks ?? {}
    for (const entry of hookEntries.UserPromptSubmit ?? []) {
      for (const h of entry.hooks ?? []) {
        if (h.command?.includes("recall.ts hook")) recallHookConfigured = true
      }
    }
    for (const entry of hookEntries.SessionEnd ?? []) {
      for (const h of entry.hooks ?? []) {
        if (h.command?.includes("recall.ts remember"))
          rememberHookConfigured = true
      }
    }
  } catch {
    // Already reported above
  }

  if (userPromptSubmitConfigured && !recallHookConfigured) {
    recommendations.push(
      "UserPromptSubmit hook exists but doesn't call recall.ts hook",
    )
  }
  if (sessionEndConfigured && !rememberHookConfigured) {
    recommendations.push(
      "SessionEnd hook exists but doesn't call recall.ts remember",
    )
  }

  // Count session memory files
  let sessionMemoryFiles = 0
  const memorySessionsDir = findMemorySessionsDir(projectRoot)
  if (memorySessionsDir) {
    try {
      const entries = fs.readdirSync(memorySessionsDir)
      sessionMemoryFiles = entries.filter((e) => e.endsWith(".md")).length
    } catch {
      // ignore
    }
  }

  if (sessionMemoryFiles === 0) {
    recommendations.push(
      "No session memory files found — SessionEnd hook may not be firing",
    )
  }

  return {
    userPromptSubmitConfigured,
    sessionEndConfigured,
    recallHookConfigured,
    rememberHookConfigured,
    sessionMemoryFiles,
  }
}

/**
 * Find the memory/sessions/ directory for this project.
 * Claude stores project data in ~/.claude/projects/<encoded-path>/
 */
function findMemorySessionsDir(projectRoot: string): string | null {
  // Encode project path the way Claude does it: replace / with -
  const encodedPath = projectRoot.replace(/\//g, "-")
  const candidates = [
    path.join(PROJECTS_DIR, encodedPath, "memory", "sessions"),
    // Also check directly under the project's .claude dir
    path.join(projectRoot, ".claude", "memory", "sessions"),
  ]

  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir
  }
  return null
}

function runSearchBenchmark(
  query: string,
  label: string,
  since?: string,
  types?: ContentType[],
): ReviewResult["searchBenchmarks"][number] {
  const db = getDb()
  try {
    const startTime = Date.now()

    const sinceTime = since ? parseTimeToMs(since) : Date.now() - THIRTY_DAYS_MS

    if (types) {
      // Content-only search
      const results = searchAll(db, query, {
        limit: 20,
        sinceTime,
        types,
        snippetTokens: 200,
      })
      const latencyMs = Date.now() - startTime
      const snippetLengths = results.results.map((r) => r.snippet.length)
      const avgSnippetLength =
        snippetLengths.length > 0
          ? Math.round(
              snippetLengths.reduce((a, b) => a + b, 0) / snippetLengths.length,
            )
          : 0
      const uniqueSessions = new Set(results.results.map((r) => r.source_id))
        .size

      return {
        query: label,
        resultCount: results.total,
        latencyMs,
        avgSnippetLength,
        uniqueSessions,
        hasTitles: results.results.some((r) => r.title !== null),
      }
    }

    // Message search
    const msgResults = ftsSearchWithSnippet(db, query, {
      limit: 20,
      sinceTime,
      snippetTokens: 200,
    })
    const latencyMs = Date.now() - startTime

    // Get session titles for title check
    const sessionTitles = getAllSessionTitles()
    const snippetLengths = msgResults.results.map((r) => r.snippet.length)
    const avgSnippetLength =
      snippetLengths.length > 0
        ? Math.round(
            snippetLengths.reduce((a, b) => a + b, 0) / snippetLengths.length,
          )
        : 0
    const uniqueSessions = new Set(msgResults.results.map((r) => r.session_id))
      .size
    const hasTitles = msgResults.results.some(
      (r) => sessionTitles.get(r.session_id) !== undefined,
    )

    return {
      query: label,
      resultCount: msgResults.total,
      latencyMs,
      avgSnippetLength,
      uniqueSessions,
      hasTitles,
    }
  } finally {
    closeDb()
  }
}

function formatTimeSince(timestamp: number): string {
  const diff = Date.now() - timestamp
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

// ============================================================================
// Project source indexing (hook-time)
// ============================================================================

/**
 * Ensure project sources are indexed before searching.
 * Called from hookRecall when CLAUDE_PROJECT_DIR is set.
 * Uses mtime checks — fast (few ms) when nothing changed.
 */
function ensureProjectSourcesIndexed(): void {
  const projectRoot = process.env.CLAUDE_PROJECT_DIR
  if (!projectRoot) return

  try {
    const db = getDb()
    const startTime = Date.now()
    const result = indexProjectSources(db, projectRoot)
    const total =
      result.beads +
      result.sessionMemory +
      result.projectMemory +
      result.docs +
      result.claudeMd +
      result.research
    if (total > 0) {
      log(
        `indexed ${total} project sources (${Date.now() - startTime}ms): beads=${result.beads} memory=${result.sessionMemory} project=${result.projectMemory} docs=${result.docs} claude=${result.claudeMd} research=${result.research}`,
      )
    }
    // Don't close db here — recall() will use it and close when done
  } catch (e) {
    log(
      `project source indexing failed: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
}

// ============================================================================
// Hook subcommand: search + return additionalContext JSON
// ============================================================================

export interface HookResult {
  skipped: boolean
  reason?: string
  hookOutput?: {
    hookSpecificOutput: {
      additionalContext: string
    }
  }
}

/**
 * Run recall for a hook context: search + synthesize, return hook-formatted output.
 * Returns { skipped: true } for trivial prompts, { hookOutput } for results.
 * Throws on actual errors (fail loud).
 */
export async function hookRecall(prompt: string): Promise<HookResult> {
  // Skip empty prompts
  if (!prompt || prompt.trim().length === 0) {
    return { skipped: true, reason: "empty" }
  }

  // Skip short prompts (< 15 chars)
  if (prompt.trim().length < 15) {
    return { skipped: true, reason: "short" }
  }

  // Skip trivial responses
  const lower = prompt.toLowerCase().trim()
  const trivial = [
    "yes",
    "no",
    "y",
    "n",
    "ok",
    "okay",
    "sure",
    "continue",
    "go ahead",
    "lgtm",
    "looks good",
    "do it",
    "proceed",
    "thanks",
    "thank you",
    "done",
    "sounds good",
    "go for it",
  ]
  if (trivial.includes(lower)) {
    return { skipped: true, reason: "trivial" }
  }

  // Skip slash commands
  if (prompt.startsWith("/")) {
    return { skipped: true, reason: "slash_command" }
  }

  // Index project sources if CLAUDE_PROJECT_DIR is set (fast mtime checks)
  ensureProjectSourcesIndexed()

  const result = await recall(prompt, {
    limit: 3,
    timeout: 25000,
    json: true,
  })

  if (result.results.length === 0) {
    return { skipped: true, reason: "no_results" }
  }

  if (!result.synthesis) {
    // Results exist but synthesis failed (LLM timeout or unavailable)
    return { skipped: true, reason: "synthesis_failed" }
  }

  return {
    skipped: false,
    hookOutput: {
      hookSpecificOutput: {
        additionalContext: `## Session Memory\n\n${result.synthesis}`,
      },
    },
  }
}

// ============================================================================
// Remember subcommand: extract lessons from session transcript
// ============================================================================

export interface RememberOptions {
  transcriptPath: string
  sessionId: string
  memoryDir: string
}

export interface RememberResult {
  skipped: boolean
  reason?: string
  memoryFile?: string
  lessonsCount?: number
}

const REMEMBER_PROMPT = `Extract key lessons, decisions, bugs found, patterns learned, and warnings from this Claude Code session transcript. Output as concise bullet points. Skip routine operations (file reads, test runs, linting). Focus on:
- Decisions made and WHY
- Bugs found and their root causes
- Approaches that failed and why
- Architectural patterns or conventions discovered
- Warnings for future sessions

If nothing noteworthy was learned, respond with just: NONE`

/**
 * Extract lessons from a session transcript and append to a dated memory file.
 * Throws on actual errors (fail loud).
 */
export async function remember(
  options: RememberOptions,
): Promise<RememberResult> {
  const { transcriptPath, sessionId, memoryDir } = options
  const startTime = Date.now()

  log(`remember session=${sessionId.slice(0, 8)} transcript=${transcriptPath}`)

  if (!fs.existsSync(transcriptPath)) {
    log(`transcript not found: ${transcriptPath}`)
    return { skipped: true, reason: "transcript_not_found" }
  }

  // Extract last user+assistant messages from JSONL transcript
  const extractStart = Date.now()
  const messages = extractTranscriptMessages(transcriptPath)
  if (!messages) {
    log(
      `no user/assistant messages found in transcript (${Date.now() - extractStart}ms)`,
    )
    return { skipped: true, reason: "no_messages" }
  }
  log(
    `extracted ${messages.length} chars from transcript (${Date.now() - extractStart}ms)`,
  )

  // Check LLM availability
  const model = getCheapModel()
  if (!model || !isProviderAvailable(model.provider)) {
    log(
      `no LLM provider available (model: ${model?.modelId ?? "none"}, provider: ${model?.provider ?? "none"})`,
    )
    return { skipped: true, reason: "no_llm_provider" }
  }

  // Synthesize lessons
  const fullPrompt = `${REMEMBER_PROMPT}\n\nSession transcript (last messages):\n${messages}`
  log(
    `LLM synthesis: model=${model.modelId} provider=${model.provider} prompt=${fullPrompt.length} chars`,
  )
  const llmStart = Date.now()
  const result = await queryModel({ question: fullPrompt, model })
  const synthesis = result.response.content
  log(`LLM responded in ${Date.now() - llmStart}ms`)

  if (!synthesis || synthesis.trim().length === 0) {
    log(`empty synthesis from LLM`)
    return { skipped: true, reason: "empty_synthesis" }
  }

  if (/^NONE$/im.test(synthesis.trim())) {
    log(`LLM says nothing noteworthy (${Date.now() - startTime}ms total)`)
    return { skipped: true, reason: "nothing_noteworthy" }
  }

  // Ensure memory dir exists
  fs.mkdirSync(memoryDir, { recursive: true })

  // Append to dated memory file
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
  const memoryFile = path.join(memoryDir, `${today}.md`)
  const time = new Date().toTimeString().slice(0, 5)
  const entry = `\n## Session ${sessionId.slice(0, 8)} (${time})\n\n${synthesis}\n`

  fs.appendFileSync(memoryFile, entry)

  const lessonsCount = (synthesis.match(/^[-*]/gm) || []).length
  log(
    `saved ${lessonsCount} lessons (${synthesis.length} chars) to ${memoryFile} (${Date.now() - startTime}ms total)`,
  )

  return {
    skipped: false,
    memoryFile,
    lessonsCount,
  }
}

/**
 * Extract user/assistant messages from a JSONL transcript file.
 * Takes the last 200 lines and extracts text content.
 */
function extractTranscriptMessages(transcriptPath: string): string | null {
  const content = fs.readFileSync(transcriptPath, "utf8")
  const lines = content.split("\n").filter(Boolean)
  const lastLines = lines.slice(-200)

  const messages: string[] = []

  for (const line of lastLines) {
    try {
      const entry = JSON.parse(line) as {
        type?: string
        message?: { content?: Array<{ type?: string; text?: string } | string> }
        content?: string | unknown[]
      }

      if (entry.type !== "user" && entry.type !== "assistant") continue

      let text = ""
      if (entry.message?.content) {
        text = entry.message.content
          .map((c) => {
            if (typeof c === "string") return c
            if (c && typeof c === "object" && "text" in c) return c.text
            return ""
          })
          .filter(Boolean)
          .join("\n")
      } else if (typeof entry.content === "string") {
        text = entry.content
      }

      if (text) {
        messages.push(`[${entry.type}]: ${text}\n---`)
      }
    } catch {
      // Skip unparseable lines
    }
  }

  if (messages.length === 0) return null

  // Limit to ~12KB
  const joined = messages.join("\n")
  return joined.length > 12000 ? joined.slice(-12000) : joined
}
