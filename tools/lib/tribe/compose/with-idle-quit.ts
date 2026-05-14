/**
 * withIdleQuit — connection-as-lease idle timer + socket-path-gone backstop.
 *
 * Liveness is a pure function of current state, not an event-driven timer:
 *
 *   - markActive() — clear the deadline (someone is using us)
 *   - markIdle()   — set the deadline (we may be done; checkLiveness decides)
 *   - checkLiveness() — runs from a 1s tick. Also:
 *     - Expires stale pending sessions that never sent a register message
 *       (60s grace window).
 *     - Triggers shutdown when the socket path on disk has been gone for
 *       ≥ 30s AND no clients are connected — backstop for the orphan-
 *       successor CPU-spin pattern. Only active when the daemon bound its
 *       own socket (inheritFd === null); inherited-fd daemons skip this
 *       check because the socket path may be unlinked by the donor.
 *
 * On `quitTimeoutSec < 0` the timer never fires (TRIBE_QUIT_TIMEOUT=-1). On
 * `quitTimeoutSec === 0` the daemon shuts down immediately when the registry
 * empties. Both paths are independent of the socket-path backstop.
 *
 * The factory takes:
 *   - `triggerShutdown()` — what to call when the idle deadline lapses.
 *   - `tickIntervalMs` (default 1000) — how often checkLiveness runs.
 *   - `pendingExpiryMs` (default 60000) — grace for half-registered sessions.
 *   - `socketPathGoneTimeoutMs` (default 30000) — how long socket path can
 *     be missing before self-bail. 0 disables the check.
 *
 * Bead: `@km/bearly/hot-reload-test-leaks-cpu-spinning-successors` (P1) —
 * pairs with the test-side defensive reap. Either fix in isolation closes
 * the user-visible symptom; both together close the failure mode.
 *
 * Cleanup: clearInterval registered on root scope.
 */

import { existsSync } from "node:fs"
import { createLogger } from "loggily"
import type { BaseTribe } from "./base.ts"
import type { WithClientRegistry } from "./with-client-registry.ts"
import type { WithConfig } from "./with-config.ts"

const log = createLogger("tribe:idle-quit")

export interface IdleQuitOpts {
  /** Called when the idle deadline lapses. Wired to the daemon's shutdown(). */
  triggerShutdown: () => void
  /** Tick interval — how often to evaluate liveness. Default 1000ms. */
  tickIntervalMs?: number
  /** Grace window for stale pending sessions. Default 60000ms. */
  pendingExpiryMs?: number
  /**
   * Backstop window — how long the socket path can be missing on disk
   * before the daemon self-bails (with no clients). Default 30000ms; 0
   * disables. Only active when the daemon bound its own socket
   * (inheritFd === null) — inherited-fd daemons skip this check because
   * the donor process may unlink the path mid-handoff.
   */
  socketPathGoneTimeoutMs?: number
  /**
   * Filesystem existence probe — primarily for tests. Defaults to
   * `existsSync` from node:fs. Tests inject a fake to simulate a
   * vanishing socket path without touching the real filesystem.
   */
  socketPathExists?: (path: string) => boolean
  /** Clock override — primarily for tests. Defaults to `Date.now`. */
  now?: () => number
}

export interface IdleQuit {
  markActive(): void
  markIdle(): void
  /** Currently scheduled deadline (ms epoch) or null when active. Tests inspect this. */
  getDeadline(): number | null
}

export interface WithIdleQuit {
  readonly idleQuit: IdleQuit
}

