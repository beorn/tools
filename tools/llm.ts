#!/usr/bin/env bun
/**
 * llm.ts - Multi-LLM research CLI
 *
 *   llm "question"              Quick answer (~$0.02)
 *   llm --deep "topic"          Deep research with web search (~$2-5)
 *   llm opinion "question"      Second opinion from GPT/Gemini (~$0.02)
 *   llm debate "question"       Multi-model consensus (~$1-3)
 *
 * Output: response always written to /tmp/llm-*.txt, JSON metadata on stdout.
 * Streaming tokens shown on stderr only when running in an interactive terminal (TTY).
 */

import { ask, research } from "./lib/llm/research"
import { retrieveResponse, pollForCompletion } from "./lib/llm/openai-deep"
import {
  listPartials,
  findPartialByResponseId,
  cleanupPartials,
} from "./lib/llm/persistence"
import { consensus } from "./lib/llm/consensus"
import {
  getAvailableProviders,
  getProviderEnvVar,
  isProviderAvailable,
} from "./lib/llm/providers"
import {
  estimateCost,
  formatCost,
  getBestAvailableModel,
  getBestAvailableModels,
} from "./lib/llm/types"
import { initializePricing, getStaleWarning } from "./lib/llm/pricing"
import {
  getDb,
  closeDb,
  findSimilarQueries,
  ftsSearchWithSnippet,
} from "./lib/history/db"

// Initialize pricing on startup
initializePricing()

// Clean up stale output files (>7 days old)
import { readdirSync, statSync, unlinkSync } from "fs"
try {
  const maxAge = 7 * 24 * 60 * 60 * 1000
  const now = Date.now()
  for (const f of readdirSync("/tmp")) {
    if (f.startsWith("llm-") && f.endsWith(".txt")) {
      const path = `/tmp/${f}`
      try {
        if (now - statSync(path).mtimeMs > maxAge) unlinkSync(path)
      } catch {}
    }
  }
} catch {}

const args = process.argv.slice(2)
const command = args[0]

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  if (diff < 60000) return `${Math.round(diff / 1000)}s ago`
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`
  return `${Math.round(diff / 86400000)}d ago`
}

function error(message: string): never {
  console.error(JSON.stringify({ error: message }))
  process.exit(1)
}

function usage(): never {
  const available = getAvailableProviders()

  console.log(`
╔══════════════════════════════════════════════════════════════════════════════╗
║                        LLM - Multi-Model Research CLI                        ║
╚══════════════════════════════════════════════════════════════════════════════╝

USAGE
  llm "question"                    Answer using gpt-5.2 (~$0.02)
  llm --deep "topic"                Deep research with web search (~$2-5)
  llm opinion "question"            Second opinion from Gemini (~$0.02)
  llm debate "question"             Multi-model consensus (~$1-3)

EXAMPLES
  llm "what port does postgres use"                      Standard answer
  llm --deep "best practices for TUI testing 2026"       Thorough research
  llm opinion "is my caching approach reasonable"        Get a second opinion
  llm debate "monorepo vs polyrepo for our use case"     Multiple perspectives

KEYWORDS
  (none)                 Default: gpt-5.2 (~$0.02)
  opinion                Second opinion from different provider (~$0.02)
  debate                 Query 3 models, synthesize consensus (~$1-3, confirms)
  quick/cheap/mini/nano  Cheap/fast model if you really want it (~$0.01)

FLAGS
  --deep, /deep          Deep research with web search (~$2-5, confirms)
  --ask, /ask            Explicit default mode (syntactic sugar)
  -y, --yes              Skip confirmation prompts (for scripting)
  --dry-run              Show what would happen without calling APIs
  --no-recover           Skip auto-recovery of incomplete responses
  --with-history         Include relevant context from session history
  --context <text>       Provide explicit context (prepended to topic)
  --context-file <path>  Read context from a file
  --output <file>        Write response to specific file (default: auto /tmp/llm-*.txt)

