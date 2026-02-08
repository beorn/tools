/**
 * TTY MCP Backend - manages TtyEngine sessions and implements tool handlers
 *
 * Uses Bun PTY + xterm-headless (via TtyEngine) instead of ttyd + Playwright.
 * Browser is only launched lazily for screenshots (rendering HTML to PNG).
 *
 * Robustness features:
 * - Per-tool timeouts prevent hanging on stale sessions
 * - Dead session auto-cleanup
 */

import type { Browser } from "playwright"
import { createTtyEngine, type TtyEngine } from "../tty-engine/index.js"
import {
  TtyStartInputSchema,
  TtyStopInputSchema,
  TtyPressInputSchema,
  TtyTypeInputSchema,
  TtyScreenshotInputSchema,
  TtyTextInputSchema,
  TtyWaitInputSchema,
  TtyListInputSchema,
  type TtyStartOutput,
  type TtyListOutput,
  type TtyStopOutput,
  type TtyPressOutput,
  type TtyTypeOutput,
  type TtyScreenshotOutput,
  type TtyTextOutput,
  type TtyWaitOutput,
} from "./types.js"
import { writeFile } from "fs/promises"

// Per-tool timeout in ms. Prevents any tool from hanging forever.
const TOOL_TIMEOUTS: Record<string, number> = {
  tty_list: 2_000,
  tty_stop: 10_000,
  tty_press: 5_000,
  tty_type: 5_000,
  tty_screenshot: 15_000, // may need to launch browser
  tty_text: 5_000,
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${ms}ms`)),
        ms,
      )
    }),
  ]).finally(() => clearTimeout(timer!))
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 10)
}

type ToolOutput =
  | TtyStartOutput
  | TtyListOutput
  | TtyStopOutput
  | TtyPressOutput
  | TtyTypeOutput
  | TtyScreenshotOutput
  | TtyTextOutput
  | TtyWaitOutput

export class PlaywrightTtyBackend {
  private engines = new Map<string, TtyEngine>()
  private browser: Browser | null = null

  /** Lazy-launch browser only for screenshots */
  private async ensureBrowser(): Promise<Browser> {
    if (this.browser && !this.browser.isConnected()) {
      this.browser = null
    }
    if (!this.browser) {
      const { chromium } = await import("playwright")
      const launching = chromium.launch({ headless: true })
      try {
        this.browser = await withTimeout(launching, 15_000, "chromium.launch")
      } catch (err) {
        launching.then((b) => b.close()).catch(() => {})
        throw err
      }
    }
    return this.browser
  }

  private async closeBrowser(): Promise<void> {
    if (this.browser) {
      try {
        await this.browser.close()
      } catch {
        // Browser may already be disconnected
      }
      this.browser = null
    }
  }

  private getEngine(sessionId: string): TtyEngine {
    const engine = this.engines.get(sessionId)
    if (!engine) {
      const active = Array.from(this.engines.keys()).join(", ") || "none"
      throw new Error(
        `Session not found: ${sessionId}. Active sessions: ${active}`,
      )
    }
    if (!engine.alive) {
      engine.close().catch(() => {})
      this.engines.delete(sessionId)
      throw new Error(
        `Session ${sessionId} is dead (process exited). It has been removed.`,
      )
    }
    return engine
  }

  private cleanupStaleSessions(): void {
    for (const [id, engine] of this.engines) {
      if (!engine.alive) {
        engine.close().catch(() => {})
        this.engines.delete(id)
      }
    }
  }

  async callTool(name: string, args: unknown): Promise<ToolOutput> {
    let timeoutMs = TOOL_TIMEOUTS[name] ?? 10_000

    if (name === "tty_start") {
      try {
        const parsed = TtyStartInputSchema.parse(args)
        timeoutMs = parsed.timeout + 10_000
      } catch {
        timeoutMs = 15_000
      }
    } else if (name === "tty_wait") {
      try {
        const parsed = TtyWaitInputSchema.parse(args)
        timeoutMs = parsed.timeout + 5_000
      } catch {
        timeoutMs = 35_000
      }
    }

    try {
      return await withTimeout(this.handleTool(name, args), timeoutMs, name)
    } catch (err) {
      if (err instanceof Error && err.message.includes("timed out")) {
        this.cleanupStaleSessions()
      }
      throw err
    }
  }

  private async handleTool(name: string, args: unknown): Promise<ToolOutput> {
    switch (name) {
      case "tty_start": {
        const input = TtyStartInputSchema.parse(args)
        const id = generateId()

        const engine = createTtyEngine(id, {
          command: input.command,
          env: input.env as Record<string, string> | undefined,
          cols: input.cols,
          rows: input.rows,
          cwd: input.cwd,
        })

        // Wait for initial content
        try {
          const waitFor = input.waitFor ?? "content"
          if (waitFor === "content") {
            await engine.waitForContent(input.timeout)
          } else if (waitFor === "stable") {
            await engine.waitForStable(500, input.timeout)
          } else {
            await engine.waitForText(waitFor, input.timeout)
          }
        } catch {
          // Don't fail start if wait times out — session is still usable
        }

        this.engines.set(id, engine)
        return { sessionId: id }
      }

      case "tty_list": {
        TtyListInputSchema.parse(args)
        this.cleanupStaleSessions()
        const sessions = Array.from(this.engines.values()).map((e) => ({
          id: e.id,
          command: e.command,
          createdAt: e.createdAt.toISOString(),
        }))
        return { sessions }
      }

      case "tty_stop": {
        const input = TtyStopInputSchema.parse(args)
        const engine = this.getEngine(input.sessionId)
        await engine.close()
        this.engines.delete(input.sessionId)

        // Close browser if no more sessions
        if (this.engines.size === 0) {
          await this.closeBrowser()
        }

        return { success: true }
      }

      case "tty_press": {
        const input = TtyPressInputSchema.parse(args)
        const engine = this.getEngine(input.sessionId)
        engine.press(input.key)
        return { success: true }
      }

      case "tty_type": {
        const input = TtyTypeInputSchema.parse(args)
        const engine = this.getEngine(input.sessionId)
        engine.type(input.text)
        return { success: true }
      }

      case "tty_screenshot": {
        const input = TtyScreenshotInputSchema.parse(args)
        const engine = this.getEngine(input.sessionId)
        const html = engine.getHTML()

        // Launch browser lazily for rendering
        const browser = await this.ensureBrowser()
        const context = await browser.newContext()
        const page = await context.newPage()
        try {
          await page.setContent(html, { waitUntil: "load" })
          const buffer = await page.screenshot()

          if (input.outputPath) {
            await writeFile(input.outputPath, buffer)
            return { path: input.outputPath, mimeType: "image/png" }
          }

          return { data: buffer.toString("base64"), mimeType: "image/png" }
        } finally {
          await context.close()
        }
      }

      case "tty_text": {
        const input = TtyTextInputSchema.parse(args)
        const engine = this.getEngine(input.sessionId)
        const content = engine.getText()
        return { content }
      }

      case "tty_wait": {
        const input = TtyWaitInputSchema.parse(args)
        const engine = this.getEngine(input.sessionId)

        try {
          if (input.for) {
            await engine.waitForText(input.for, input.timeout)
          } else if (input.stable) {
            await engine.waitForStable(input.stable, input.timeout)
          } else {
            await engine.waitForContent(input.timeout)
          }
          return { success: true }
        } catch (err) {
          if (err instanceof Error && err.message.includes("Timeout")) {
            return { success: false, timedOut: true }
          }
          throw err
        }
      }

      default:
        throw new Error(`Unknown tool: ${name}`)
    }
  }

  async shutdown(): Promise<void> {
    for (const engine of this.engines.values()) {
      try {
        await engine.close()
      } catch {
        // Best-effort cleanup
      }
    }
    this.engines.clear()
    await this.closeBrowser()
  }
}
