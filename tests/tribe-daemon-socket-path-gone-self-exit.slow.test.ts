/**
 * Tribe daemon — socket-path-gone self-exit invariant.
 *
 * Bead: `@km/bearly/hot-reload-test-leaks-cpu-spinning-successors` (P1).
 *
 * Acceptance #2 / #3: a daemon whose `--socket` path has been removed
 * from disk AND has no live clients MUST self-exit within
 * `socketPathGoneTimeoutMs + slack`. The default timeout is 30s; this
 * test allows up to 35s for completion.
 *
 * This is the defense-in-depth half of the hot-reload-test-leaks fix.
 * The other half — the test-side defensive reap in
 * `tribe-hot-reload-exit.slow.test.ts` — closes the immediate orphan
 * pattern. This daemon-side self-bail closes the broader class of
 * failure where ANYTHING (out-of-band rm, tmp-dir gc, manual cleanup)
 * deletes the socket path while the daemon is still bound to the inode.
 *
 * Without this fix, the daemon enters a CPU-busy loop per
 * `feedback-auto-panic-needs-circuit-break.md` — observed at 99% CPU
 * per process, 4 orphans = ~400% total burn.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

const DAEMON_SCRIPT = resolve(dirname(new URL(import.meta.url).pathname), "../tools/tribe-daemon.ts")

async function waitFor(fn: () => boolean | Promise<boolean>, timeout = 5000, interval = 50): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error(`waitFor timed out after ${timeout}ms`)
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe("tribe-daemon socket-path-gone self-exit", () => {
  let tmpDir: string
  let socketPath: string
  let dbPath: string
  let daemon: ChildProcess | null = null

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tribe-path-gone-"))
    socketPath = join(tmpDir, "tribe.sock")
    dbPath = join(tmpDir, "tribe.db")
    daemon = null
  })

  afterEach(() => {
    if (daemon && daemon.pid && pidAlive(daemon.pid)) {
      try {
        daemon.kill("SIGKILL")
      } catch {
        /* ignore */
      }
    }
    daemon = null
    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath)
      } catch {
        /* ignore */
      }
    }
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("self-exits within 35s when socket path is removed and no clients connect", async () => {
    daemon = spawn(
      process.execPath,
      [
        DAEMON_SCRIPT,
        "--socket",
        socketPath,
        "--db",
        dbPath,
        // Disable client-count auto-quit so the only path that ends the
        // daemon is the socket-path-gone backstop we're testing.
        "--quit-timeout",
        "-1",
      ],
      {
        stdio: ["ignore", "ignore", "pipe"],
        env: {
          ...process.env,
          TRIBE_NO_SUPPRESS: "1",
          TRIBE_NO_PLUGINS: "1",
          TRIBE_NO_AUTORELOAD: "1",
          TRIBE_ACTIVITY_LOG: "off",
        },
      },
    )

    expect(daemon.pid).toBeGreaterThan(0)
    const pid = daemon.pid!

    // Wait for the socket to exist (daemon bound it).
    await waitFor(() => existsSync(socketPath), 8000)
    expect(existsSync(socketPath)).toBe(true)

    // Remove the socket file out-of-band — simulates the test-cleanup
    // race or a manual `rm` against a live daemon's socket.
    unlinkSync(socketPath)
    expect(existsSync(socketPath)).toBe(false)

    // The backstop is 30s; allow 5s slack for the periodic check (1s tick)
    // plus process exit propagation.
    await waitFor(() => !pidAlive(pid), 35_000, 250)
    expect(pidAlive(pid)).toBe(false)
  }, 40_000) // overall test timeout: 35s wait + 5s setup overhead
})
