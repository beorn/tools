/**
 * Terminal-specific waiting helpers for Playwright pages
 */

import type { Page } from "playwright"

export interface WaitOptions {
  timeout?: number
}

/**
 * Wait for any content to appear in the terminal (non-empty body)
 */
export async function waitForContent(
  page: Page,
  options: WaitOptions = {},
): Promise<void> {
  const { timeout = 30000 } = options

  await page.waitForFunction(
    () => {
      const body = document.body
      const text = body?.innerText?.trim() ?? ""
      return text.length > 0
    },
    { timeout },
  )
}

/**
 * Wait for specific text to appear in the terminal
 */
export async function waitForText(
  page: Page,
  text: string,
  options: WaitOptions = {},
): Promise<void> {
  const { timeout = 30000 } = options

  await page.waitForFunction(
    (searchText) => {
      const body = document.body
      const content = body?.innerText ?? ""
      return content.includes(searchText)
    },
    text,
    { timeout },
  )
}

/**
 * Wait for DOM stability (no changes for specified duration)
 */
export async function waitForStable(
  page: Page,
  stableMs: number = 500,
  options: WaitOptions = {},
): Promise<void> {
  const { timeout = 30000 } = options
  const startTime = Date.now()

  let lastContent = ""
  let stableStart = Date.now()

  while (Date.now() - startTime < timeout) {
    const content = await page.evaluate(() => document.body?.innerHTML ?? "")

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

  throw new Error(`DOM did not stabilize within ${timeout}ms`)
}

/**
 * Get the text content of the terminal
 */
export async function getTerminalText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const body = document.body
    return body?.innerText ?? ""
  })
}
