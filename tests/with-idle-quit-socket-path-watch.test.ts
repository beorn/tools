/**
 * `withIdleQuit` — socket-path-gone backstop.
 *
 * Bead: `@km/bearly/hot-reload-test-leaks-cpu-spinning-successors` (P1).
 *
 * The backstop fires when the daemon's socket path on disk has been gone
 * for ≥ `socketPathGoneTimeoutMs` AND no clients are connected. This
 * catches the orphan-successor pattern: a hot-reload successor inherits
 * the listening fd, the donor (or the test) unlinks the socket path, and
 * the successor enters a CPU-busy loop with no live clients. Without this
 * backstop, the successor runs at 99% CPU until manually killed.
 *
 * The check is gated on `inheritFd === null` — inherited-fd daemons may
 * legitimately run after the donor unlinked the path mid-handoff.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { withIdleQuit, type IdleQuitOpts } from "../tools/lib/tribe/compose/with-idle-quit.ts"

interface FakeClock {
  now: () => number
  advance: (ms: number) => void
}

function createFakeClock(start = 1_000): FakeClock {
  let clock = start
  return {
    now: () => clock,
    advance(ms: number) {
      clock += ms
    },
  }
}

interface FakeScheduler {
  /** Drain all setInterval callbacks scheduled so far. */
  drain: () => void
}

function withFakeInterval(): FakeScheduler {
  const tickFns: Array<() => void> = []
  const origSetInterval = globalThis.setInterval
  globalThis.setInterval = ((fn: () => void) => {
    tickFns.push(fn)
    // Return a fake handle that .unref() is happy with
    return { unref: () => {} } as unknown as ReturnType<typeof setInterval>
  }) as typeof setInterval
  const origClearInterval = globalThis.clearInterval
  globalThis.clearInterval = ((_handle: unknown) => {
    /* no-op for tests; deferred via scope */
  }) as typeof clearInterval
  return {
    drain() {
      for (const fn of tickFns) fn()
    },
    // Restore is the caller's responsibility (afterEach).
  } as FakeScheduler & { restore: () => void }
}

interface FakeTribeOpts {
  socketPath: string
  inheritFd: number | null
  quitTimeoutSec: number
  clientCount: number
}

function makeFakeTribe(opts: FakeTribeOpts) {
  const deferred: Array<() => void> = []
  return {
    scope: {
      defer(fn: () => void) {
        deferred.push(fn)
      },
      _deferred: deferred,
    },
    config: {
      socketPath: opts.socketPath,
      inheritFd: opts.inheritFd,
      quitTimeoutSec: opts.quitTimeoutSec,
    },
    registry: {
      clients: {
        size: opts.clientCount,
        [Symbol.iterator]() {
          return [].values()
        },
      } as any,
      socketToClient: new Map(),
    },
  }
}