export function withIdleQuit<T extends BaseTribe & WithConfig & WithClientRegistry>(
  opts: IdleQuitOpts,
): (t: T) => T & WithIdleQuit {
  return (t) => {
    const quitTimeoutSec = t.config.quitTimeoutSec
    const tickIntervalMs = opts.tickIntervalMs ?? 1000
    const pendingExpiryMs = opts.pendingExpiryMs ?? 60_000
    const socketPathGoneTimeoutMs = opts.socketPathGoneTimeoutMs ?? 30_000
    const socketPathExists = opts.socketPathExists ?? existsSync
    const now = opts.now ?? Date.now
    const { clients, socketToClient } = t.registry
    const socketPath = t.config.socketPath
    // The socket-path backstop is only meaningful when we bound our own
    // socket. Inherited-fd daemons (hot-reload successors) may legitimately
    // run after the donor unlinked the path — skip the check for them. The
    // donor cleanup path is fixed separately under
    // `@km/bearly/hot-reload-socket-unlink`.
    const socketPathWatchEnabled = socketPathGoneTimeoutMs > 0 && t.config.inheritFd === null

    let idleDeadline: number | null = null
    let socketPathGoneSince: number | null = null

    function markActive(): void {
      idleDeadline = null
    }

    function markIdle(): void {
      if (quitTimeoutSec < 0) return // -1 disables auto-quit
      if (idleDeadline !== null) return // already counting down
      idleDeadline = now() + quitTimeoutSec * 1000
      log.info?.(`No clients connected. Auto-quit in ${quitTimeoutSec}s...`)
    }

    function checkSocketPathGone(nowMs: number): void {
      if (!socketPathWatchEnabled) return
      // Path watch only matters when nobody is connected — a daemon with
      // live clients is still serving them via the bound fd even if the
      // path was unlinked out-of-band.
      if (clients.size > 0) {
        socketPathGoneSince = null
        return
      }
      const exists = socketPathExists(socketPath)
      if (exists) {
        socketPathGoneSince = null
        return
      }
      if (socketPathGoneSince === null) {
        socketPathGoneSince = nowMs
        log.warn?.(`socket path missing at ${socketPath} — starting backstop countdown`)
        return
      }
      if (nowMs - socketPathGoneSince >= socketPathGoneTimeoutMs) {
        log.warn?.(
          `daemon self-exit: socket path gone for ${Math.floor((nowMs - socketPathGoneSince) / 1000)}s and no clients ` +
            `(path=${socketPath})`,
        )
        opts.triggerShutdown()
      }
    }

    function checkLiveness(): void {
      const nowMs = now()
      // Expire pending sessions that never sent a register message
      for (const [connId, client] of clients) {
        if (client.role === "pending" && nowMs - client.registeredAt > pendingExpiryMs) {
          log.info?.(
            `Expiring stale pending session: ${client.name} (age=${Math.floor((nowMs - client.registeredAt) / 1000)}s)`,
          )
          clients.delete(connId)
          socketToClient.delete(client.socket)
          try {
            client.socket.destroy()
          } catch {
            /* already dead */
          }
        }
      }

      // Socket-path-gone backstop — independent of the idle-deadline path
      // because it has its own deadline and gates on a different signal
      // (path existence vs. client count over time).
      checkSocketPathGone(nowMs)

      if (idleDeadline === null) return
      // Defensive: if a client snuck in, abort the countdown
      if (clients.size > 0) {
        idleDeadline = null
        return
      }
      if (nowMs >= idleDeadline) {
        log.info?.("Auto-quit: idle deadline reached")
        opts.triggerShutdown()
      }
    }

    const interval = setInterval(checkLiveness, tickIntervalMs) as unknown as { unref?: () => void }
    interval.unref?.()
    t.scope.defer(() => clearInterval(interval as unknown as ReturnType<typeof setInterval>))

    // Begin idle countdown immediately. If a client connects before the
    // deadline, markActive() (called from withDispatcher's accept-handler)
    // clears it. This handles the case where a daemon is spawned but no client
    // ever connects (e.g. spawning test crashes).
    if (clients.size === 0) markIdle()

    return {
      ...t,
      idleQuit: { markActive, markIdle, getDeadline: () => idleDeadline },
    }
  }
}
