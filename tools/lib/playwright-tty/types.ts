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
