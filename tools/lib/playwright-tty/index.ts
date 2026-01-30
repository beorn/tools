/**
 * Playwright TTY - Terminal testing with ttyd + Playwright
 *
 * @example
 * ```typescript
 * import { createTTY } from "@beorn/claude-tools/playwright-tty"
 *
 * test("renders correctly", async ({ page }) => {
 *   await using ttyd = createTTY({ command: ["bun", "km", "view", "/path"] })
 *   await ttyd.ready
 *
 *   await page.goto(ttyd.url)
 *   await expect(page.locator("body")).toContainText("Hello")
 * })
 * ```
 */

export { createTTY, type TtydServer, type TtydServerOptions } from "./ttyd-server.js"
export {
  waitForContent,
  waitForText,
  waitForStable,
  getTerminalText,
} from "./wait-helpers.js"
export * from "./types.js"
