#!/usr/bin/env bun
/**
 * llm.ts - Multi-LLM research CLI
 *
 * Simple keyword-based interface:
 *   llm "question"              Quick answer, cheap (~$0.01)
 *   llm deep "topic"            Deep research with web search (~$2-5)
 *   llm opinion "question"      Second opinion from GPT/Gemini (~$0.02)
 *   llm debate "question"       Multi-model consensus (~$1-3)
 *
 * Advanced commands (backwards compat):
 *   llm ask --model X "q"       Specific model
 *   llm models --pricing        List models with costs
 */

import { ask, research, compare } from "./lib/llm/research"
import { retrieveResponse } from "./lib/llm/openai-deep"
import { listPartials, findPartialByResponseId, cleanupPartials, type PartialFile } from "./lib/llm/persistence"
import { consensus, deepConsensus } from "./lib/llm/consensus"
import { getAvailableProviders, getProviderEnvVar, isProviderAvailable } from "./lib/llm/providers"
import {
  MODELS,
  getModel,
  getModelsForLevel,
  getCheapModel,
  estimateCost,
  formatCost,
  formatLatency,
  requiresConfirmation,
  REFINEMENT_PROMPT,
  getBestAvailableModel,
  getBestAvailableModels,
  type ThinkingLevel,
} from "./lib/llm/types"
import {
  initializePricing,
  isPricingStale,
  getStaleWarning,
  cacheCurrentPricing,
  getDaysSinceUpdate,
} from "./lib/llm/pricing"
import {
  getDb,
  closeDb,
  findSimilarQueries,
  ftsSearchWithSnippet,
} from "./lib/history/db"

// Initialize pricing on startup
initializePricing()

const args = process.argv.slice(2)
const command = args[0]