describe("withIdleQuit — socket-path-gone backstop", () => {
  // The watchdog uses `log.warn` from loggily which falls back to
  // console.warn. The km vitest setup treats console output as a test
  // failure, so we spy + suppress for this whole suite — the asserted
  // behavior is the triggerShutdown call, not the log line itself.
  let warnSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
  })
  afterEach(() => {
    warnSpy.mockRestore()
  })

  test("triggers shutdown when path is missing for >= 30s with zero clients", () => {
    const clock = createFakeClock()
    const scheduler = withFakeInterval() as ReturnType<typeof withFakeInterval> & { restore?: () => void }
    try {
      const triggerShutdown = vi.fn()
      // Simulate a path that is missing the entire time.
      const fakeExists = vi.fn().mockReturnValue(false)
      const tribe = makeFakeTribe({
        socketPath: "/tmp/tribe-fake.sock",
        inheritFd: null,
        quitTimeoutSec: -1, // disable client-count auto-quit so we isolate the path check
        clientCount: 0,
      })
      const opts: IdleQuitOpts = {
        triggerShutdown,
        now: clock.now,
        socketPathExists: fakeExists,
        socketPathGoneTimeoutMs: 30_000,
        // tickIntervalMs is irrelevant under fake interval — drain() advances.
      }
      withIdleQuit(opts)(tribe as never)
      // First tick: notices the path is missing, starts the countdown.
      scheduler.drain()
      expect(triggerShutdown).not.toHaveBeenCalled()
      // Advance < 30s, tick again: still no trigger.
      clock.advance(29_999)
      scheduler.drain()
      expect(triggerShutdown).not.toHaveBeenCalled()
      // Cross the threshold.
      clock.advance(2)
      scheduler.drain()
      expect(triggerShutdown).toHaveBeenCalledTimes(1)
    } finally {
      globalThis.setInterval = setInterval
      globalThis.clearInterval = clearInterval
    }
  })

  test("does NOT trigger when clients are connected (even if path is gone)", () => {
    const clock = createFakeClock()
    const scheduler = withFakeInterval()
    try {
      const triggerShutdown = vi.fn()
      const fakeExists = vi.fn().mockReturnValue(false)
      const tribe = makeFakeTribe({
        socketPath: "/tmp/tribe-fake.sock",
        inheritFd: null,
        quitTimeoutSec: -1,
        clientCount: 1, // a client IS connected
      })
      withIdleQuit({
        triggerShutdown,
        now: clock.now,
        socketPathExists: fakeExists,
        socketPathGoneTimeoutMs: 30_000,
      })(tribe as never)
      scheduler.drain()
      clock.advance(60_000)
      scheduler.drain()
      expect(triggerShutdown).not.toHaveBeenCalled()
    } finally {
      globalThis.setInterval = setInterval
      globalThis.clearInterval = clearInterval
    }
  })

  test("does NOT trigger when path exists (typical happy-path)", () => {
    const clock = createFakeClock()
    const scheduler = withFakeInterval()
    try {
      const triggerShutdown = vi.fn()
      const fakeExists = vi.fn().mockReturnValue(true)
      const tribe = makeFakeTribe({
        socketPath: "/tmp/tribe-fake.sock",
        inheritFd: null,
        quitTimeoutSec: -1,
        clientCount: 0,
      })
      withIdleQuit({
        triggerShutdown,
        now: clock.now,
        socketPathExists: fakeExists,
        socketPathGoneTimeoutMs: 30_000,
      })(tribe as never)
      scheduler.drain()
      clock.advance(60_000)
      scheduler.drain()
      expect(triggerShutdown).not.toHaveBeenCalled()
    } finally {
      globalThis.setInterval = setInterval
      globalThis.clearInterval = clearInterval
    }
  })

  test("is disabled when inheritFd !== null (hot-reload successor)", () => {
    const clock = createFakeClock()
    const scheduler = withFakeInterval()
    try {
      const triggerShutdown = vi.fn()
      // Path is missing — but inheritFd is set, so the check is skipped.
      const fakeExists = vi.fn().mockReturnValue(false)
      const tribe = makeFakeTribe({
        socketPath: "/tmp/tribe-fake.sock",
        inheritFd: 11,
        quitTimeoutSec: -1,
        clientCount: 0,
      })
      withIdleQuit({
        triggerShutdown,
        now: clock.now,
        socketPathExists: fakeExists,
        socketPathGoneTimeoutMs: 30_000,
      })(tribe as never)
      scheduler.drain()
      clock.advance(120_000)
      scheduler.drain()
      expect(triggerShutdown).not.toHaveBeenCalled()
      expect(fakeExists).not.toHaveBeenCalled()
    } finally {
      globalThis.setInterval = setInterval
      globalThis.clearInterval = clearInterval
    }
  })

  test("resets countdown when path reappears mid-check", () => {
    const clock = createFakeClock()
    const scheduler = withFakeInterval()
    try {
      const triggerShutdown = vi.fn()
      // First two checks: missing. Then path exists. Then missing again.
      const fakeExists = vi
        .fn()
        .mockReturnValueOnce(false) // tick 1 — start countdown
        .mockReturnValueOnce(false) // tick 2 — 20s in, still counting
        .mockReturnValueOnce(true) // tick 3 — path back, reset
        .mockReturnValueOnce(false) // tick 4 — missing again, fresh countdown
        .mockReturnValue(false) // subsequent — still missing
      const tribe = makeFakeTribe({
        socketPath: "/tmp/tribe-fake.sock",
        inheritFd: null,
        quitTimeoutSec: -1,
        clientCount: 0,
      })
      withIdleQuit({
        triggerShutdown,
        now: clock.now,
        socketPathExists: fakeExists,
        socketPathGoneTimeoutMs: 30_000,
      })(tribe as never)
      scheduler.drain() // tick 1: missing, start
      clock.advance(20_000)
      scheduler.drain() // tick 2: still missing, 20s in
      expect(triggerShutdown).not.toHaveBeenCalled()
      clock.advance(5_000)
      scheduler.drain() // tick 3: path back, reset
      expect(triggerShutdown).not.toHaveBeenCalled()
      clock.advance(5_000)
      scheduler.drain() // tick 4: missing again, fresh countdown
      expect(triggerShutdown).not.toHaveBeenCalled()
      clock.advance(29_999)
      scheduler.drain() // 29.999s into fresh countdown — not yet
      expect(triggerShutdown).not.toHaveBeenCalled()
      clock.advance(2)
      scheduler.drain() // 30.001s into fresh countdown — fires
      expect(triggerShutdown).toHaveBeenCalledTimes(1)
    } finally {
      globalThis.setInterval = setInterval
      globalThis.clearInterval = clearInterval
    }
  })

  test("is disabled when socketPathGoneTimeoutMs === 0", () => {
    const clock = createFakeClock()
    const scheduler = withFakeInterval()
    try {
      const triggerShutdown = vi.fn()
      const fakeExists = vi.fn().mockReturnValue(false)
      const tribe = makeFakeTribe({
        socketPath: "/tmp/tribe-fake.sock",
        inheritFd: null,
        quitTimeoutSec: -1,
        clientCount: 0,
      })
      withIdleQuit({
        triggerShutdown,
        now: clock.now,
        socketPathExists: fakeExists,
        socketPathGoneTimeoutMs: 0, // disabled
      })(tribe as never)
      scheduler.drain()
      clock.advance(120_000)
      scheduler.drain()
      expect(triggerShutdown).not.toHaveBeenCalled()
      expect(fakeExists).not.toHaveBeenCalled()
    } finally {
      globalThis.setInterval = setInterval
      globalThis.clearInterval = clearInterval
    }
  })
})
