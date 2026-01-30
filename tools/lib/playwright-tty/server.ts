/**
 * Playwright TTY MCP Backend - manages sessions and implements tool handlers
 */

import type { Browser } from "playwright"
import { chromium } from "playwright"
import { createSession, type TtySession } from "./session.js"
import {
  waitForContent,
  waitForText,
  waitForStable,
  getTerminalText,
} from "./wait-helpers.js"
import {
  TtyStartInputSchema,
  TtyResetInputSchema,
  TtyStopInputSchema,
  TtyPressInputSchema,
  TtyTypeInputSchema,
  TtyScreenshotInputSchema,
  TtyTextInputSchema,
  TtyWaitInputSchema,
  TtyListInputSchema,
  type TtyStartOutput,
  type TtyResetOutput,
  type TtyListOutput,
  type TtyStopOutput,
  type TtyPressOutput,
  type TtyTypeOutput,
  type TtyScreenshotOutput,
  type TtyTextOutput,
  type TtyWaitOutput,
} from "./types.js"
import { writeFile } from "fs/promises"

function generateId(): string {
  return Math.random().toString(36).slice(2, 10)
}

export class PlaywrightTtyBackend {
  private sessions = new Map<string, TtySession>()
  private browser: Browser | null = null

  async ensureBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: true })
    }
    return this.browser
  }

  async closeBrowser(): Promise<void> {
    if (this.browser) {
      await this.browser.close()
      this.browser = null
    }
  }

  getSession(sessionId: string): TtySession {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }
    return session
  }

  async callTool(
    name: string,
    args: unknown,
  ): Promise<
    | TtyStartOutput
    | TtyResetOutput
    | TtyListOutput
    | TtyStopOutput
    | TtyPressOutput
    | TtyTypeOutput
    | TtyScreenshotOutput
    | TtyTextOutput
    | TtyWaitOutput
  > {
    switch (name) {
      case "tty_start": {
        const input = TtyStartInputSchema.parse(args)
        const id = generateId()

        // Try to create session, with retry on browser failure
        let lastError: Error | null = null
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const browser = await this.ensureBrowser()
            const session = await createSession(id, browser, {
              command: input.command,
              env: input.env,
              viewport: input.viewport,
              waitFor: input.waitFor,
            })
            this.sessions.set(id, session)
            return { sessionId: id, url: session.url }
          } catch (err) {
            lastError = err as Error
            // On first failure, try recreating the browser
            if (attempt === 0) {
              await this.closeBrowser()
            }
          }
        }
        throw lastError
      }

      case "tty_reset": {
        const input = TtyResetInputSchema.parse(args)
        const session = this.getSession(input.sessionId)
        const url = await session.reset({
          command: input.command,
          env: input.env,
        })
        return { url }
      }

      case "tty_list": {
        TtyListInputSchema.parse(args)
        const sessions = Array.from(this.sessions.values()).map((s) => ({
          id: s.id,
          url: s.url,
          command: s.command,
          createdAt: s.createdAt.toISOString(),
        }))
        return { sessions }
      }

      case "tty_stop": {
        const input = TtyStopInputSchema.parse(args)
        const session = this.getSession(input.sessionId)
        await session.close()
        this.sessions.delete(input.sessionId)

        // Close browser if no more sessions
        if (this.sessions.size === 0) {
          await this.closeBrowser()
        }

        return { success: true }
      }

      case "tty_press": {
        const input = TtyPressInputSchema.parse(args)
        const session = this.getSession(input.sessionId)
        await session.page.keyboard.press(input.key)
        return { success: true }
      }

      case "tty_type": {
        const input = TtyTypeInputSchema.parse(args)
        const session = this.getSession(input.sessionId)
        await session.page.keyboard.type(input.text)
        return { success: true }
      }

      case "tty_screenshot": {
        const input = TtyScreenshotInputSchema.parse(args)
        const session = this.getSession(input.sessionId)
        const buffer = await session.page.screenshot()

        if (input.outputPath) {
          await writeFile(input.outputPath, buffer)
          return { path: input.outputPath, mimeType: "image/png" }
        }

        return {
          data: buffer.toString("base64"),
          mimeType: "image/png",
        }
      }

      case "tty_text": {
        const input = TtyTextInputSchema.parse(args)
        const session = this.getSession(input.sessionId)
        const content = await getTerminalText(session.page)
        return { content }
      }

      case "tty_wait": {
        const input = TtyWaitInputSchema.parse(args)
        const session = this.getSession(input.sessionId)

        try {
          if (input.for) {
            await waitForText(session.page, input.for, {
              timeout: input.timeout,
            })
          } else if (input.stable) {
            await waitForStable(session.page, input.stable, {
              timeout: input.timeout,
            })
          } else {
            await waitForContent(session.page, { timeout: input.timeout })
          }
          return { success: true }
        } catch (err) {
          if (
            err instanceof Error &&
            err.message.includes("Timeout")
          ) {
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
    // Close all sessions
    for (const session of this.sessions.values()) {
      await session.close()
    }
    this.sessions.clear()

    // Close browser
    await this.closeBrowser()
  }
}
