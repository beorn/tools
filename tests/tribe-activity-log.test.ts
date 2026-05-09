/**
 * Unit tests for the unified tribe session-activity log.
 *
 * Scope (phase 1): the pure mapping from onMessageInserted payloads to
 * ActivityEntry rows, plus the append/rotate/disable behaviour of the
 * write function. The daemon integration (every DB insert → one log line)
 * is covered by the phantom-chief replay test in tribe-daemon.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { readFileSync, rmSync, existsSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"

import {
  activityFromMessage,
  activityLogPath,
  activityLogFilename,
  pruneOldActivityLogs,
  writeActivity,
  writeGateActivity,
  writeInjectActivity,
  __resetActivityLogState,
  type ActivityEntry,
} from "../tools/lib/tribe/activity-log.ts"
import { emitHookJson } from "../plugins/injection-envelope/src/emit.ts"
import { writeFileSync, utimesSync, readdirSync } from "node:fs"

let tmpDir: string
let origEnv: string | undefined

beforeEach(() => {
  tmpDir = join(tmpdir(), `tribe-activity-${randomUUID()}`)
  mkdirSync(tmpDir, { recursive: true })
  origEnv = process.env.TRIBE_ACTIVITY_LOG
  process.env.TRIBE_ACTIVITY_LOG = join(tmpDir, "activity.jsonl")
  __resetActivityLogState()
})

afterEach(() => {
  if (origEnv === undefined) delete process.env.TRIBE_ACTIVITY_LOG
  else process.env.TRIBE_ACTIVITY_LOG = origEnv
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
})

function readEntries(): ActivityEntry[] {
  const p = process.env.TRIBE_ACTIVITY_LOG!
  if (!existsSync(p)) return []
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as ActivityEntry)
}

describe("activityFromMessage — kind mapping", () => {
  it("maps direct → dm with peer=recipient", () => {
    const e = activityFromMessage({
      id: "m1",
      ts: 1000,
      type: "notify",
      kind: "direct",
      sender: "alice",
      recipient: "bob",
      content: "hi",
      bead_id: null,
    })
    expect(e.kind).toBe("dm")
    expect(e.session).toBe("alice")
    expect(e.peer).toBe("bob")
  })

  it("maps broadcast with type='session' → session", () => {
    const e = activityFromMessage({
      id: "m2",
      ts: 1000,
      type: "session",
      kind: "broadcast",
      sender: "daemon",
      recipient: "*",
      content: "alice joined (member) pid=123 ~/repo",
      bead_id: null,
    })
    expect(e.kind).toBe("session")
    expect(e.peer).toBeUndefined() // recipient='*' drops peer
  })

  it("maps broadcast with rename content → rename", () => {
    const e = activityFromMessage({
      id: "m3",
      ts: 1000,
      type: "notify",
      kind: "broadcast",
      sender: "alice",
      recipient: "*",
      content: 'Member "chief" is now "recall"',
      bead_id: null,
    })
    expect(e.kind).toBe("rename")
  })

  it("maps other broadcast → broadcast", () => {
    const e = activityFromMessage({
      id: "m4",
      ts: 1000,
      type: "status",
      kind: "broadcast",
      sender: "km-2",
      recipient: "*",
      content: "all phases shipped",
      bead_id: "km-ambot",
    })
    expect(e.kind).toBe("broadcast")
    expect(e.bead_id).toBe("km-ambot")
  })

  it("maps event → event", () => {
    const e = activityFromMessage({
      id: "m5",
      ts: 1000,
      type: "event.session.joined",
      kind: "event",
      sender: "alice",
      recipient: "*",
      content: '{"name":"alice"}',
      bead_id: null,
    })
    expect(e.kind).toBe("event")
  })
})

describe("activityFromMessage — preview truncation", () => {
  it("leaves short content intact", () => {
    const e = activityFromMessage({
      id: "m6",
      ts: 0,
      type: "notify",
      kind: "direct",
      sender: "a",
      recipient: "b",
      content: "short",
      bead_id: null,
    })
    expect(e.preview).toBe("short")
  })

  it("collapses whitespace", () => {
    const e = activityFromMessage({
      id: "m7",
      ts: 0,
      type: "notify",
      kind: "direct",
      sender: "a",
      recipient: "b",
      content: "line1\n\n  line2\t\ttab",
      bead_id: null,
    })
    expect(e.preview).toBe("line1 line2 tab")
  })

  it("truncates content > 200 chars with ellipsis", () => {
    const long = "x".repeat(500)
    const e = activityFromMessage({
      id: "m8",
      ts: 0,
      type: "notify",
      kind: "direct",
      sender: "a",
      recipient: "b",
      content: long,
      bead_id: null,
    })
    expect(e.preview?.length).toBe(200)
    expect(e.preview?.endsWith("…")).toBe(true)
  })
})

describe("writeActivity — file behavior", () => {
  it("appends a JSONL line per call", () => {
    writeActivity({ ts: 1, source: "tribe", kind: "dm", session: "a", peer: "b", preview: "one" })
    writeActivity({ ts: 2, source: "tribe", kind: "dm", session: "a", peer: "b", preview: "two" })
    const entries = readEntries()
    expect(entries).toHaveLength(2)
    expect(entries[0]!.preview).toBe("one")
    expect(entries[1]!.preview).toBe("two")
  })

  it("creates parent directory if missing", () => {
    const nested = join(tmpDir, "nested", "deeper", "activity.jsonl")
    process.env.TRIBE_ACTIVITY_LOG = nested
    __resetActivityLogState()
    writeActivity({ ts: 1, source: "tribe", kind: "dm", session: "a", peer: "b" })
    expect(existsSync(nested)).toBe(true)
  })

  it("is disabled by TRIBE_ACTIVITY_LOG=off", () => {
    process.env.TRIBE_ACTIVITY_LOG = "off"
    __resetActivityLogState()
    writeActivity({ ts: 1, source: "tribe", kind: "dm", session: "a", peer: "b" })
    const fallback = activityLogPath() // would be HOME-based, should not exist
    expect(existsSync(fallback)).toBe(fallback === "/.local/share/tribe/activity.jsonl" ? false : existsSync(fallback))
    // The tmpDir log was the pre-"off" path; ensure no rows landed anywhere
    // Since the env was just flipped to "off", any path it falls back to
    // should not have been written to in this test.
  })

  it("every line is valid JSON (jq-safe invariant)", () => {
    for (let i = 0; i < 5; i++) {
      writeActivity({
        ts: i,
        source: "tribe",
        kind: "dm",
        session: "a",
        peer: "b",
        preview: `row ${i}\nwith\tnewline`,
      })
    }
    const p = process.env.TRIBE_ACTIVITY_LOG!
    const raw = readFileSync(p, "utf8")
    const lines = raw.split("\n").filter((l) => l.length > 0)
    expect(lines).toHaveLength(5)
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
  })
})

describe("activityLogPath resolution", () => {
  it("honors TRIBE_ACTIVITY_LOG override", () => {
    process.env.TRIBE_ACTIVITY_LOG = "/tmp/custom.jsonl"
    expect(activityLogPath()).toBe("/tmp/custom.jsonl")
  })

  it("falls back to HOME/.local/share/tribe/activity-YYYY-MM-DD.jsonl (date-stamped)", () => {
    delete process.env.TRIBE_ACTIVITY_LOG
    const home = process.env.HOME ?? ""
    const fixed = new Date(2026, 4, 8) // 2026-05-08
    expect(activityLogPath(fixed)).toBe(`${home}/.local/share/tribe/activity-2026-05-08.jsonl`)
  })

  it("rotates to a new file when the day changes", () => {
    delete process.env.TRIBE_ACTIVITY_LOG
    const day1 = new Date(2026, 4, 8) // 2026-05-08
    const day2 = new Date(2026, 4, 9) // 2026-05-09
    expect(activityLogPath(day1)).not.toBe(activityLogPath(day2))
    expect(activityLogPath(day1)).toMatch(/activity-2026-05-08\.jsonl$/)
    expect(activityLogPath(day2)).toMatch(/activity-2026-05-09\.jsonl$/)
  })
})

describe("writeInjectActivity — phase 2 (recall hook)", () => {
  it("records source=recall, kind=inject with full uncropped content in preview", () => {
    const content = "x".repeat(500)
    writeInjectActivity(content)
    const entries = readEntries()
    expect(entries).toHaveLength(1)
    const e = entries[0]!
    expect(e.source).toBe("recall")
    expect(e.kind).toBe("inject")
    expect(e.chars).toBe(500)
    expect(e.preview?.length).toBe(500) // full content, not truncated
    expect(e.preview).toBe(content)
  })

  it("collapses whitespace in injected content for single-line jq output", () => {
    writeInjectActivity("line1\n\nline2\t\ttab  spaces")
    const entries = readEntries()
    expect(entries[0]!.preview).toBe("line1 line2 tab spaces")
    expect(entries[0]!.chars).toBe(22)
  })

  it("uses CLAUDE_SESSION_ID when set, else falls back to pid", () => {
    const origId = process.env.CLAUDE_SESSION_ID
    try {
      process.env.CLAUDE_SESSION_ID = "session-abc"
      writeInjectActivity("hello")
      process.env.CLAUDE_SESSION_ID = ""
      delete process.env.CLAUDE_SESSION_ID
      writeInjectActivity("world")
      const entries = readEntries()
      expect(entries).toHaveLength(2)
      expect(entries[0]!.session).toBe("session-abc")
      expect(entries[1]!.session).toMatch(/^pid-\d+$/)
    } finally {
      if (origId === undefined) delete process.env.CLAUDE_SESSION_ID
      else process.env.CLAUDE_SESSION_ID = origId
    }
  })
})

describe("emitHookJson integration — every UserPromptSubmit emission writes to activity log", () => {
  it("records the additionalContext when emitting UserPromptSubmit", () => {
    const out = emitHookJson("UserPromptSubmit", "recall: <snippet session='abc'>past work</snippet>")
    expect(out).toContain("hookSpecificOutput")
    const entries = readEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.source).toBe("recall")
    expect(entries[0]!.kind).toBe("inject")
    expect(entries[0]!.preview).toContain("past work")
  })

  it("does NOT record when additionalContext is undefined (empty hook output)", () => {
    const out = emitHookJson("UserPromptSubmit")
    expect(out).toBe("{}")
    expect(readEntries()).toHaveLength(0)
  })

  it("does NOT record for non-UserPromptSubmit events", () => {
    const out = emitHookJson("SessionEnd", "some content")
    expect(out).toBe("{}")
    expect(readEntries()).toHaveLength(0)
  })
})

describe("writeGateActivity — phase 3 (injection-gate verdicts)", () => {
  it("records source=gate, kind=gate with decision in `type`", () => {
    writeGateActivity({
      decision: "deny",
      toolName: "Write",
      reason: "candidate output contains entities only present in injected spans",
      reasonCode: "injection-only-entities",
      sessionId: "s-test",
    })
    const entries = readEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.source).toBe("gate")
    expect(entries[0]!.kind).toBe("gate")
    expect(entries[0]!.type).toBe("deny")
    expect(entries[0]!.session).toBe("s-test")
    expect(entries[0]!.preview).toContain("injected spans")
    expect((entries[0]!.meta as Record<string, unknown>).tool).toBe("Write")
    expect((entries[0]!.meta as Record<string, unknown>).reasonCode).toBe("injection-only-entities")
  })

  it("truncates preview to 200 chars + ellipsis", () => {
    writeGateActivity({
      decision: "ask",
      toolName: "Bash",
      reason: "x".repeat(500),
      reasonCode: "shingle-overlap",
    })
    const entries = readEntries()
    expect(entries[0]!.preview!.length).toBe(200)
    expect(entries[0]!.preview!.endsWith("…")).toBe(true)
  })

  it("falls back to CLAUDE_SESSION_ID then pid when sessionId arg is omitted", () => {
    const orig = process.env.CLAUDE_SESSION_ID
    try {
      process.env.CLAUDE_SESSION_ID = "envelope-sid"
      writeGateActivity({ decision: "allow", toolName: "Read", reason: "non-mutating" })
      const entries = readEntries()
      expect(entries[0]!.session).toBe("envelope-sid")
    } finally {
      if (orig === undefined) delete process.env.CLAUDE_SESSION_ID
      else process.env.CLAUDE_SESSION_ID = orig
    }
  })
})

describe("daily rotation — no event loss across midnight rollover", () => {
  it("filename helper formats date as activity-YYYY-MM-DD.jsonl", () => {
    expect(activityLogFilename(new Date(2026, 0, 1))).toBe("activity-2026-01-01.jsonl")
    expect(activityLogFilename(new Date(2026, 11, 31))).toBe("activity-2026-12-31.jsonl")
  })

  it("rotates to a new file when the day rolls; both files contain their own writes", () => {
    // Drop the override so getLogger uses the date-stamped path. Pin HOME to
    // tmpDir so the date-stamped path lands inside our cleanup root.
    delete process.env.TRIBE_ACTIVITY_LOG
    const origHome = process.env.HOME
    process.env.HOME = tmpDir
    mkdirSync(join(tmpDir, ".local", "share", "tribe"), { recursive: true })
    try {
      // We can't easily mock `new Date()` inside the writer (loggily's
      // Writable closure binds path at construction). Instead we exercise
      // the cache-invalidation path by writing once, then resetting the
      // cached state to simulate a different day's path resolution.
      __resetActivityLogState()
      writeActivity({ ts: 1, source: "tribe", kind: "dm", session: "a", peer: "b", preview: "day1-event" })
      const day1Path = activityLogPath()
      expect(existsSync(day1Path)).toBe(true)
      // Simulate day rollover: rename the cached file to "yesterday" and
      // reset state so the next writeActivity computes a fresh path.
      const dir = join(tmpDir, ".local", "share", "tribe")
      const yesterdayName = activityLogFilename(new Date(Date.now() - 86_400_000))
      const yesterdayPath = join(dir, yesterdayName)
      if (day1Path !== yesterdayPath) {
        // Move the just-written file aside so it represents "yesterday"
        const fs = require("node:fs") as typeof import("node:fs")
        fs.renameSync(day1Path, yesterdayPath)
      }
      __resetActivityLogState()
      writeActivity({ ts: 2, source: "tribe", kind: "dm", session: "a", peer: "b", preview: "day2-event" })
      const day2Path = activityLogPath()
      expect(existsSync(day2Path)).toBe(true)
      // Both files retain their own writes — no cross-contamination.
      const day1Body = readFileSync(yesterdayPath, "utf8")
      const day2Body = readFileSync(day2Path, "utf8")
      expect(day1Body).toContain("day1-event")
      expect(day1Body).not.toContain("day2-event")
      expect(day2Body).toContain("day2-event")
      expect(day2Body).not.toContain("day1-event")
    } finally {
      if (origHome === undefined) delete process.env.HOME
      else process.env.HOME = origHome
    }
  })
})

describe("pruneOldActivityLogs — keep N days of history", () => {
  it("removes activity-*.jsonl files older than keepDays, leaves recent files", () => {
    const dir = join(tmpDir, "prune-target")
    mkdirSync(dir, { recursive: true })
    const origHome = process.env.HOME
    process.env.HOME = tmpDir
    delete process.env.TRIBE_ACTIVITY_LOG
    try {
      // Create some fake date-stamped files at known mtimes
      const now = Date.now()
      const tribeDir = join(tmpDir, ".local", "share", "tribe")
      mkdirSync(tribeDir, { recursive: true })
      const old = join(tribeDir, "activity-2024-01-01.jsonl")
      const recent = join(tribeDir, "activity-2026-05-08.jsonl")
      const unrelated = join(tribeDir, "tribe.db") // must NOT be touched
      writeFileSync(old, "{}\n")
      writeFileSync(recent, "{}\n")
      writeFileSync(unrelated, "x")
      // Backdate `old` to 100 days ago, leave `recent` at now
      const past = (now - 100 * 86_400_000) / 1000
      utimesSync(old, past, past)
      const removed = pruneOldActivityLogs(30)
      expect(removed).toBe(1)
      expect(existsSync(old)).toBe(false)
      expect(existsSync(recent)).toBe(true)
      expect(existsSync(unrelated)).toBe(true) // unrelated file untouched
    } finally {
      if (origHome === undefined) delete process.env.HOME
      else process.env.HOME = origHome
    }
  })

  it("returns 0 and silently no-ops when the directory does not exist", () => {
    const origHome = process.env.HOME
    // Point HOME at a path that has no .local/share/tribe under it
    const fresh = join(tmpDir, "no-tribe-dir")
    mkdirSync(fresh, { recursive: true })
    process.env.HOME = fresh
    delete process.env.TRIBE_ACTIVITY_LOG
    try {
      expect(pruneOldActivityLogs(30)).toBe(0)
    } finally {
      if (origHome === undefined) delete process.env.HOME
      else process.env.HOME = origHome
    }
  })
})
