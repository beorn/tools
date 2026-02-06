/**
 * Terminal-specific waiting helpers for Playwright pages
 *
 * ttyd uses xterm.js with WebGL/canvas rendering, so terminal text is NOT
 * in the DOM. We read from the xterm.js buffer API via `window.term`
 * (exposed by ttyd) with fallback to `document.body.innerText`.
 *
 * Note: Functions passed to page.evaluate() run in browser context where
 * `document` and `window` are available. The terminal reading logic must
 * be inlined in each evaluate call since Node.js closures aren't available
 * in browser context.
 */

import type { Page } from "playwright"

export interface WaitOptions {
  timeout?: number
}

/**
 * Read terminal text from the page (xterm.js buffer or DOM fallback).
 * This runs page.evaluate() — the logic must be self-contained in browser context.
 */
function readTerminalText(page: Page): Promise<string> {
  return page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- browser context
    const term = (window as any).term
    if (term) {
      const buffer = term.buffer.active
      const lines: string[] = []
      for (let i = 0; i < buffer.length; i++) {
        const line = buffer.getLine(i)
        if (line) lines.push(line.translateToString(true))
      }
      return lines.join("\n")
    }
    return document.body?.innerText ?? ""
  })
}

/**
 * Browser-context function that checks for terminal content.
 * Must be self-contained (no Node.js closures).
 */
const HAS_CONTENT_FN = () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- browser context
  const term = (window as any).term
  if (term) {
    const buffer = term.buffer.active
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i)
      if (line && line.translateToString(true).trim()) return true
    }
    return false
  }
  const text = document.body?.innerText?.trim() ?? ""
  return text.length > 0
}

/**
 * Browser-context function that checks for specific text.
 * Must be self-contained (no Node.js closures).
 */
const HAS_TEXT_FN = (searchText: string) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- browser context
  const term = (window as any).term
  if (term) {
    const buffer = term.buffer.active
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i)
      if (line && line.translateToString(true).includes(searchText)) return true
    }
    return false
  }
  const content = document.body?.innerText ?? ""
  return content.includes(searchText)
}

/**
 * Wait for any content to appear in the terminal
 */
export async function waitForContent(
  page: Page,
  options: WaitOptions = {},
): Promise<void> {
  const { timeout = 5000 } = options
  await page.waitForFunction(HAS_CONTENT_FN, { timeout })
}

/**
 * Wait for specific text to appear in the terminal
 */
export async function waitForText(
  page: Page,
  text: string,
  options: WaitOptions = {},
): Promise<void> {
  const { timeout = 5000 } = options
  await page.waitForFunction(HAS_TEXT_FN, text, { timeout })
}

/**
 * Wait for terminal content stability (no changes for specified duration)
 */
export async function waitForStable(
  page: Page,
  stableMs: number = 500,
  options: WaitOptions = {},
): Promise<void> {
  const { timeout = 5000 } = options
  const startTime = Date.now()

  let lastContent = ""
  let stableStart = Date.now()

  while (Date.now() - startTime < timeout) {
    const content = await readTerminalText(page)

    if (content === lastContent) {
      if (Date.now() - stableStart >= stableMs) {
        return // Stable!
      }
    } else {
      lastContent = content
      stableStart = Date.now()
    }

    await new Promise((r) => setTimeout(r, 50))
  }

  throw new Error(`Terminal did not stabilize within ${timeout}ms`)
}

/**
 * Get the text content of the terminal
 */
export async function getTerminalText(page: Page): Promise<string> {
  return readTerminalText(page)
}