FEATURES
  • Auto-recovery: Checks for interrupted responses and recovers them
  • Checks session history first (avoids duplicate research)
  • Cost confirmation for expensive queries (deep, debate)
  • Streams responses in real-time
  • Persistence: Saves progress to disk during streaming
  • File output: Response ALWAYS written to file (path printed to stdout + stderr)
  • Streaming tokens shown on stderr only in interactive terminals (TTY)

PROVIDERS
  ${available.includes("openai" as any) ? "✓" : "○"} OpenAI      ${available.includes("openai" as any) ? "ready" : "set OPENAI_API_KEY"}
  ${available.includes("anthropic" as any) ? "✓" : "○"} Anthropic   ${available.includes("anthropic" as any) ? "ready" : "set ANTHROPIC_API_KEY"}
  ${available.includes("google" as any) ? "✓" : "○"} Google      ${available.includes("google" as any) ? "ready" : "set GOOGLE_GENERATIVE_AI_API_KEY"}
  ${available.includes("xai" as any) ? "✓" : "○"} xAI (Grok)  ${available.includes("xai" as any) ? "ready" : "set XAI_API_KEY"}
  ${available.includes("perplexity" as any) ? "✓" : "○"} Perplexity  ${available.includes("perplexity" as any) ? "ready" : "set PERPLEXITY_API_KEY"}

RECOVERY (for interrupted deep research)
  llm recover                       List incomplete/partial responses
  llm recover <response_id>         Retrieve response by ID from OpenAI
  llm partials                      Alias for 'recover' (list partials)
  llm partials --clean              Clean up old partial files (>7 days)
