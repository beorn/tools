#!/usr/bin/env bun
/**
 * Playwright TTY MCP Server
 *
 * Self-contained MCP server for interactive terminal testing.
 * Manages ttyd + Playwright browser sessions.
 *
 * On first use, Chromium is installed to a local cache directory.
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

async function ensureTtydInstalled(): Promise<void> {
  try {
    const { exitCode } = await $`which ttyd`.quiet()
    if (exitCode !== 0) throw new Error("not found")
  } catch {
    console.error(`
ERROR: ttyd is not installed or not in PATH.

ttyd is required for the TTY MCP server to work.

Install with one of:
  brew install ttyd        # macOS
  nix-shell -p ttyd        # Nix
  apt install ttyd         # Debian/Ubuntu

Or visit: https://github.com/tsl0922/ttyd
`)
    process.exit(1)
  }
}

async function ensureBrowserInstalled(): Promise<void> {
  // Check if chromium is already installed
  const chromiumPath = join(BROWSER_CACHE, "chromium-")
  const cacheExists = existsSync(BROWSER_CACHE)

  if (cacheExists) {
    // Check for any chromium directory
    const { stdout } = await $`ls -d ${BROWSER_CACHE}/chromium-* 2>/dev/null || true`.quiet()
    if (stdout.toString().trim()) {
      return // Browser already installed
    }
  }

  // Install chromium to cache
  console.error("Installing Chromium browser (first-time setup)...")
  await $`bunx playwright install chromium`.env({
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: BROWSER_CACHE,
  })
  console.error("Chromium installed successfully")
}

async function main() {
  // Ensure dependencies are available
  await ensureTtydInstalled()
  await ensureBrowserInstalled()

  const backend = new PlaywrightTtyBackend()

  const server = new McpServer({
    name: "tty",
    version: "1.0.0",
  })

  // start - Start ttyd + open Playwright browser
  server.registerTool(
    "start",
    {
      description:
        "Start a terminal session with ttyd and connect Playwright browser",
      inputSchema: {
        command: z.array(z.string()).describe("Command to run (e.g. ['bun', 'km', 'view', '/path'])"),
        env: z.record(z.string()).optional().describe("Environment variables"),
        viewport: z
          .object({
            width: z.number().default(1000),
            height: z.number().default(700),
          })
          .optional()
          .describe("Browser viewport size"),
        waitFor: z
          .union([z.literal("content"), z.literal("stable"), z.string()])
          .optional()
          .describe("Wait condition: 'content', 'stable', or specific text"),
      },
    },
    async (args) => {
      const result = await backend.callTool("tty_start", args)
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      }
    },
  )

  // reset - Restart TTY, keep browser open
  server.registerTool(
    "reset",
    {
      description: "Restart the TTY process without closing the browser",
      inputSchema: {
        sessionId: z.string().describe("Session ID"),
        command: z.array(z.string()).optional().describe("New command (optional)"),
        env: z.record(z.string()).optional().describe("New environment (optional)"),
      },
    },
    async (args) => {
      const result = await backend.callTool("tty_reset", args)
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

  // stop - Close browser + stop ttyd
  server.registerTool(
    "stop",
    {
      description: "Stop a TTY session and close the browser",
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
      description: "Capture a screenshot of the terminal",
      inputSchema: {
        sessionId: z.string().describe("Session ID"),
        outputPath: z
          .string()
          .optional()
          .describe("File path to save (returns base64 if omitted)"),
      },
    },
    async (args) => {
      const result = await backend.callTool("tty_screenshot", args) as {
        path?: string
        data?: string
        mimeType: "image/png"
      }

      if (result.data) {
        // Return as image content for Claude to see
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
      description: "Wait for specific text or DOM stability",
      inputSchema: {
        sessionId: z.string().describe("Session ID"),
        for: z.string().optional().describe("Text to wait for"),
        stable: z
          .number()
          .optional()
          .describe("Wait for DOM stability (milliseconds)"),
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
