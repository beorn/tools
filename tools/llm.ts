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

FEATURES
  • Checks session history first (avoids duplicate research)
  • Cost confirmation for expensive queries (deep, debate)
  • Streams responses in real-time

PROVIDERS
  ${available.includes("openai" as any) ? "✓" : "○"} OpenAI      ${available.includes("openai" as any) ? "ready" : "set OPENAI_API_KEY"}
  ${available.includes("anthropic" as any) ? "✓" : "○"} Anthropic   ${available.includes("anthropic" as any) ? "ready" : "set ANTHROPIC_API_KEY"}
  ${available.includes("google" as any) ? "✓" : "○"} Google      ${available.includes("google" as any) ? "ready" : "set GOOGLE_GENERATIVE_AI_API_KEY"}
  ${available.includes("xai" as any) ? "✓" : "○"} xAI (Grok)  ${available.includes("xai" as any) ? "ready" : "set XAI_API_KEY"}
  ${available.includes("perplexity" as any) ? "✓" : "○"} Perplexity  ${available.includes("perplexity" as any) ? "ready" : "set PERPLEXITY_API_KEY"}

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
    // Check if previous arg was a flag that takes a value
    if (i > 0 && arr[i - 1]?.startsWith("--")) {
      const flagName = arr[i - 1]
      if (["--model", "--models", "--provider"].includes(flagName!)) return false
    }
    return true
  })
  return nonFlags.join(" ")
}

// Keywords that trigger specific modes
const KEYWORDS = [
  // Deep research aliases
  "deep", "research", "think",
  // Cheap/fast aliases
  "quick", "cheap", "mini", "nano",
  // Other modes
  "opinion", "debate",
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

      const { model: deepModel, warning: deepWarning } = getBestAvailableModel("deep", isProviderAvailable)
      if (!deepModel) error("No deep research model available. " + (deepWarning || ""))

      console.error(`Deep research: ${topic}`)
      console.error(`Model: ${deepModel.displayName}\n`)
      if (deepWarning) console.error(`⚠️  ${deepWarning}\n`)
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

      const response = await research(topic, {
        stream: true,
        onToken: (token) => process.stdout.write(token),
      })

      console.log()
      if (response.error) {
        console.error(`\nError: ${response.error}`)
      }
      if (response.usage) {
        console.error(`\n[${response.model.displayName}] ${response.usage.totalTokens} tokens, ${response.durationMs}ms`)
      }
      break
    }

    // Alias for consensus
    case "debate": {
      const question = getQuestion()
      if (!question) error("Usage: llm debate <question>")

      const { models: debateModels, warning: debateWarning } = getBestAvailableModels("debate", isProviderAvailable, 3)
      if (debateModels.length < 2) error("Need at least 2 models for debate. " + (debateWarning || ""))

      console.error(`Multi-model debate: ${question}`)
      console.error(`Models: ${debateModels.map(m => m.displayName).join(", ")}\n`)
      if (debateWarning) console.error(`⚠️  ${debateWarning}\n`)
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

      console.error(`\n[${result.responses.length} models, ${result.totalDurationMs}ms]`)
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

        console.error(`\n[${result.responses.length} models, ${result.totalDurationMs}ms]`)
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

        console.error(`\n[${result.responses.length} deep research models, ${result.totalDurationMs}ms]`)
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
        for (const response of responses) {
          console.log(`\n${"=".repeat(60)}`)
          console.log(`${response.model.displayName} (${response.durationMs}ms)`)
          console.log("=".repeat(60))

          if (response.error) {
            console.log(`Error: ${response.error}`)
          } else {
            console.log(response.content)
          }
        }
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

    default:
      error(`Unknown command: ${command}`)
  }
}

main().catch((err) => {
  error(err instanceof Error ? err.message : String(err))
})