`)
  process.exit(0)
}

function getArg(name: string): string | undefined {
  const idx = args.indexOf(name)
  if (idx === -1) return undefined
  return args[idx + 1]
}

function hasFlag(name: string): boolean {
  return args.includes(name)
}

const outputArg = getArg("--output")
const sessionTag = process.env.CLAUDE_SESSION_ID?.slice(0, 8) ?? "manual"
/**
 * Response is ALWAYS written to a file. Never stream to stdout — it causes truncation
 * when Claude Code captures background task output (stderr streaming tokens + stdout JSON
 * exceed 30KB limit). The --output - mode was removed for this reason.
 */
const outputFile =
  outputArg ??
  `/tmp/llm-${sessionTag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.txt`

/**
 * Write token during streaming — stderr ONLY if interactive terminal (TTY).
 *
 * When running as a background task (e.g., Claude Code's run_in_background), stderr is not
 * a TTY. Streaming thousands of tokens to a non-TTY stderr causes Claude Code to truncate
 * the combined output (>30KB), potentially losing the file path JSON on stdout.
 *
 * DO NOT remove the TTY check — it prevents background task output truncation.
 * Use --verbose to force streaming even without a TTY.
 */
function streamToken(token: string): void {
  if (process.stderr.isTTY || hasFlag("--verbose")) {
    process.stderr.write(token)
  }
}

interface OutputMeta {
  query?: string
  model?: string
  tokens?: number
  cost?: string
  durationMs?: number
}

/** Build JSON summary object for the response */
function buildResultJson(
  content: string,
  meta?: OutputMeta,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  if (meta?.query) result.query = meta.query
  result.chars = content.length
  if (meta?.model) result.model = meta.model
  if (meta?.tokens) result.tokens = meta.tokens
  if (meta?.cost) result.cost = meta.cost
  if (meta?.durationMs) result.durationMs = meta.durationMs
  return result
}

/**
 * After response completes: write to file, print file path on stderr, JSON metadata on stdout.
 *
 * File path on stderr: human-readable, always visible in last lines of output.
 * JSON metadata on stdout: machine-parseable single line (file path, char count, cost, etc.)
 * Streaming tokens are suppressed in non-TTY mode (see streamToken), so stderr only contains
 * the file path line + any status messages — no truncation risk.
 *
 * DO NOT stream response content to stdout — only the JSON metadata line goes there.
 */
function finalizeOutput(content: string, meta?: OutputMeta): void {
  Bun.write(outputFile, content)
  process.stderr.write("\n")
  process.stderr.write(`Output written to: ${outputFile}\n`)
  const result = buildResultJson(content, meta)
  result.file = outputFile
  console.log(JSON.stringify(result))
}

/** Compute cost, finalize output, and exit — shared by all single-model response modes */
function finishResponse(
  content: string | undefined,
  model: { displayName: string },
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  },
  durationMs?: number,
  query?: string,
): void {
  if (!content) return
  const cost = usage
    ? estimateCost(model as any, usage.promptTokens, usage.completionTokens)
    : undefined
  finalizeOutput(content, {
    query,
    model: model.displayName,
    tokens: usage?.totalTokens,
    cost: cost !== undefined ? formatCost(cost) : undefined,
    durationMs,
  })
}

/** Compute total cost across multiple model responses */
function totalResponseCost(
  responses: Array<{
    model: any
    usage?: { promptTokens: number; completionTokens: number }
  }>,
): number {
  let total = 0
  for (const resp of responses) {
    if (resp.usage)
      total += estimateCost(
        resp.model,
        resp.usage.promptTokens,
        resp.usage.completionTokens,
      )
  }
  return total
}

/** Shared single-model ask: select model, stream, finalize */
async function askAndFinish(
  question: string,
  modelMode: string,
  level: "standard" | "quick",
  header: (name: string) => string,
): Promise<void> {
  const { model, warning } = getBestAvailableModel(
    modelMode,
    isProviderAvailable,
  )
  if (!model) error(`No model available for ${modelMode}. ${warning || ""}`)
  if (warning) console.error(`⚠️  ${warning}\n`)
  console.error(header(model.displayName) + "\n")
  const response = await ask(question, level, {
    modelOverride: model.modelId,
    stream: true,
    onToken: streamToken,
  })
  finishResponse(
    response.content,
    model,
    response.usage,
    response.durationMs,
    question,
  )
}

/** Prompt user for Y/n confirmation; exit if declined */
async function confirmOrExit(message: string): Promise<void> {
  if (hasFlag("--yes") || hasFlag("-y")) return
  console.error(message)
  const answer = await new Promise<string>((resolve) => {
    process.stdin.setRawMode?.(true)
    process.stdin.resume()
    process.stdin.once("data", (data) => {
      process.stdin.setRawMode?.(false)
      resolve(data.toString().trim().toLowerCase())
    })
  })
  if (answer === "n" || answer === "no") {
    console.error("Cancelled.")
    process.exit(0)
  }
  console.error()
}

/** Build context from --context, --context-file, and --with-history flags */
async function buildContext(topic: string): Promise<string | undefined> {
  const parts: string[] = []
  const contextArg = getArg("--context")
  const contextFile = getArg("--context-file")
  if (contextArg) parts.push(contextArg)
  if (contextFile) {
    try {
      parts.push(await Bun.file(contextFile).text())
    } catch {
      error(`Failed to read context file: ${contextFile}`)
    }
  }
  if (hasFlag("--with-history")) {
    try {
      const db = getDb()
      const { results } = ftsSearchWithSnippet(db, topic, { limit: 3 })
      closeDb()
      if (results.length > 0) {
        console.error("📚 Including context from session history...\n")
        parts.push(
          "Relevant context from previous sessions:\n\n" +
            results
              .map((r) => {
                const role = r.type === "user" ? "User" : "Assistant"
                return `[${role}]: ${r.snippet.replace(/>>>/g, "").replace(/<<</g, "")}`
              })
              .join("\n\n"),
        )
      }
    } catch {
      /* History not indexed */
    }
  }
  return parts.length > 0 ? parts.join("\n\n---\n\n") : undefined
}

const VALUE_FLAGS = [
  "--model",
  "--models",
  "--provider",
  "--context",
  "--context-file",
  "--output",
]

/** Extract non-flag text from args, optionally starting from index 0 (all args) or 1 (after command) */
function extractText(fromAll: boolean, exclude?: string[]): string {
  const source = fromAll ? args : args.slice(1)
  return source
    .filter((a, i, arr) => {
      if (a.startsWith("--")) return false
      if (a.match(/^-[a-zA-Z]$/)) return false
      if (exclude?.includes(a)) return false
      if (
        i > 0 &&
        arr[i - 1]?.startsWith("--") &&
        VALUE_FLAGS.includes(arr[i - 1]!)
      )
        return false
      return true
    })
    .join(" ")
}

function getQuestion(): string {
  return extractText(false, ["/deep", "/ask"])
}

/**
 * Check for and auto-recover incomplete responses
 * Returns true if user wants to continue with new query
 */
async function checkAndRecoverPartials(): Promise<boolean> {
  if (hasFlag("--no-recover")) return true

  const partials = listPartials()
  if (partials.length === 0) return true

  console.error(
    `📦 Found ${partials.length} incomplete response(s) - attempting recovery...\n`,
  )

  for (const partial of partials) {
    const age = Date.now() - new Date(partial.metadata.startedAt).getTime()
    const ageStr =
      age < 3600000
        ? `${Math.round(age / 60000)}m ago`
        : `${Math.round(age / 3600000)}h ago`

    console.error(`  ${partial.metadata.responseId}`)
    console.error(
      `    Started: ${ageStr} | Topic: ${partial.metadata.topic.slice(0, 50)}...`,
    )

    // Try to retrieve from OpenAI
    if (partial.metadata.responseId) {
      const recovered = await retrieveResponse(partial.metadata.responseId)
      if (recovered.status === "completed" && recovered.content) {
        console.error(
          `    ✅ Recovered from OpenAI (${recovered.content.length} chars)`,
        )
        console.error(`\n--- Recovered Response ---\n`)
        console.log(recovered.content)
        if (recovered.usage) {
          console.error(`\n[Recovered: ${recovered.usage.totalTokens} tokens]`)
        }
        // Clean up the partial file
        const { completePartial } = await import("./lib/llm/persistence")
        completePartial(partial.path, { delete: true })
        console.error(`\n--- End Recovered Response ---\n`)
      } else if (
        recovered.status === "failed" ||
        recovered.status === "cancelled" ||
        recovered.status === "expired"
      ) {
        console.error(
          `    ❌ Response ${recovered.status} — removing stale partial`,
        )
        const { completePartial } = await import("./lib/llm/persistence")
        completePartial(partial.path, { delete: true })
      } else if (
        recovered.status === "in_progress" ||
        recovered.status === "queued"
      ) {
        // Check if stale (>30 min for deep research is suspicious)
        const age = Date.now() - new Date(partial.metadata.startedAt).getTime()
        if (age > 30 * 60 * 1000) {
          console.error(
            `    ⚠️  Still ${recovered.status} after ${Math.round(age / 60000)}m — likely stale, removing`,
          )
          const { completePartial } = await import("./lib/llm/persistence")
          completePartial(partial.path, { delete: true })
        } else {
          console.error(
            `    ⏳ Still ${recovered.status} on OpenAI (${Math.round(age / 60000)}m old)`,
          )
          console.error(
            `    Run 'llm recover ${partial.metadata.responseId}' to poll until complete`,
          )
        }
      } else {
        console.error(`    ⚠️  Could not recover (status: ${recovered.status})`)
        if (partial.content.length > 0) {
          console.error(
            `    Local partial has ${partial.content.length} chars saved`,
          )
        }
      }
    }
    console.error()
  }

  // If we recovered anything or have partials, ask if user still wants to run new query
  if (!hasFlag("--yes") && !hasFlag("-y")) {
    console.error("Continue with new query? [Y/n] ")
    const confirm = await new Promise<string>((resolve) => {
      process.stdin.setRawMode?.(true)
      process.stdin.resume()
      process.stdin.once("data", (data) => {
        process.stdin.setRawMode?.(false)
        resolve(data.toString().trim().toLowerCase())
      })
    })
    if (confirm === "n" || confirm === "no") {
      return false
    }
    console.error()
  }

  return true
}

// Keywords that trigger specific modes
const KEYWORDS = [
  "quick",
  "cheap",
  "mini",
  "nano",
  "opinion",
  "debate",
  "recover",
  "partials",
]

async function main() {
  if (!command || command === "--help" || command === "-h") {
    usage()
  }

  // Check for stale pricing and warn
  const staleWarning = getStaleWarning()
  if (staleWarning) console.error(staleWarning + "\n")

  // Flag-based mode detection (before keyword/default dispatch)
  const isDeepFlag = hasFlag("--deep") || command === "/deep"
  const isAskFlag = hasFlag("--ask") || command === "/ask"

  // If first arg is not a keyword, treat entire args as a question (default mode)
  const isKeyword = KEYWORDS.includes(command!)
  if (!isKeyword && !isDeepFlag && !isAskFlag) {
    const question = args.join(" ")
    if (!question) usage()

    // Check history first
    try {
      const db = getDb()
      const similar = findSimilarQueries(db, question, { limit: 2 })
      closeDb()
      if (similar.length > 0) {
        console.error("📚 Similar past queries:\n")
        for (const s of similar) {
          const relTime = formatRelativeTime(new Date(s.timestamp).getTime())
          const preview = (s.user_content || "")
            .slice(0, 100)
            .replace(/\n/g, " ")
          console.error(`  ${relTime}: ${preview}...`)
        }
        console.error()
      }
    } catch {
      /* History not indexed */
    }

    await askAndFinish(question, "default", "standard", (name) => `[${name}]`)
    process.exit(0)
  }

  if (isDeepFlag) {
    const topic = isKeyword ? getQuestion() : extractText(true, ["/deep"])
    if (!topic) error("Usage: llm --deep <topic>")

    const context = await buildContext(topic)
    const shouldContinue = await checkAndRecoverPartials()
    if (!shouldContinue) {
      console.error("Cancelled.")
      process.exit(0)
    }

    const { model: deepModel, warning: deepWarning } = getBestAvailableModel(
      "deep",
      isProviderAvailable,
    )
    if (!deepModel) {
      error("No deep research model available. " + (deepWarning || ""))
    }

    console.error(`Deep research: ${topic}`)
    console.error(`Model: ${deepModel.displayName}`)
    console.error(`Estimated cost: ~$2-5\n`)
    if (deepWarning) console.error(`⚠️  ${deepWarning}\n`)
    if (context) {
      console.error(`📎 Context provided (${context.length} chars)\n`)
    }

    if (hasFlag("--dry-run")) {
      console.error("🔍 Dry run - would call deep research API")
      console.error(`   Model: ${deepModel.modelId}`)
      console.error(`   Provider: ${deepModel.provider}`)
      if (context) console.error(`   Context: ${context.slice(0, 100)}...`)
      process.exit(0)
    }

    await confirmOrExit(
      "⚠️  This uses deep research models (~$2-5). Proceed? [Y/n] ",
    )

    const response = await research(topic, {
      context,
      stream: true,
      onToken: streamToken,
    })

    if (response.error) console.error(`Error: ${response.error}`)
    finishResponse(
      response.content,
      response.model,
      response.usage,
      response.durationMs,
      topic,
    )
    process.exit(0)
  }

  if (isAskFlag) {
    const question = isKeyword ? getQuestion() : extractText(true, ["/ask"])
    if (!question) error("Usage: llm --ask <question>")
    await askAndFinish(question, "default", "standard", (name) => `[${name}]`)
    process.exit(0)
  }

  switch (command) {
    // New keyword commands
    case "quick":
    case "cheap":
    case "mini":
    case "nano": {
      const question = getQuestion()
      if (!question) error("Usage: llm quick <question>")
      await askAndFinish(
        question,
        "quick",
        "quick",
        (name) => `[${name} - quick mode]`,
      )
      break
    }

    case "opinion": {
      const question = getQuestion()
      if (!question) error("Usage: llm opinion <question>")
      await askAndFinish(
        question,
        "opinion",
        "standard",
        (name) => `[Second opinion from ${name}]`,
      )
      break
    }

    // Alias for consensus
    case "debate": {
      const question = getQuestion()
      if (!question) error("Usage: llm debate <question>")

      const contextDebate = await buildContext(question)
      const enrichedQuestion = contextDebate
        ? `${contextDebate}\n\n---\n\n${question}`
        : question

      const shouldContinueDebate = await checkAndRecoverPartials()
      if (!shouldContinueDebate) {
        console.error("Cancelled.")
        process.exit(0)
      }

      const { models: debateModels, warning: debateWarning } =
        getBestAvailableModels("debate", isProviderAvailable, 3)
      if (debateModels.length < 2) {
        error("Need at least 2 models for debate. " + (debateWarning || ""))
      }

      console.error(`Multi-model debate: ${question}`)
      console.error(
        `Models: ${debateModels.map((m) => m.displayName).join(", ")}`,
      )
      console.error(`Estimated cost: ~$1-3\n`)
      if (debateWarning) console.error(`⚠️  ${debateWarning}\n`)
      if (contextDebate) {
        console.error(`📎 Context provided (${contextDebate.length} chars)\n`)
      }

      // Dry run - show what would happen without calling API
      if (hasFlag("--dry-run")) {
        console.error("🔍 Dry run - would query these models:")
        for (const m of debateModels) {
          console.error(`   • ${m.displayName} (${m.provider})`)
        }
        if (contextDebate) {
          console.error(`   Context: ${contextDebate.slice(0, 100)}...`)
        }
        process.exit(0)
      }

      await confirmOrExit(
        "⚠️  This queries multiple models (~$1-3). Proceed? [Y/n] ",
      )

      const result = await consensus({
        question: enrichedQuestion,
        modelIds: debateModels.map((m) => m.modelId),
        synthesize: true,
        onModelComplete: (response) => {
          if (response.error) {
            console.error(
              `[${response.model.displayName}] Error: ${response.error}`,
            )
          } else {
            console.error(`[${response.model.displayName}] ✓`)
          }
        },
      })

      // Build full debate output
      const parts: string[] = []
      parts.push("--- Synthesis ---\n")
      parts.push(result.synthesis || "(No synthesis)")
      if (result.agreements?.length) {
        parts.push("\n--- Agreements ---")
        result.agreements.forEach((a) => parts.push(`• ${a}`))
      }
      if (result.disagreements?.length) {
        parts.push("\n--- Disagreements ---")
        result.disagreements.forEach((d) => parts.push(`• ${d}`))
      }
      const debateContent = parts.join("\n")

      // Print debate summary to stderr for progress visibility (if interactive)
      if (process.stderr.isTTY) {
        console.error("\n" + debateContent)
      }
      finalizeOutput(debateContent, {
        query: question,
        model: `${result.responses.length} models`,
        cost: formatCost(totalResponseCost(result.responses)),
        durationMs: result.totalDurationMs,
      })
      break
    }

    case "recover":
    case "partials": {
      const responseId = getQuestion()

      // Clean up old partials if requested
      if (hasFlag("--clean")) {
        // --clean removes files older than 24h (default was 7 days)
        const deleted = cleanupPartials(24 * 60 * 60 * 1000)
        console.error(`✓ Cleaned up ${deleted} old partial file(s)`)
        break
      }

      // --clean-stale removes files older than 30 minutes
      if (hasFlag("--clean-stale")) {
        const deleted = cleanupPartials(30 * 60 * 1000)
        console.error(`✓ Cleaned up ${deleted} stale partial file(s)`)
        break
      }

      // If response ID provided, try to retrieve it
      if (responseId) {
        console.error(`Retrieving response: ${responseId}...\n`)

        // First check local partials
        const localPartial = findPartialByResponseId(responseId)
        if (localPartial) {
          console.error(
            `Found local partial (${localPartial.content.length} chars):\n`,
          )
          console.log(localPartial.content)

          if (!localPartial.metadata.completedAt) {
            console.error("\n---")
            console.error(
              "This response was interrupted. Attempting to retrieve from OpenAI...",
            )
          }
        }

        // Try to retrieve from OpenAI (with polling for in-progress responses)
        const initial = await retrieveResponse(responseId)

        if (initial.error) {
          if (!localPartial) {
            error(`Failed to retrieve: ${initial.error}`)
          }
          console.error(
            `\n⚠️  Could not retrieve from OpenAI: ${initial.error}`,
          )
        } else if (initial.status === "completed") {
          console.error("\nFull response from OpenAI:\n")
          console.log(initial.content)
          if (initial.usage) {
            console.error(`\n[${initial.usage.totalTokens} tokens]`)
          }
          // Clean up partial file
          if (localPartial) {
            const { completePartial } = await import("./lib/llm/persistence")
            completePartial(localPartial.path, { delete: true })
          }
        } else if (
          initial.status === "in_progress" ||
          initial.status === "queued"
        ) {
          console.error(`\nStatus: ${initial.status} — polling every 5s...`)
          const result = await pollForCompletion(responseId, {
            intervalMs: 5_000,
            maxAttempts: 180,
            onProgress: (status, elapsed) => {
              process.stderr.write(
                `\r⏳ ${status} (${Math.round(elapsed / 1000)}s elapsed)`,
              )
            },
          })
          process.stderr.write("\n")

          if (result.status === "completed" && result.content) {
            console.error("Full response from OpenAI:\n")
            console.log(result.content)
            if (result.usage) {
              console.error(`\n[${result.usage.totalTokens} tokens]`)
            }
            // Clean up partial file
            if (localPartial) {
              const { completePartial } = await import("./lib/llm/persistence")
              completePartial(localPartial.path, { delete: true })
            }
          } else {
            console.error(
              `Response ${result.status}${result.error ? `: ${result.error}` : ""}`,
            )
          }
        } else if (
          initial.status === "failed" ||
          initial.status === "cancelled" ||
          initial.status === "expired"
        ) {
          console.error(`\nResponse ${initial.status}`)
          // Clean up stale partial file for terminal states
          if (localPartial) {
            const { completePartial } = await import("./lib/llm/persistence")
            completePartial(localPartial.path, { delete: true })
            console.error("Cleaned up stale partial file.")
          }
        } else {
          console.error(`\nResponse status: ${initial.status}`)
        }
        break
      }

      // List all partials
      const partials = listPartials({ includeCompleted: hasFlag("--all") })

      if (partials.length === 0) {
        console.error("No incomplete responses found.")
        console.error(
          "\nPartial responses are saved automatically during deep research calls.",
        )
        console.error("If interrupted, they appear here for recovery.")
        break
      }

      console.error(`Found ${partials.length} partial response(s):\n`)

      for (const partial of partials) {
        const age = Date.now() - new Date(partial.metadata.startedAt).getTime()
        const ageStr =
          age < 3600000
            ? `${Math.round(age / 60000)}m ago`
            : age < 86400000
              ? `${Math.round(age / 3600000)}h ago`
              : `${Math.round(age / 86400000)}d ago`

        const isStale = age > 30 * 60 * 1000 // >30 min
        const status = partial.metadata.completedAt
          ? "✓ completed"
          : isStale
            ? "💀 stale"
            : "⚠️  interrupted"
        const preview = partial.content.slice(0, 100).replace(/\n/g, " ")

        console.error(`  ${partial.metadata.responseId}`)
        console.error(`    ${status} | ${ageStr} | ${partial.metadata.model}`)
        console.error(`    Topic: ${partial.metadata.topic.slice(0, 60)}...`)
        if (partial.content.length > 0) {
          console.error(
            `    Content: ${preview}${partial.content.length > 100 ? "..." : ""}`,
          )
        }
        console.error(`    (${partial.content.length} chars saved)`)
        console.error()
      }

      console.error("To retrieve a response: llm recover <response_id>")
      console.error("To clean up old partials: llm partials --clean")
      break
    }

    default:
      error(`Unknown command: ${command}`)
  }
}

main().catch((err) => {
  error(err instanceof Error ? err.message : String(err))
})
