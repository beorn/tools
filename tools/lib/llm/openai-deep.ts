/**
 * OpenAI Deep Research using Responses API
 *
 * Uses OpenAI SDK directly to support web_search_preview tool
 * which is required for deep research models.
 */

import OpenAI from "openai"
import type { Model, ModelResponse } from "./types"

let client: OpenAI | undefined

function getClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) throw new Error("OPENAI_API_KEY not set")
    client = new OpenAI({ apiKey })
  }
  return client
}

export interface DeepResearchOptions {
  topic: string
  model: Model
  stream?: boolean
  onToken?: (token: string) => void
}

/**
 * Query OpenAI deep research model using Responses API
 */
export async function queryOpenAIDeepResearch(
  options: DeepResearchOptions
): Promise<ModelResponse> {
  const { topic, model, stream = false, onToken } = options
  const startTime = Date.now()
  const openai = getClient()

  const researchPrompt = `Research the following topic thoroughly. Provide comprehensive information with sources where possible.

Topic: ${topic}

Please provide:
1. An overview/summary
2. Key details and facts
3. Different perspectives or approaches (if applicable)
4. Recent developments or current state
5. Sources and references (if available)`

  try {
    if (stream && onToken) {
      // Streaming with Responses API
      const response = await openai.responses.create({
        model: model.modelId,
        input: researchPrompt,
        tools: [{ type: "web_search_preview" }],
        stream: true,
      })

      let fullText = ""
      let promptTokens = 0
      let completionTokens = 0

      for await (const event of response) {
        if (event.type === "response.output_text.delta") {
          const delta = event.delta || ""
          onToken(delta)
          fullText += delta
        } else if (event.type === "response.completed") {
          // Extract usage from completed event
          const usage = event.response?.usage
          if (usage) {
            promptTokens = usage.input_tokens || 0
            completionTokens = usage.output_tokens || 0
          }
        }
      }

      return {
        model,
        content: fullText,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
        },
        durationMs: Date.now() - startTime,
      }
    } else {
      // Non-streaming
      const response = await openai.responses.create({
        model: model.modelId,
        input: researchPrompt,
        tools: [{ type: "web_search_preview" }],
      })

      // Extract text from output
      let fullText = ""
      for (const item of response.output || []) {
        if (item.type === "message" && item.content) {
          for (const content of item.content) {
            if (content.type === "output_text") {
              fullText += content.text || ""
            }
          }
        }
      }

      const usage = response.usage

      return {
        model,
        content: fullText,
        usage: usage
          ? {
              promptTokens: usage.input_tokens || 0,
              completionTokens: usage.output_tokens || 0,
              totalTokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
            }
          : undefined,
        durationMs: Date.now() - startTime,
      }
    }
  } catch (error) {
    // Provide helpful error messages for common issues
    let errorMessage = error instanceof Error ? error.message : String(error)

    if (errorMessage.includes("verified")) {
      errorMessage = "Organization not verified. Visit https://platform.openai.com/settings/organization/general to verify."
    } else if (errorMessage.includes("rate_limit") || errorMessage.includes("429")) {
      errorMessage = "Rate limited. Wait a moment and try again."
    } else if (errorMessage.includes("insufficient_quota") || errorMessage.includes("billing")) {
      errorMessage = "Insufficient credits. Check your OpenAI billing at https://platform.openai.com/account/billing"
    } else if (errorMessage.includes("invalid_api_key") || errorMessage.includes("401")) {
      errorMessage = "Invalid API key. Check OPENAI_API_KEY environment variable."
    }

    return {
      model,
      content: "",
      durationMs: Date.now() - startTime,
      error: errorMessage,
    }
  }
}

/**
 * Check if a model is an OpenAI deep research model
 */
export function isOpenAIDeepResearch(model: Model): boolean {
  return model.provider === "openai" && model.isDeepResearch
}
