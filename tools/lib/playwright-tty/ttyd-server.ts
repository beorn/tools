/**
 * TtydServer factory - manages ttyd process lifecycle
 *
 * Features:
 * - Dynamic port allocation (tries ports until one is free)
 * - Ready detection (monitors stdout for "Listening on port")
 * - Graceful shutdown (SIGTERM → wait → SIGKILL)
 * - AsyncDisposable support (works with `await using`)
 */

import { spawn, type ChildProcess } from "child_process"
import { createServer } from "net"

export interface TtydServerOptions {
  command: string[]
  env?: Record<string, string>
  portRange?: [number, number]
  cwd?: string
}

export interface TtydServer {
  url: string
  port: number
  ready: Promise<void>
  close(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}

const DEFAULT_PORT_RANGE: [number, number] = [7700, 7999]

async function findFreePort(min: number, max: number): Promise<number> {
  for (let port = min; port <= max; port++) {
    const available = await isPortAvailable(port)
    if (available) return port
  }
  throw new Error(`No free port found in range ${min}-${max}`)
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once("error", () => resolve(false))
    server.once("listening", () => {
      server.close(() => resolve(true))
    })
    server.listen(port, "127.0.0.1")
  })
}

export function createTTY(options: TtydServerOptions): TtydServer {
  const { command, env = {}, portRange = DEFAULT_PORT_RANGE, cwd } = options

  let process: ChildProcess | null = null
  let port = 0
  let url = ""

  const ready = (async () => {
    port = await findFreePort(portRange[0], portRange[1])
    url = `http://127.0.0.1:${port}`

    const [cmd, ...args] = command

    process = spawn(
      "ttyd",
      ["-W", "-p", String(port), cmd, ...args],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...globalThis.process.env, FORCE_COLOR: "1", ...env },
        cwd,
      },
    )

    // Wait for ttyd to be ready
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("ttyd startup timeout (10s)"))
      }, 10000)

      // Capture output for better error messages
      const outputChunks: string[] = []

      const onData = (data: Buffer) => {
        const text = data.toString()
        outputChunks.push(text)
        if (text.includes("Listening on") || text.includes(`port: ${port}`)) {
          clearTimeout(timeout)
          resolve()
        }
      }

      const onError = (err: Error) => {
        clearTimeout(timeout)
        reject(new Error(`ttyd failed to start: ${err.message}`))
      }

      const onExit = (code: number | null) => {
        clearTimeout(timeout)
        const output = outputChunks.join("").trim()
        const details = output ? `\nOutput: ${output.slice(0, 500)}` : ""
        reject(new Error(`ttyd exited with code ${code}${details}`))
      }

      process!.stdout?.on("data", onData)
      process!.stderr?.on("data", onData)
      process!.once("error", onError)
      process!.once("exit", onExit)

      // Clean up listeners after resolution
      const cleanup = () => {
        process?.stdout?.off("data", onData)
        process?.stderr?.off("data", onData)
        process?.off("error", onError)
        process?.off("exit", onExit)
      }

      // Wrap resolve to clean up
      const originalResolve = resolve
      resolve = () => {
        cleanup()
        originalResolve()
      }
    })

    // Brief delay for WebSocket to be ready
    await new Promise((r) => setTimeout(r, 100))
  })()

  async function close(): Promise<void> {
    if (!process) return

    const p = process
    process = null

    // Try graceful shutdown first
    p.kill("SIGTERM")

    // Wait up to 2 seconds for process to exit
    const exited = await Promise.race([
      new Promise<boolean>((resolve) => {
        p.once("exit", () => resolve(true))
      }),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), 2000)
      }),
    ])

    // Force kill if still running
    if (!exited) {
      p.kill("SIGKILL")
      await new Promise<void>((resolve) => {
        p.once("exit", () => resolve())
      })
    }
  }

  return {
    get url() {
      return url
    },
    get port() {
      return port
    },
    ready,
    close,
    [Symbol.asyncDispose]: close,
  }
}
