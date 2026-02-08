#!/usr/bin/env bun
/**
 * TTY MCP Server
 *
 * Self-contained MCP server for interactive terminal testing.
 * Uses Bun PTY + xterm-headless for terminal emulation.
 * Browser is only launched lazily for screenshot rendering.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { existsSync } from "fs"
import { join, dirname } from "path"
import { $ } from "bun"
import { PlaywrightTtyBackend } from "./lib/playwright-tty/server.js"

// Browser cache location (sibling to this file)
const BROWSER_CACHE = join(dirname(import.meta.path), ".playwright-cache")
process.env.PLAYWRIGHT_BROWSERS_PATH = BROWSER_CACHE

async function ensureBrowserInstalled(): Promise<void> {
  const cacheExists = existsSync(BROWSER_CACHE)

  if (cacheExists) {
    const { stdout } =
      await $`ls -d ${BROWSER_CACHE}/chromium-* 2>/dev/null || true`.quiet()
    if (stdout.toString().trim()) {
      return
    }
  }

  console.error("Installing Chromium browser (first-time setup)...")
  await $`bunx playwright install chromium`.env({
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: BROWSER_CACHE,
  })
  console.error("Chromium installed successfully")
}

async function main() {
  await ensureBrowserInstalled()

  const backend = new PlaywrightTtyBackend()

  const server = new McpServer({
    name: "tty",
    version: "2.0.0",
  })

  // start - Start a terminal session with Bun PTY
  server.registerTool(
    "start",
    {
      description:
        "Start a terminal session with a PTY and xterm-headless emulator",
      inputSchema: {
        command: z
          .array(z.string())
          .describe("Command to run (e.g. ['bun', 'km', 'view', '/path'])"),
        env: z
          .record(z.string(), z.string())
          .optional()
          .describe("Environment variables"),
        cols: z
          .number()
          .default(120)
          .describe("Terminal columns (default: 120)"),
        rows: z.number().default(40).describe("Terminal rows (default: 40)"),
        waitFor: z
          .union([z.literal("content"), z.literal("stable"), z.string()])
          .optional()
          .describe("Wait condition: 'content', 'stable', or specific text"),
        timeout: z
          .number()
          .default(5000)
          .describe("Timeout in ms for waitFor condition (default: 5000)"),
        cwd: z.string().optional().describe("Working directory"),
      },
    },
    async (args) => {
      const result = await backend.callTool("tty_start", args)
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      }
    },
  )

  // list - List active sessions
  server.registerTool(
    "list",
    {
      description: "List all active TTY sessions",
      inputSchema: {},
    },
    async (args) => {
      const result = await backend.callTool("tty_list", args)
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      }
    },
  )

  // stop - Close a terminal session
  server.registerTool(
    "stop",
    {
      description: "Stop a TTY session and kill the process",
      inputSchema: {
        sessionId: z.string().describe("Session ID to stop"),
      },
    },
    async (args) => {
      const result = await backend.callTool("tty_stop", args)
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      }
    },
  )

  // press - Press keyboard key(s)
  server.registerTool(
    "press",
    {
      description:
        "Press a keyboard key (e.g. 'Enter', 'ArrowDown', 'Control+c', 'j')",
      inputSchema: {
        sessionId: z.string().describe("Session ID"),
        key: z.string().describe("Key to press (Playwright key format)"),
      },
    },
    async (args) => {
      const result = await backend.callTool("tty_press", args)
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      }
    },
  )

  // type - Type text
  server.registerTool(
    "type",
    {
      description: "Type text into the terminal",
      inputSchema: {
        sessionId: z.string().describe("Session ID"),
        text: z.string().describe("Text to type"),
      },
    },
    async (args) => {
      const result = await backend.callTool("tty_type", args)
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      }
    },
  )

  // screenshot - Capture screenshot
  server.registerTool(
    "screenshot",
    {
      description:
        "Capture a screenshot of the terminal (launches browser for rendering)",
      inputSchema: {
        sessionId: z.string().describe("Session ID"),
        outputPath: z
          .string()
          .optional()
          .describe("File path to save (returns base64 if omitted)"),
      },
    },
    async (args) => {
      const result = (await backend.callTool("tty_screenshot", args)) as {
        path?: string
        data?: string
        mimeType: "image/png"
      }

      if (result.data) {
        return {
          content: [
            {
              type: "image",
              data: result.data,
              mimeType: result.mimeType,
            },
          ],
        }
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      }
    },
  )

  // text - Get terminal text content
  server.registerTool(
    "text",
    {
      description: "Get the text content of the terminal",
      inputSchema: {
        sessionId: z.string().describe("Session ID"),
      },
    },
    async (args) => {
      const result = await backend.callTool("tty_text", args)
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      }
    },
  )

  // wait - Wait for text/stability
  server.registerTool(
    "wait",
    {
      description: "Wait for specific text or terminal stability",
      inputSchema: {
        sessionId: z.string().describe("Session ID"),
        for: z.string().optional().describe("Text to wait for"),
        stable: z
          .number()
          .optional()
          .describe("Wait for terminal stability (milliseconds)"),
        timeout: z.number().default(30000).describe("Timeout in milliseconds"),
      },
    },
    async (args) => {
      const result = await backend.callTool("tty_wait", args)
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      }
    },
  )

  // Handle shutdown
  process.on("SIGINT", async () => {
    await backend.shutdown()
    process.exit(0)
  })

  process.on("SIGTERM", async () => {
    await backend.shutdown()
    process.exit(0)
  })

  // Connect to stdio transport
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
