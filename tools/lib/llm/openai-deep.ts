/**
 * OpenAI Deep Research using Responses API
 *
 * Uses OpenAI SDK directly to support web_search_preview tool
 * which is required for deep research models.
 *
 * Features:
 * - Background mode: server continues even if client disconnects
 * - Persistence: streams to temp file so partial results aren't lost
 * - Recovery: can retrieve/resume responses by ID
 */

import OpenAI from "openai"
import type { Model, ModelResponse } from "./types"
import { getPartialPath, writePartialHeader, appendPartial, completePartial } from "./persistence"

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
  /** Use background mode for resilience (default: true for streaming) */
  background?: boolean
  /** Don't persist to temp file (default: false) */
  noPersist?: boolean
  /** Optional context to prepend to the research prompt */
  context?: string
}

/**
 * Query OpenAI deep research model using Responses API
 */
export async function queryOpenAIDeepResearch(options: DeepResearchOptions): Promise<ModelResponse> {
  const { topic, model, stream = false, onToken, noPersist = false, context } = options
  // Default to background mode for streaming to enable recovery
  const background = options.background ?? stream
  const startTime = Date.now()
  const openai = getClient()

  // Build the research prompt with optional context
  const contextSection = context ? `## Background Context\n\n${context}\n\n---\n\n` : ""

  const researchPrompt = `${contextSection}Research the following topic thoroughly. Provide comprehensive information with sources where possible.

Topic: ${topic}

Please provide:
1. An overview/summary
2. Key details and facts
3. Different perspectives or approaches (if applicable)
4. Recent developments or current state
5. Sources and references (if available)`

  try {
    if (stream && onToken) {
      // Streaming with Responses API + background mode + persistence
      const response = await openai.responses.create({
        model: model.modelId,
        input: researchPrompt,
        tools: [{ type: "web_search_preview" }],
        stream: true,
        background,
      })

      // Get response ID from the stream (first event or headers)
      let responseId = ""
      let partialPath = ""
      let fullText = ""
      let promptTokens = 0
      let completionTokens = 0
      let lastSequence = 0
      let completed = false

      for await (const event of response) {
        // Capture response ID from first event
        if (!responseId && "response" in event && event.response?.id) {
          responseId = event.response.id

          // Initialize persistence
          if (!noPersist) {
            partialPath = getPartialPath(responseId)
            writePartialHeader(partialPath, {
              responseId,
              model: model.displayName,
              modelId: model.modelId,
              topic,
              startedAt: new Date().toISOString(),
            })
          }
        }

        // Track sequence number for potential resume
        if ("sequence_number" in event && typeof event.sequence_number === "number") {
          lastSequence = event.sequence_number
        }

        if (event.type === "response.output_text.delta") {
          const delta = event.delta || ""
          onToken(delta)
          fullText += delta

          // Persist incrementally
          if (partialPath) {
            appendPartial(partialPath, delta)
          }
        } else if (event.type === "response.completed") {
          completed = true
          // Extract usage from completed event
          const usage = event.response?.usage
          if (usage) {
            promptTokens = usage.input_tokens || 0
            completionTokens = usage.output_tokens || 0
          }
        }
      }

      // If stream ended without completing (connection dropped during deep research),
      // fall back to polling retrieveResponse() until the background response finishes
      if (!completed && !responseId && background) {
        process.stderr.write("\n⚠️  Stream ended without yielding any events (no response ID received)\n")
      }
      if (!completed && responseId && background) {
        process.stderr.write("\n⏳ Stream disconnected, polling for background response...\n")
        const pollResult = await pollForCompletion(responseId, {
          intervalMs: 5_000,
          maxAttempts: 180, // 15 min max
          onProgress: (status, elapsed) => {
            process.stderr.write(`\r⏳ ${status} (${Math.round(elapsed / 1000)}s elapsed)`)
          },
        })

        if (pollResult.content) {
          // Polled content is the complete response — use it instead of stream fragments
          const newContent = pollResult.content.slice(fullText.length)
          if (newContent) onToken(newContent)
          fullText = pollResult.content
          process.stderr.write("\n")

          if (partialPath) {
            // Rewrite partial with complete content (stream fragments may be incomplete)
            writePartialHeader(partialPath, {
              responseId,
              model: model.displayName,
              modelId: model.modelId,
              topic,
              startedAt: new Date().toISOString(),
            })
            appendPartial(partialPath, fullText)
          }
        }
        if (pollResult.usage) {
          promptTokens = pollResult.usage.promptTokens
          completionTokens = pollResult.usage.completionTokens
        }
        if (pollResult.status === "completed") {
          completed = true
        }
      }

      // Mark as complete and clean up
      const usage = {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      }

      if (partialPath) {
        if (completed) {
          // Delete partial file on successful completion
          completePartial(partialPath, { delete: true, usage })
        }
        // If not completed, leave partial file for later recovery
      }

      return {
        model,
        content: fullText,
        responseId,
        usage,
        durationMs: Date.now() - startTime,
      }
    } else {
      // Non-streaming (also uses background for consistency)
      const response = await openai.responses.create({
        model: model.modelId,
        input: researchPrompt,
        tools: [{ type: "web_search_preview" }],
        background,
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
        responseId: response.id,
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
      errorMessage =
        "Organization not verified. Visit https://platform.openai.com/settings/organization/general to verify."
    } else if (errorMessage.includes("rate_limit") || errorMessage.includes("429")) {
      errorMessage = "Rate limited. Wait a moment and try again."
    } else if (errorMessage.includes("insufficient_quota") || errorMessage.includes("billing")) {
      errorMessage = "Insufficient credits. Check your OpenAI billing at https://platform.openai.com/account/billing"
    } else if (errorMessage.includes("invalid_api_key") || errorMessage.includes("401")) {
      errorMessage = "Invalid API key. Check OPENAI_API_KEY environment variable."
    }

    process.stderr.write(`\n❌ Deep research error: ${errorMessage}\n`)

    return {
      model,
      content: "",
      durationMs: Date.now() - startTime,
      error: errorMessage,
    }
  }
}

/**
 * Poll for a background response to complete
 */
export async function pollForCompletion(
  responseId: string,
  options: {
    intervalMs?: number
    maxAttempts?: number
    onProgress?: (status: string, elapsedMs: number) => void
  } = {},
): Promise<{
  status: string
  content: string
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
  error?: string
}> {
  const { intervalMs = 5_000, maxAttempts = 180 } = options
  const startTime = Date.now()

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = await retrieveResponse(responseId)

    if (result.error) {
      return result
    }

    if (result.status === "completed") {
      return result
    }

    if (result.status === "failed" || result.status === "cancelled" || result.status === "expired") {
      return { ...result, error: `Response ${result.status}` }
    }

    // Still in progress or queued - wait and retry
    options.onProgress?.(result.status, Date.now() - startTime)
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  return {
    status: "timeout",
    content: "",
    error: `Timed out after ${maxAttempts} attempts (${Math.round((maxAttempts * intervalMs) / 1000)}s)`,
  }
}

/**
 * Retrieve a response by ID from OpenAI
 */
export async function retrieveResponse(responseId: string): Promise<{
  status: string
  content: string
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
  error?: string
}> {
  const openai = getClient()

  try {
    const response = await openai.responses.retrieve(responseId)

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
      status: response.status ?? "unknown",
      content: fullText,
      usage: usage
        ? {
            promptTokens: usage.input_tokens || 0,
            completionTokens: usage.output_tokens || 0,
            totalTokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
          }
        : undefined,
    }
  } catch (error) {
    return {
      status: "error",
      content: "",
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Resume streaming a background response from a given sequence number
 */
export async function resumeStream(
  responseId: string,
  fromSequence: number,
  onToken: (token: string) => void,
): Promise<{
  content: string
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
}> {
  const openai = getClient()

  // Note: The OpenAI SDK may support streaming from a response ID
  // This is a simplified implementation - full implementation would use
  // the stream endpoint with sequence_number parameter
  const response = await retrieveResponse(responseId)

  if (response.error) {
    throw new Error(response.error)
  }

  // For now, just return the full content (streaming resume is complex)
  // In a full implementation, we'd use the streaming API with starting_after
  onToken(response.content)

  return {
    content: response.content,
    usage: response.usage,
  }
}

/**
 * Check if a model is an OpenAI deep research model
 */
export function isOpenAIDeepResearch(model: Model): boolean {
  return model.provider === "openai" && model.isDeepResearch
}
