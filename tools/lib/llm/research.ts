/**
 * Deep research orchestration
 *
 * Handles single-model queries with streaming support
 */

import { generateText, streamText } from "ai"
import { getLanguageModel, isProviderAvailable } from "./providers"
import type { Model, ModelResponse, ThinkingLevel } from "./types"
import { getModelsForLevel, getModel, MODELS } from "./types"

export interface QueryOptions {
  question: string
  model: Model
  systemPrompt?: string
  stream?: boolean
  onToken?: (token: string) => void
}

export interface QueryResult {
  response: ModelResponse
  stream?: AsyncIterable<string>
}

/**
 * Query a single model
 */
export async function queryModel(options: QueryOptions): Promise<QueryResult> {
  const { question, model, systemPrompt, stream = false, onToken } = options
  const startTime = Date.now()

  // Check provider availability
  if (!isProviderAvailable(model.provider)) {
    return {
      response: {
        model,
        content: "",
        durationMs: Date.now() - startTime,
        error: `Provider ${model.provider} not available (API key not set)`,
      },
    }
  }

  const languageModel = getLanguageModel(model)

  const messages = [
    ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
    { role: "user" as const, content: question },
  ]

  try {
    if (stream && onToken) {
      const result = await streamText({
        model: languageModel,
        messages,
      })

      // Consume the stream and call onToken for each part
      let fullText = ""
      for await (const part of result.textStream) {
        onToken(part)
        fullText += part
      }

      const usage = await result.usage

      return {
        response: {
          model,
          content: fullText,
          usage: usage ? {
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            totalTokens: usage.totalTokens,
          } : undefined,
          durationMs: Date.now() - startTime,
        },
      }
    } else {
      const result = await generateText({
        model: languageModel,
        messages,
      })

      return {
        response: {
          model,
          content: result.text,
          reasoning: result.reasoning?.text,
          usage: result.usage ? {
            promptTokens: result.usage.promptTokens,
            completionTokens: result.usage.completionTokens,
            totalTokens: result.usage.totalTokens,
          } : undefined,
          durationMs: Date.now() - startTime,
        },
      }
    }
  } catch (error) {
    return {
      response: {
        model,
        content: "",
        durationMs: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

/**
 * Query with a specific thinking level
 */
export async function ask(
  question: string,
  level: ThinkingLevel = "standard",
  options: { stream?: boolean; onToken?: (token: string) => void; modelOverride?: string } = {}
): Promise<ModelResponse> {
  // Get model for level, or use override
  let model: Model | undefined
  if (options.modelOverride) {
    model = getModel(options.modelOverride)
    if (!model) {
      throw new Error(`Unknown model: ${options.modelOverride}`)
    }
  } else {
    const models = getModelsForLevel(level)
    // Find first available model
    model = models.find(m => isProviderAvailable(m.provider))
    if (!model) {
      throw new Error(`No available models for level: ${level}`)
    }
  }

  const result = await queryModel({
    question,
    model,
    stream: options.stream,
    onToken: options.onToken,
  })

  return result.response
}

/**
 * Deep research query using deep research models
 */
export async function research(
  topic: string,
  options: { stream?: boolean; onToken?: (token: string) => void; modelOverride?: string } = {}
): Promise<ModelResponse> {
  // Enhance the topic with research-oriented prompting
  const researchPrompt = `Research the following topic thoroughly. Provide comprehensive information with sources where possible.

Topic: ${topic}

Please provide:
1. An overview/summary
2. Key details and facts
3. Different perspectives or approaches (if applicable)
4. Recent developments or current state
5. Sources and references (if available)`

  // Get a deep research model, or use override
  let model: Model | undefined
  if (options.modelOverride) {
    model = getModel(options.modelOverride)
    if (!model) {
      throw new Error(`Unknown model: ${options.modelOverride}`)
    }
  } else {
    // Prefer deep research models, fall back to strong standard models
    const deepModels = MODELS.filter(m => m.isDeepResearch && isProviderAvailable(m.provider))
    const strongModels = MODELS.filter(m => !m.isDeepResearch && m.costTier === "high" && isProviderAvailable(m.provider))
    model = deepModels[0] || strongModels[0]
    if (!model) {
      throw new Error("No deep research or high-tier models available")
    }
  }

  const result = await queryModel({
    question: researchPrompt,
    model,
    stream: options.stream,
    onToken: options.onToken,
  })

  return result.response
}

/**
 * Compare responses from multiple specific models
 */
export async function compare(
  question: string,
  modelIds: string[],
  options: { stream?: boolean } = {}
): Promise<ModelResponse[]> {
  const models = modelIds.map(id => {
    const model = getModel(id)
    if (!model) throw new Error(`Unknown model: ${id}`)
    return model
  })

  // Query all models in parallel
  const results = await Promise.all(
    models.map(model => queryModel({ question, model, stream: options.stream }))
  )

  return results.map(r => r.response)
}
