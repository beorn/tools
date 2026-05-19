/**
 * Zod schemas for TTY MCP tools
 */

import { z } from "zod"

// Common schemas
export const SessionIdSchema = z.string().min(1)

// Tool input schemas

export const TtyStartInputSchema = z.object({
  command: z.array(z.string()).min(1),
  env: z.record(z.string(), z.string()).optional(),
  cols: z.number().int().positive().default(120),
  rows: z.number().int().positive().default(40),
  waitFor: z.union([z.literal("content"), z.literal("stable"), z.string()]).optional(),
  timeout: z.number().int().positive().default(5000),
  cwd: z.string().optional(),
  /**
   * If set, enables frame-trace mode (Visual Eyes Phase 2): every buffer
   * mutation produces a debounced PNG + JSONL row capturing render-relevant
   * state. Output lands in `frames.dir`.
   */
  frames: z
    .object({
      dir: z.string().min(1),
      debounceMs: z.number().int().positive().default(16),
      maxFrames: z.number().int().positive().default(10_000),
      dedupe: z.boolean().default(true),
      fontPath: z.string().optional(),
    })
    .optional(),
})

export const TtyTraceInputSchema = z.object({
  sessionId: SessionIdSchema,
  /** Return frames with seq > sinceSeq. Mutually exclusive with sinceTs. */
  sinceSeq: z.number().int().nonnegative().optional(),
  /** Return frames with ts >= sinceTs (ms epoch). */
  sinceTs: z.number().int().nonnegative().optional(),
})

export const TtyListInputSchema = z.object({})

export const TtyStopInputSchema = z.object({
  sessionId: SessionIdSchema,
})

export const TtyPressInputSchema = z.object({
  sessionId: SessionIdSchema,
  key: z.string().min(1), // "Enter", "ArrowDown", "Control+c", "j", etc.
})

export const TtyTypeInputSchema = z.object({
  sessionId: SessionIdSchema,
  text: z.string(),
})

export const TtyScreenshotInputSchema = z.object({
  sessionId: SessionIdSchema,
  outputPath: z.string().optional(),
  /**
   * Renderer to use. "canvas" (default) drives ghostty-web's CanvasRenderer
   * in playwright — real-fidelity truecolor + glyph shaping + retina (the
   * Visual Eyes path). "svg" keeps the legacy SVG → PNG path (deterministic
   * baseline; lower fidelity).
   */
  renderer: z.enum(["canvas", "svg"]).optional(),
  /** Override the canvas font path (absolute). Default: bundled Iosevka if available. */
  fontPath: z.string().optional(),
})

export const TtyTextInputSchema = z.object({
  sessionId: SessionIdSchema,
})

export const TtyWaitInputSchema = z.object({
  sessionId: SessionIdSchema,
  for: z.string().optional(),
  stable: z.number().int().positive().optional(),
  timeout: z.number().int().positive().default(30000),
})

// Tool output types

export interface TtyStartOutput {
  sessionId: string
}

export interface TtyListOutput {
  sessions: Array<{
    id: string
    command: string[]
    createdAt: string
  }>
}

export interface TtyStopOutput {
  success: boolean
  /** Frame-trace summary if frames mode was enabled on start. */
  frames?: {
    count: number
    uniqueCount: number
    duplicateRatio: number
    totalBytes: number
    indexFile: string
    firstTs: number | null
    lastTs: number | null
    truncated: boolean
  }
}

export interface TtyTraceOutput {
  frames: Array<{
    seq: number
    ts: number
    iso: string
    hash: string
    duplicate_of: number | null
    bytes_in_since_last: number
    ansi_input_preview: string
    buffer: { cols: number; rows: number; cursor: { row: number; col: number } }
    duration_since_prev_ms: number
    render_ms: number
    png: string | null
  }>
}

export interface TtyPressOutput {
  success: boolean
}

export interface TtyTypeOutput {
  success: boolean
}

export interface TtyScreenshotOutput {
  path?: string
  data?: string
  mimeType: "image/png"
}

export interface TtyTextOutput {
  content: string
}

export interface TtyWaitOutput {
  success: boolean
  timedOut?: boolean
}

// Type aliases for inputs
export type TtyStartInput = z.infer<typeof TtyStartInputSchema>
export type TtyListInput = z.infer<typeof TtyListInputSchema>
export type TtyStopInput = z.infer<typeof TtyStopInputSchema>
export type TtyPressInput = z.infer<typeof TtyPressInputSchema>
export type TtyTypeInput = z.infer<typeof TtyTypeInputSchema>
export type TtyScreenshotInput = z.infer<typeof TtyScreenshotInputSchema>
export type TtyTextInput = z.infer<typeof TtyTextInputSchema>
export type TtyWaitInput = z.infer<typeof TtyWaitInputSchema>
export type TtyTraceInput = z.infer<typeof TtyTraceInputSchema>
