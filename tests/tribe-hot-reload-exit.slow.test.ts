/**
 * Tribe hot-reload — donor-process exit invariant.
 *
 * The fix for @km/bearly/hot-reload-zombie-exit-not-forced: after SIGHUP,
 * the donor daemon MUST terminate within `spawnDelayMs + 250ms` (default
 * 1.25s) so the spawned child can take over the listening fd cleanly. Two
 * fixes preserve this invariant:
 *
 *   1. with-runtime.ts:177 — `setTimeout(() => process.exit(0), 250)` is
 *      no longer `.unref()`'d. An unref'd timer doesn't keep the event
 *      loop alive long enough to fire its own callback, so the
 *      force-exit hammer never landed.
 *   2. with-hot-reload.ts — the spawn-delay timer is no longer `.unref()`'d
 *      either, AND a belt-and-braces `process.kill(pid, "SIGKILL")` is
 *      scheduled at `spawnDelayMs + 1500ms` as a last resort if both clean
 *      shutdowns fail to terminate the process (e.g. a sync-heavy plugin
 *      starves the loop).
 *
 * This test spawns a real `tribe-daemon.ts`, sends SIGHUP, and asserts the
 * old PID is dead inside the contract window. It DOES NOT assert anything
 * about the spawned successor process — that's handled by self-heal tests.
 * The orphan child (if any) is reaped at teardown.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

const DAEMON_SCRIPT = resolve(dirname(new URL(import.meta.url).pathname), "../tools/tribe-daemon.ts")

async function waitFor(fn: () => boolean | Promise<boolean>, timeout = 5000, interval = 25): Promise<void> {
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

async function spawnDaemon(socketPath: string, dbPath: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [DAEMON_SCRIPT, "--socket", socketPath, "--db", dbPath, "--quit-timeout", "-1"],
    {
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        TRIBE_DB: dbPath,
        TRIBE_NO_SUPPRESS: "1",
        TRIBE_NO_PLUGINS: "1",
        TRIBE_NO_AUTORELOAD: "1", // disable source-watcher so only our SIGHUP fires
        TRIBE_ACTIVITY_LOG: "off",
      },
    },
  )
  await waitFor(() => existsSync(socketPath), 8000)
  return child
}

function unlinkIfExists(p: string): void {
  if (!existsSync(p)) return
  try {
    unlinkSync(p)
  } catch {
    /* ignore */
  }
}

describe("tribe-daemon hot-reload exit", () => {
  let tmpDir: string
  let socketPath: string
  let dbPath: string
  let daemon: ChildProcess | null = null
  const orphans: ChildProcess[] = []

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tribe-hotreload-"))
    socketPath = join(tmpDir, "tribe.sock")
    dbPath = join(tmpDir, "tribe.db")
    daemon = null
  })

  afterEach(async () => {
    // Reap the donor if it's somehow still alive.
    if (daemon && daemon.pid && pidAlive(daemon.pid)) {
      try {
        daemon.kill("SIGKILL")
      } catch {
        /* ignore */
      }
    }
    // Reap any successor children spawned by the hot-reload(s).
    for (const o of orphans) {
      if (o.pid && pidAlive(o.pid)) {
        try {
          o.kill("SIGKILL")
        } catch {
          /* ignore */
        }
      }
    }
    orphans.length = 0
    daemon = null
    // Belt-and-braces: any tribe-daemon whose --socket argument references
    // THIS run's tmpDir is leaked successor — the test's daemon.on("spawn")
    // handler doesn't track them. Scan + reap by CLI-arg match. Fixes
    // @km/bearly/hot-reload-test-leaks-cpu-spinning-successors.
    try {
      const out = spawnSync("pgrep", ["-af", `tribe-daemon.*${tmpDir}`], { encoding: "utf8" })
      const stdout = (out.stdout ?? "").toString()
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue
        const pid = parseInt(line.trim().split(/\s+/)[0]!, 10)
        if (Number.isFinite(pid) && pid > 0 && pidAlive(pid)) {
          try {
            process.kill(pid, "SIGKILL")
          } catch {
            /* already dead or not ours */
          }
        }
      }
    } catch {
      /* pgrep unavailable on this platform — defensive only, never fatal */
    }
    unlinkIfExists(socketPath)
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("donor process exits within 2s of SIGHUP", async () => {
    daemon = await spawnDaemon(socketPath, dbPath)
    expect(daemon.pid).toBeGreaterThan(0)
    const donorPid = daemon.pid!

    // Track the spawned child so we can reap it later.
    daemon.on("spawn", () => {})
    process.on("exit", () => {
      if (pidAlive(donorPid)) {
        try {
          process.kill(donorPid, "SIGKILL")
        } catch {
          /* ignore */
        }
      }
    })

    daemon.kill("SIGHUP")

    // Contract: donor exits within spawnDelayMs (1000) + force-exit (250) + slack (750).
    await waitFor(() => !pidAlive(donorPid), 2000)
    expect(pidAlive(donorPid)).toBe(false)
  })

  // NOTE: A "two back-to-back SIGHUPs" test was attempted but blocked on a
  // separate hot-reload bug: the donor's scope dispose calls unlinkSync on
  // the socket path (with-socket-server.ts:119-125 — `if (!inheritedFd)`).
  // The successor inherited the listening fd in-kernel, but the path on
  // disk is gone after the donor exits, so future PATH-based connections
  // fail. Tracked separately under @km/bearly/hot-reload-socket-unlink.
  // The single-SIGHUP test above is the core regression assertion for
  // this bead — it proves the donor's process.exit fires inside the
  // contract window, which is what the zombie-CPU pattern violated.
})