function output(data: unknown): void {
  console.log(JSON.stringify(data, null, 2))
}

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
  const days = getDaysSinceUpdate()

  console.log(`
╔══════════════════════════════════════════════════════════════════════════════╗
║                        LLM - Multi-Model Research CLI                        ║
╚══════════════════════════════════════════════════════════════════════════════╝

USAGE
  llm "question"                    Answer using gpt-5.2 (~$0.02)
  llm deep "topic"                  Deep research with web search (~$2-5)
  llm opinion "question"            Second opinion from Gemini (~$0.02)
  llm debate "question"             Multi-model consensus (~$1-3)

EXAMPLES
  llm "what port does postgres use"                    Standard answer
  llm deep "best practices for TUI testing 2026"       Thorough research
  llm opinion "is my caching approach reasonable"      Get a second opinion
  llm debate "monorepo vs polyrepo for our use case"   Multiple perspectives

KEYWORDS
  (none)                 Default: gpt-5.2 (~$0.02)
  deep/research/think    Web search, citations, thorough (~$2-5, confirms)
  opinion                Second opinion from different provider (~$0.02)
  debate                 Query 3 models, synthesize consensus (~$1-3, confirms)
  quick/cheap/mini/nano  Cheap/fast model if you really want it (~$0.01)

FLAGS
  -y, --yes              Skip confirmation prompts (for scripting)
  --dry-run              Show what would happen without calling APIs
  --no-recover           Skip auto-recovery of incomplete responses

FEATURES
  • Auto-recovery: Checks for interrupted responses and recovers them
  • Checks session history first (avoids duplicate research)
  • Cost confirmation for expensive queries (deep, debate)
  • Streams responses in real-time
  • Persistence: Saves progress to disk during streaming

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

ADVANCED (backwards compatible)
  llm ask "question"                Standard query
  llm ask --model gpt-5.2 "q"       Specific model
  llm ask --with-history "q"        Include session context
  llm models --pricing              List all models with costs
  llm prepare "vague question"      Refine before expensive query

Pricing cache: ${days !== null ? `${days} days old` : "not initialized"}
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

function getQuestion(): string {
  // Find the question (first non-flag argument after command)
  const nonFlags = args.slice(1).filter((a, i, arr) => {
    if (a.startsWith("--")) return false
    // Filter short flags like -y, -h
    if (a.match(/^-[a-zA-Z]$/)) return false
    // Check if previous arg was a flag that takes a value
    if (i > 0 && arr[i - 1]?.startsWith("--")) {
      const flagName = arr[i - 1]
      if (["--model", "--models", "--provider"].includes(flagName!)) return false
    }
    return true
  })
  return nonFlags.join(" ")
}

/**
 * Check for and auto-recover incomplete responses
 * Returns true if user wants to continue with new query
 */
async function checkAndRecoverPartials(): Promise<boolean> {
  if (hasFlag("--no-recover")) return true

  const partials = listPartials()
  if (partials.length === 0) return true

  console.error(`📦 Found ${partials.length} incomplete response(s) - attempting recovery...\n`)

  let recoveredAny = false
  for (const partial of partials) {
    const age = Date.now() - new Date(partial.metadata.startedAt).getTime()
    const ageStr = age < 3600000
      ? `${Math.round(age / 60000)}m ago`
      : `${Math.round(age / 3600000)}h ago`

    console.error(`  ${partial.metadata.responseId}`)
    console.error(`    Started: ${ageStr} | Topic: ${partial.metadata.topic.slice(0, 50)}...`)

    // Try to retrieve from OpenAI
    if (partial.metadata.responseId) {
      const recovered = await retrieveResponse(partial.metadata.responseId)
      if (recovered.status === "completed" && recovered.content) {
        console.error(`    ✅ Recovered from OpenAI (${recovered.content.length} chars)`)
        console.error(`\n--- Recovered Response ---\n`)
        console.log(recovered.content)
        if (recovered.usage) {
          console.error(`\n[Recovered: ${recovered.usage.totalTokens} tokens]`)
        }
        // Clean up the partial file
        const { completePartial } = await import("./lib/llm/persistence")
        completePartial(partial.path, { delete: true })
        console.error(`\n--- End Recovered Response ---\n`)
        recoveredAny = true
      } else if (recovered.status === "in_progress" || recovered.status === "queued") {
        console.error(`    ⏳ Still ${recovered.status} on OpenAI - will complete soon`)
        console.error(`    Run 'llm recover ${partial.metadata.responseId}' to check again`)
      } else {
        console.error(`    ⚠️  Could not recover (status: ${recovered.status})`)
        if (partial.content.length > 0) {
          console.error(`    Local partial has ${partial.content.length} chars saved`)
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
  // Deep research aliases
  "deep", "research", "think",
  // Cheap/fast aliases
  "quick", "cheap", "mini", "nano",
  // Other modes
  "opinion", "debate",
  // Recovery
  "recover", "partials",
  // Original commands (backwards compat)
  "ask", "prepare", "consensus", "models", "compare", "update-pricing"
]

async function main() {
  if (!command || command === "--help" || command === "-h") {
    usage()
  }

  const jsonOutput = hasFlag("--json")

  // Check for stale pricing and warn
  const staleWarning = getStaleWarning()
  if (staleWarning && !jsonOutput && command !== "update-pricing") {
    console.error(staleWarning + "\n")
  }

  // If first arg is not a keyword, treat entire args as a question (default mode)
  const isKeyword = KEYWORDS.includes(command!)
  if (!isKeyword) {
    // Default mode: use best available model
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
          const preview = (s.user_content || "").slice(0, 100).replace(/\n/g, " ")
          console.error(`  ${relTime}: ${preview}...`)
        }
        console.error()
      }
    } catch { /* History not indexed */ }

    const { model, warning } = getBestAvailableModel("default", isProviderAvailable)
    if (!model) error("No model available. " + (warning || ""))
    if (warning) console.error(`⚠️  ${warning}\n`)

    console.error(`[${model.displayName}]\n`)

    const response = await ask(question, "standard", {
      modelOverride: model.modelId,
      stream: true,
      onToken: (token) => process.stdout.write(token),
    })

    console.log()
    if (response.usage) {
      const cost = estimateCost(model, response.usage.promptTokens, response.usage.completionTokens)
      console.error(`\n[${response.usage.totalTokens} tokens, ${formatCost(cost)}, ${response.durationMs}ms]`)
    }
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

      const { model, warning } = getBestAvailableModel("quick", isProviderAvailable)
      if (!model) error("No cheap model available. " + (warning || ""))
      if (warning) console.error(`⚠️  ${warning}\n`)

      console.error(`[${model.displayName} - quick mode]\n`)

      const response = await ask(question, "quick", {
        stream: true,
        onToken: (token) => process.stdout.write(token),
      })

      console.log()
      if (response.usage) {
        const cost = estimateCost(model, response.usage.promptTokens, response.usage.completionTokens)
        console.error(`\n[${response.usage.totalTokens} tokens, ${formatCost(cost)}, ${response.durationMs}ms]`)
      }
      break
    }

    case "opinion": {
      const question = getQuestion()
      if (!question) error("Usage: llm opinion <question>")

      const { model, warning } = getBestAvailableModel("opinion", isProviderAvailable)
      if (!model) error("No model available for second opinion. " + (warning || ""))
      if (warning) console.error(`⚠️  ${warning}\n`)

      console.error(`[Second opinion from ${model.displayName}]\n`)

      const response = await ask(question, "standard", {
        modelOverride: model.modelId,
        stream: true,
        onToken: (token) => process.stdout.write(token),
      })

      console.log()
      if (response.usage) {
        const cost = estimateCost(model, response.usage.promptTokens, response.usage.completionTokens)
        console.error(`\n[${response.usage.totalTokens} tokens, ${formatCost(cost)}, ${response.durationMs}ms]`)
      }
      break
    }

    // Deep research aliases
    case "deep":
    case "research":
    case "think": {
      const topic = getQuestion()
      if (!topic) error("Usage: llm deep <topic>")

      // Check for incomplete partials and attempt auto-recovery
      const shouldContinue = await checkAndRecoverPartials()
      if (!shouldContinue) {
        console.error("Cancelled.")
        process.exit(0)
      }

      const { model: deepModel, warning: deepWarning } = getBestAvailableModel("deep", isProviderAvailable)
      if (!deepModel) error("No deep research model available. " + (deepWarning || ""))

      console.error(`Deep research: ${topic}`)
      console.error(`Model: ${deepModel.displayName}`)
      console.error(`Estimated cost: ~$2-5\n`)
      if (deepWarning) console.error(`⚠️  ${deepWarning}\n`)

      // Dry run - show what would happen without calling API
      if (hasFlag("--dry-run")) {
        console.error("🔍 Dry run - would call deep research API")
        console.error(`   Model: ${deepModel.modelId}`)
        console.error(`   Provider: ${deepModel.provider}`)
        process.exit(0)
      }

      // Skip confirmation with --yes or -y flag
      if (!hasFlag("--yes") && !hasFlag("-y")) {
        console.error("⚠️  This uses deep research models (~$2-5). Proceed? [Y/n] ")

        const confirm = await new Promise<string>((resolve) => {
          process.stdin.setRawMode?.(true)
          process.stdin.resume()
          process.stdin.once("data", (data) => {
            process.stdin.setRawMode?.(false)
            resolve(data.toString().trim().toLowerCase())
          })
        })

        if (confirm === "n" || confirm === "no") {
          console.error("Cancelled.")
          process.exit(0)
        }
        console.error()
      }

      const response = await research(topic, {
        stream: true,
        onToken: (token) => process.stdout.write(token),
      })

      console.log()
      if (response.error) {
        console.error(`\nError: ${response.error}`)
      }
      if (response.usage) {
        const cost = estimateCost(response.model, response.usage.promptTokens, response.usage.completionTokens)
        console.error(`\n[${response.model.displayName}] ${response.usage.totalTokens} tokens, ${formatCost(cost)}, ${response.durationMs}ms`)
      }
      break
    }

    // Alias for consensus
    case "debate": {
      const question = getQuestion()
      if (!question) error("Usage: llm debate <question>")

      // Check for incomplete partials and attempt auto-recovery
      const shouldContinueDebate = await checkAndRecoverPartials()
      if (!shouldContinueDebate) {
        console.error("Cancelled.")
        process.exit(0)
      }

      const { models: debateModels, warning: debateWarning } = getBestAvailableModels("debate", isProviderAvailable, 3)
      if (debateModels.length < 2) error("Need at least 2 models for debate. " + (debateWarning || ""))

      console.error(`Multi-model debate: ${question}`)
      console.error(`Models: ${debateModels.map(m => m.displayName).join(", ")}`)
      console.error(`Estimated cost: ~$1-3\n`)
      if (debateWarning) console.error(`⚠️  ${debateWarning}\n`)

      // Dry run - show what would happen without calling API
      if (hasFlag("--dry-run")) {
        console.error("🔍 Dry run - would query these models:")
        for (const m of debateModels) {
          console.error(`   • ${m.displayName} (${m.provider})`)
        }
        process.exit(0)
      }

      // Skip confirmation with --yes or -y flag
      if (!hasFlag("--yes") && !hasFlag("-y")) {
        console.error("⚠️  This queries multiple models (~$1-3). Proceed? [Y/n] ")

        const confirm = await new Promise<string>((resolve) => {
          process.stdin.setRawMode?.(true)
          process.stdin.resume()
          process.stdin.once("data", (data) => {
            process.stdin.setRawMode?.(false)
            resolve(data.toString().trim().toLowerCase())
          })
        })

        if (confirm === "n" || confirm === "no") {
          console.error("Cancelled.")
          process.exit(0)
        }
        console.error()
      }

      const result = await consensus({
        question,
        modelIds: debateModels.map(m => m.modelId),
        synthesize: true,
        onModelComplete: (response) => {
          if (response.error) {
            console.error(`[${response.model.displayName}] Error: ${response.error}`)
          } else {
            console.error(`[${response.model.displayName}] ✓`)
          }
        },
      })

      console.log("\n--- Synthesis ---\n")
      console.log(result.synthesis || "(No synthesis)")

      if (result.agreements?.length) {
        console.log("\n--- Agreements ---")
        result.agreements.forEach(a => console.log(`• ${a}`))
      }

      if (result.disagreements?.length) {
        console.log("\n--- Disagreements ---")
        result.disagreements.forEach(d => console.log(`• ${d}`))
      }

      // Calculate total cost from all responses
      let totalCost = 0
      for (const resp of result.responses) {
        if (resp.usage) {
          totalCost += estimateCost(resp.model, resp.usage.promptTokens, resp.usage.completionTokens)
        }
      }
      console.error(`\n[${result.responses.length} models, ${formatCost(totalCost)}, ${result.totalDurationMs}ms]`)
      break
    }

    // Original commands (backwards compat)
    case "prepare": {
      const question = getQuestion()
      if (!question) error("Usage: prepare <question>")

      const targetModel = getArg("--target")
      const skipHistory = hasFlag("--no-history")

      // Check history for similar past queries
      if (!skipHistory) {
        try {
          const db = getDb()
          const similar = findSimilarQueries(db, question, { limit: 3 })
          closeDb()

          if (similar.length > 0) {
            console.error("📚 Similar past queries found:\n")
            for (const s of similar) {
              const relTime = formatRelativeTime(new Date(s.timestamp).getTime())
              const preview = (s.user_content || "").slice(0, 120).replace(/\n/g, " ")
              console.error(`  ${relTime}: ${preview}${(s.user_content?.length || 0) > 120 ? "..." : ""}`)
              if (s.assistant_content) {
                const answerPreview = s.assistant_content.slice(0, 100).replace(/\n/g, " ")
                console.error(`    → ${answerPreview}...`)
              }
              console.error()
            }
            console.error("Use --no-history to skip this check.\n")
          }
        } catch {
          // History not indexed, continue without
        }
      }

      const cheapModel = getCheapModel()
      if (!cheapModel) error("No cheap model available for question refinement")

      console.error(`Refining question with ${cheapModel.displayName}...\n`)

      if (targetModel) {
        const target = getModel(targetModel)
        if (target) {
          const cost = estimateCost(target)
          const latency = target.typicalLatencyMs
          console.error(`Target: ${target.displayName} (~${formatCost(cost)}/query, ~${formatLatency(latency ?? 5000)})\n`)
        }
      }

      const response = await ask(
        `${REFINEMENT_PROMPT}\n\nQuestion to refine:\n${question}`,
        "quick",
        {
          stream: true,
          onToken: (token) => process.stdout.write(token),
        }
      )

      console.log()
      if (response.usage) {
        console.error(`\n[Refinement cost: ${formatCost(estimateCost(cheapModel, response.usage.promptTokens, response.usage.completionTokens))}]`)
      }
      break
    }

    case "ask": {
      const question = getQuestion()
      if (!question) error("Usage: ask <question>")

      const level: ThinkingLevel = hasFlag("--quick") ? "quick" : "standard"
      const modelOverride = getArg("--model")
      const noConfirm = hasFlag("--no-confirm")
      const withHistory = hasFlag("--with-history")

      // Get the model that will be used
      let model = modelOverride ? getModel(modelOverride) : getModelsForLevel(level)[0]
      if (!model) error("No model available")

      // Build context from history if requested
      let historyContext = ""
      if (withHistory) {
        try {
          const db = getDb()
          const { results } = ftsSearchWithSnippet(db, question, { limit: 3 })
          closeDb()

          if (results.length > 0) {
            console.error("📚 Including context from session history...\n")
            historyContext = "Relevant context from previous sessions:\n\n" +
              results.map(r => {
                const role = r.type === "user" ? "User" : "Assistant"
                return `[${role}]: ${r.snippet.replace(/>>>/g, "").replace(/<<</g, "")}`
              }).join("\n\n") +
              "\n\n---\n\nNow answer the following question:\n"
          }
        } catch {
          // History not indexed, continue without
        }
      }

      // Cost confirmation for expensive models
      if (!noConfirm && !jsonOutput && requiresConfirmation(model)) {
        const cost = estimateCost(model)
        const latency = model.typicalLatencyMs
        console.error(`⚠️  ${model.displayName} is expensive:`)
        console.error(`   Estimated cost: ${formatCost(cost)}`)
        console.error(`   Estimated time: ${formatLatency(latency ?? 5000)}`)
        console.error(`\nTip: Use 'prepare' to refine your question first, or --no-confirm to skip this.`)
        console.error(`\nProceed? [y/N] `)

        // Read confirmation
        const response = await new Promise<string>((resolve) => {
          process.stdin.setRawMode?.(true)
          process.stdin.resume()
          process.stdin.once("data", (data) => {
            process.stdin.setRawMode?.(false)
            resolve(data.toString().trim().toLowerCase())
          })
        })

        if (response !== "y" && response !== "yes") {
          console.error("Cancelled.")
          process.exit(0)
        }
        console.error()
      }

      if (!jsonOutput) {
        const cost = estimateCost(model)
        console.error(`Querying ${model.displayName} (~${formatCost(cost)})...\n`)
      }

      const fullQuestion = historyContext + question
      const response = await ask(fullQuestion, level, {
        modelOverride,
        stream: !jsonOutput,
        onToken: jsonOutput ? undefined : (token) => process.stdout.write(token),
      })

      if (jsonOutput) {
        output(response)
      } else {
        if (!response.error) {
          console.log() // newline after streamed content
        }
        if (response.error) {
          console.error(`\nError: ${response.error}`)
        }
        if (response.usage) {
          const actualCost = estimateCost(model, response.usage.promptTokens, response.usage.completionTokens)
          console.error(`\n[${response.model.displayName}] ${response.usage.totalTokens} tokens, ${formatCost(actualCost)}, ${response.durationMs}ms`)
        }
      }
      break
    }

    case "consensus": {
      const question = getQuestion()
      if (!question) error("Usage: consensus <question>")

      const modelIds = getArg("--models")?.split(",")
      const synthesize = !hasFlag("--no-synthesis")

      if (!jsonOutput) {
        console.error(`Querying multiple models...\n`)
      }

      const result = await consensus({
        question,
        modelIds,
        synthesize,
        onModelComplete: jsonOutput ? undefined : (response) => {
          if (response.error) {
            console.error(`[${response.model.displayName}] Error: ${response.error}`)
          } else {
            console.error(`[${response.model.displayName}] Complete (${response.durationMs}ms)`)
          }
        },
      })

      if (jsonOutput) {
        output(result)
      } else {
        console.log("\n--- Synthesis ---\n")
        console.log(result.synthesis || "(No synthesis)")

        if (result.agreements?.length) {
          console.log("\n--- Agreements ---")
          result.agreements.forEach(a => console.log(`- ${a}`))
        }

        if (result.disagreements?.length) {
          console.log("\n--- Disagreements ---")
          result.disagreements.forEach(d => console.log(`- ${d}`))
        }

        if (result.confidence !== undefined) {
          console.log(`\nConfidence: ${Math.round(result.confidence * 100)}%`)
        }

        // Calculate total cost from all responses
        let totalCost = 0
        for (const resp of result.responses) {
          if (resp.usage) {
            totalCost += estimateCost(resp.model, resp.usage.promptTokens, resp.usage.completionTokens)
          }
        }
        console.error(`\n[${result.responses.length} models, ${formatCost(totalCost)}, ${result.totalDurationMs}ms]`)
      }
      break
    }

    case "deep": {
      const topic = getQuestion()
      if (!topic) error("Usage: deep <topic>")

      if (!jsonOutput) {
        console.error(`Deep research: ${topic}\n`)
      }

      const result = await deepConsensus(topic, {
        onModelComplete: jsonOutput ? undefined : (response) => {
          if (response.error) {
            console.error(`[${response.model.displayName}] Error: ${response.error}`)
          } else {
            console.error(`[${response.model.displayName}] Complete (${response.durationMs}ms)`)
          }
        },
      })

      if (jsonOutput) {
        output(result)
      } else {
        console.log("\n--- Deep Research Synthesis ---\n")
        console.log(result.synthesis || "(No synthesis)")

        if (result.agreements?.length) {
          console.log("\n--- Key Findings (Agreement) ---")
          result.agreements.forEach(a => console.log(`- ${a}`))
        }

        if (result.disagreements?.length) {
          console.log("\n--- Varying Perspectives ---")
          result.disagreements.forEach(d => console.log(`- ${d}`))
        }

        if (result.confidence !== undefined) {
          console.log(`\nResearch Confidence: ${Math.round(result.confidence * 100)}%`)
        }

        // Calculate total cost from all responses
        let totalCost = 0
        for (const resp of result.responses) {
          if (resp.usage) {
            totalCost += estimateCost(resp.model, resp.usage.promptTokens, resp.usage.completionTokens)
          }
        }
        console.error(`\n[${result.responses.length} deep research models, ${formatCost(totalCost)}, ${result.totalDurationMs}ms]`)
      }
      break
    }

    case "models": {
      const availableOnly = hasFlag("--available")
      const providerFilter = getArg("--provider")
      const showPricing = hasFlag("--pricing")

      let models = MODELS
      if (providerFilter) {
        models = models.filter(m => m.provider === providerFilter)
      }
      if (availableOnly) {
        models = models.filter(m => isProviderAvailable(m.provider))
      }

      if (jsonOutput) {
        output(models.map(m => ({
          ...m,
          available: isProviderAvailable(m.provider),
          estimatedCostPerQuery: estimateCost(m),
        })))
      } else {
        // Group by provider
        const byProvider = models.reduce((acc, m) => {
          if (!acc[m.provider]) acc[m.provider] = []
          acc[m.provider]!.push(m)
          return acc
        }, {} as Record<string, typeof models>)

        const available = getAvailableProviders()

        for (const [provider, providerModels] of Object.entries(byProvider)) {
          const isAvail = available.includes(provider as any)
          const envVar = getProviderEnvVar(provider as any)
          console.log(`\n${provider.toUpperCase()} ${isAvail ? "(available)" : `(set ${envVar})`}`)

          for (const m of providerModels) {
            if (showPricing) {
              const cost = estimateCost(m)
              const latency = formatLatency(m.typicalLatencyMs ?? 5000)
              const inOut = `$${m.inputPricePerM?.toFixed(2) ?? "?"} / $${m.outputPricePerM?.toFixed(2) ?? "?"}`
              console.log(`  ${m.modelId.padEnd(35)} ${formatCost(cost).padEnd(8)} ${latency.padEnd(6)} ${inOut}`)
            } else {
              const flags = [
                m.isDeepResearch ? "deep" : null,
                m.costTier,
              ].filter(Boolean).join(", ")
              console.log(`  ${m.modelId.padEnd(35)} ${m.displayName.padEnd(25)} [${flags}]`)
            }
          }
        }

        if (showPricing) {
          const days = getDaysSinceUpdate()
          console.log(`\n(Pricing per 1M tokens: input / output. Query cost assumes ~500 in, ~1000 out tokens)`)
          console.log(`(Cache age: ${days ?? "unknown"} days. Run 'update-pricing' to refresh.)`)
        }
      }
      break
    }

    case "compare": {
      const question = getQuestion()
      if (!question) error("Usage: compare --models <ids> <question>")

      const modelIds = getArg("--models")?.split(",")
      if (!modelIds || modelIds.length < 2) {
        error("compare requires --models with at least 2 comma-separated model IDs")
      }

      if (!jsonOutput) {
        console.error(`Comparing ${modelIds.length} models...\n`)
      }

      const responses = await compare(question, modelIds)

      if (jsonOutput) {
        output(responses)
      } else {
        let totalCost = 0
        for (const response of responses) {
          const cost = response.usage
            ? estimateCost(response.model, response.usage.promptTokens, response.usage.completionTokens)
            : 0
          totalCost += cost

          console.log(`\n${"=".repeat(60)}`)
          console.log(`${response.model.displayName} (${formatCost(cost)}, ${response.durationMs}ms)`)
          console.log("=".repeat(60))

          if (response.error) {
            console.log(`Error: ${response.error}`)
          } else {
            console.log(response.content)
          }
        }
        console.error(`\n[${responses.length} models, ${formatCost(totalCost)} total]`)
      }
      break
    }

    case "update-pricing": {
      console.error("Updating pricing cache from hardcoded values...")
      cacheCurrentPricing()
      const days = getDaysSinceUpdate()
      console.error(`✓ Pricing cache updated (now ${days ?? 0} days old)`)
      console.error("\nNote: For latest prices, check:")
      console.error("  - OpenAI: https://openai.com/api/pricing/")
      console.error("  - Anthropic: https://www.anthropic.com/pricing")
      console.error("  - Google: https://ai.google.dev/pricing")
      console.error("  - xAI: https://x.ai/api")
      console.error("  - Perplexity: https://docs.perplexity.ai/guides/pricing")
      break
    }

    case "recover":
    case "partials": {
      const responseId = getQuestion()

      // Clean up old partials if requested
      if (hasFlag("--clean")) {
        const deleted = cleanupPartials()
        console.error(`✓ Cleaned up ${deleted} old partial file(s)`)
        break
      }

      // If response ID provided, try to retrieve it
      if (responseId) {
        console.error(`Retrieving response: ${responseId}...\n`)

        // First check local partials
        const localPartial = findPartialByResponseId(responseId)
        if (localPartial) {
          console.error(`Found local partial (${localPartial.content.length} chars):\n`)
          console.log(localPartial.content)

          if (!localPartial.metadata.completedAt) {
            console.error("\n---")
            console.error("This response was interrupted. Attempting to retrieve from OpenAI...")
          }
        }

        // Try to retrieve from OpenAI
        const response = await retrieveResponse(responseId)

        if (response.error) {
          if (!localPartial) {
            error(`Failed to retrieve: ${response.error}`)
          }
          console.error(`\n⚠️  Could not retrieve from OpenAI: ${response.error}`)
        } else {
          console.error(`\nStatus: ${response.status}`)
          if (response.status === "completed") {
            console.error("Full response from OpenAI:\n")
            console.log(response.content)
            if (response.usage) {
              console.error(`\n[${response.usage.totalTokens} tokens]`)
            }
          } else if (response.status === "in_progress") {
            console.error("Response still in progress. Try again in a moment.")
          } else if (response.status === "queued") {
            console.error("Response is queued. Try again in a moment.")
          } else {
            console.error(`Response status: ${response.status}`)
          }
        }
        break
      }

      // List all partials
      const partials = listPartials({ includeCompleted: hasFlag("--all") })

      if (partials.length === 0) {
        console.error("No incomplete responses found.")
        console.error("\nPartial responses are saved automatically during deep research calls.")
        console.error("If interrupted, they appear here for recovery.")
        break
      }

      console.error(`Found ${partials.length} partial response(s):\n`)

      for (const partial of partials) {
        const age = Date.now() - new Date(partial.metadata.startedAt).getTime()
        const ageStr = age < 3600000
          ? `${Math.round(age / 60000)}m ago`
          : age < 86400000
            ? `${Math.round(age / 3600000)}h ago`
            : `${Math.round(age / 86400000)}d ago`

        const status = partial.metadata.completedAt ? "✓ completed" : "⚠️  interrupted"
        const preview = partial.content.slice(0, 100).replace(/\n/g, " ")

        console.error(`  ${partial.metadata.responseId}`)
        console.error(`    ${status} | ${ageStr} | ${partial.metadata.model}`)
        console.error(`    Topic: ${partial.metadata.topic.slice(0, 60)}...`)
        console.error(`    Content: ${preview}${partial.content.length > 100 ? "..." : ""}`)
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
