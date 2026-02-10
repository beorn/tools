/**
 * TtyEngine - Direct PTY + xterm-headless terminal engine
 *
 * Replaces ttyd + Playwright with Bun's native PTY support and xterm-headless
 * for in-process terminal emulation. No browser, no HTTP — just a real PTY
 * feeding an xterm.js buffer.
 *
 * PTY pattern from vendor/beorn-mdtest/src/ptySession.ts
 */

import { Terminal } from "@xterm/headless"
import { SerializeAddon } from "@xterm/addon-serialize"

// ---------------------------------------------------------------------------
// Key -> ANSI mapping (subset of inkx's keyToAnsi for standalone use)
// ---------------------------------------------------------------------------

const KEY_MAP: Record<string, string | null> = {
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
  ArrowLeft: "\x1b[D",
  ArrowRight: "\x1b[C",
  Home: "\x1b[H",
  End: "\x1b[F",
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
  Enter: "\r",
  Tab: "\t",
  Backspace: "\x7f",
  Delete: "\x1b[3~",
  Escape: "\x1b",
  Space: " ",
  Control: null,
  Shift: null,
  Alt: null,
  Meta: null,
}

const MODIFIER_ALIASES: Record<string, string> = {
  ctrl: "Control",
  control: "Control",
  shift: "Shift",
  alt: "Alt",
  meta: "Meta",
  cmd: "Meta",
  option: "Alt",
}

function normalizeModifier(mod: string): string {
  return MODIFIER_ALIASES[mod.toLowerCase()] ?? mod
}

function keyToAnsi(key: string): string {
  const parts = key.split("+")
  const mainKey = parts.pop()!
  const modifiers = parts.map(normalizeModifier)

  // Single char without modifiers
  if (!modifiers.length && mainKey.length === 1) return mainKey

  // Ctrl+letter -> control code (ASCII 1-26)
  if (modifiers.includes("Control") && mainKey.length === 1) {
    const code = mainKey.toLowerCase().charCodeAt(0) - 96
    if (code >= 1 && code <= 26) return String.fromCharCode(code)
  }

  // Alt+key -> ESC prefix
  if (
    (modifiers.includes("Alt") || modifiers.includes("Meta")) &&
    mainKey.length === 1
  ) {
    return `\x1b${mainKey}`
  }

  // Look up base key in map
  const base = KEY_MAP[mainKey]
  if (base !== undefined && base !== null) return base

  // Fallback: return as-is
  return mainKey
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TtyEngine {
  id: string
  command: string[]
  createdAt: Date
  press(key: string): void
  type(text: string): void
  /** Simulate key auto-repeat: sends `count` presses with `gapMs` between each */
  repeatKey(key: string, count: number, gapMs?: number): Promise<void>
  getText(): string
  getHTML(): string
  waitForText(text: string, timeout: number): Promise<void>
  waitForStable(stableMs: number, timeout: number): Promise<void>
  waitForContent(timeout: number): Promise<void>
  readonly alive: boolean
  close(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}

export interface TtyEngineOptions {
  command: string[]
  env?: Record<string, string>
  cols?: number
  rows?: number
  cwd?: string
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const POLL_INTERVAL = 50

export function createTtyEngine(
  id: string,
  options: TtyEngineOptions,
): TtyEngine {
  const { command, env, cols = 120, rows = 40, cwd } = options

  // Set up xterm-headless
  const term = new Terminal({ cols, rows, allowProposedApi: true })
  const serialize = new SerializeAddon()
  term.loadAddon(serialize)

  // Spawn process with Bun PTY
  const proc = Bun.spawn(["bash", "-c", command.join(" ")], {
    cwd,
    env: {
      ...process.env,
      FORCE_COLOR: "1",
      TERM: "xterm-256color",
      ...env,
    },
    terminal: {
      cols,
      rows,
      data: (_terminal, data) => {
        term.write(data)
      },
    },
  })

  // Access PTY write channel (typed by @types/bun when terminal option is used)
  const pty = proc.terminal as {
    write: (data: string) => void
    close: () => void
  }

  const createdAt = new Date()
  let closed = false

  function getText(): string {
    const buf = term.buffer.active
    const lines: string[] = []
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i)
      if (line) lines.push(line.translateToString(true))
    }
    return lines.join("\n")
  }

  function getHTML(): string {
    return serialize.serializeAsHTML()
  }

  function press(key: string): void {
    if (closed) throw new Error("TtyEngine is closed")
    const ansi = keyToAnsi(key)
    pty.write(ansi)
  }

  function type(text: string): void {
    if (closed) throw new Error("TtyEngine is closed")
    pty.write(text)
  }

  async function repeatKey(
    key: string,
    count: number,
    gapMs = 33,
  ): Promise<void> {
    for (let i = 0; i < count; i++) {
      press(key)
      await new Promise((r) => setTimeout(r, gapMs))
    }
  }

  async function waitForText(text: string, timeout: number): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      if (getText().includes(text)) return
      await new Promise((r) => setTimeout(r, POLL_INTERVAL))
    }
    throw new Error(`Timeout waiting for "${text}" after ${timeout}ms`)
  }

  async function waitForStable(
    stableMs: number,
    timeout: number,
  ): Promise<void> {
    const start = Date.now()
    let lastContent = ""
    let stableStart = Date.now()

    while (Date.now() - start < timeout) {
      const content = getText()
      if (content === lastContent) {
        if (Date.now() - stableStart >= stableMs) return
      } else {
        lastContent = content
        stableStart = Date.now()
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL))
    }
    throw new Error(`Terminal did not stabilize within ${timeout}ms`)
  }

  async function waitForContent(timeout: number): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      const content = getText().trim()
      if (content.length > 0) return
      await new Promise((r) => setTimeout(r, POLL_INTERVAL))
    }
    throw new Error(`No terminal content after ${timeout}ms`)
  }

  async function close(): Promise<void> {
    if (closed) return
    closed = true

    try {
      pty.close()
    } catch {
      // Ignore cleanup errors
    }

    // SIGTERM, then wait up to 2s, then SIGKILL
    try {
      proc.kill()
      const exited = await Promise.race([
        proc.exited.then(() => true as const),
        new Promise<false>((r) => setTimeout(() => r(false), 2000)),
      ])
      if (!exited) {
        proc.kill(9) // SIGKILL
      }
    } catch {
      // Ignore cleanup errors
    }

    term.dispose()
  }

  return {
    id,
    get command() {
      return command
    },
    createdAt,
    press,
    type,
    repeatKey,
    getText,
    getHTML,
    waitForText,
    waitForStable,
    waitForContent,
    get alive() {
      return !closed && proc.exitCode === null
    },
    close,
    [Symbol.asyncDispose]: close,
  }
}
