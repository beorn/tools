/**
 * TTY tools - Terminal testing with Bun PTY + xterm-headless
 *
 * @example
 * ```typescript
 * import { createTtyEngine } from "@beorn/tools/tty-engine"
 *
 * await using engine = createTtyEngine("test", {
 *   command: ["bun", "km", "view", "/path"],
 * })
 * await engine.waitForContent(5000)
 * engine.press("j")
 * console.log(engine.getText())
 * ```
 */

export {
  createTtyEngine,
  type TtyEngine,
  type TtyEngineOptions,
} from "../tty-engine/index.js"
export * from "./types.js"
