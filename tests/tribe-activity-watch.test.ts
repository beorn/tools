/**
 * Tests for the `tribe activity` watcher — formatting, --since duration
 * parsing, multi-day file walking, no-follow replay path.
 *
 * Follow-mode polling is exercised lightly because `watchActivity({follow:
 * true})` runs forever; we verify the initial replay then capture one
 * appended line via a short pollMs and an out-sink.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"

import {
  formatActivityLine,
  parseSinceDuration,
  readEntriesSince,
  watchActivity,
} from "../tools/lib/tribe/activity-watch.ts"
import type { ActivityEntry } from "../tools/lib/tribe/activity-log.ts"

let tmpHome: string
let origHome: string | undefined
let origLog: string | undefined

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), `tribe-activity-watch-${randomUUID()}-`))
  origHome = process.env.HOME
  origLog = process.env.TRIBE_ACTIVITY_LOG
  process.env.HOME = tmpHome
  delete process.env.TRIBE_ACTIVITY_LOG
  mkdirSync(join(tmpHome, ".local", "share", "tribe"), { recursive: true })
})

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME
  else process.env.HOME = origHome
  if (origLog === undefined) delete process.env.TRIBE_ACTIVITY_LOG
  else process.env.TRIBE_ACTIVITY_LOG = origLog
  rmSync(tmpHome, { recursive: true, force: true })
})

function activityFileFor(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return join(tmpHome, ".local", "share", "tribe", `activity-${y}-${m}-${d}.jsonl`)
}

function writeEntry(date: Date, entry: ActivityEntry): void {
  const path = activityFileFor(date)
  appendFileSync(path, JSON.stringify(entry) + "\n", "utf8")
}

describe("parseSinceDuration", () => {
  it("parses h/m/s/d units to ms", () => {
    expect(parseSinceDuration("1h")).toBe(3_600_000)
    expect(parseSinceDuration("30m")).toBe(30 * 60_000)
    expect(parseSinceDuration("90s")).toBe(90_000)
    expect(parseSinceDuration("2d")).toBe(2 * 86_400_000)
  })

  it("ignores surrounding whitespace and capitalization", () => {
    expect(parseSinceDuration("  1H  ")).toBe(3_600_000)
    expect(parseSinceDuration("45M")).toBe(45 * 60_000)
  })

  it("returns null for invalid forms", () => {
    expect(parseSinceDuration("forever")).toBeNull()
    expect(parseSinceDuration("1y")).toBeNull()
    expect(parseSinceDuration("")).toBeNull()
  })
})

describe("formatActivityLine", () => {
  const baseEntry: ActivityEntry = {
    ts: new Date(2026, 4, 8, 12, 30, 45).getTime(),
    source: "tribe",
    kind: "dm",
    session: "alice",
    peer: "bob",
    preview: "hello",
  }

  it("renders timestamp, source tag, kind, session, peer, preview", () => {
    const line = formatActivityLine(baseEntry, false)
    expect(line).toContain("TRIBE")
    expect(line).toContain("dm")
    expect(line).toContain("alice")
    expect(line).toContain("→bob")
    expect(line).toContain("hello")
  })

  it("uses different ANSI colors for tribe vs recall vs gate", () => {
    const tribe = formatActivityLine({ ...baseEntry, source: "tribe" }, true)
    const recall = formatActivityLine({ ...baseEntry, source: "recall", kind: "inject" }, true)
    const gate = formatActivityLine({ ...baseEntry, source: "gate", kind: "gate", type: "deny" }, true)
    expect(tribe).toContain("\x1b[36m") // cyan
    expect(recall).toContain("\x1b[35m") // magenta
    expect(gate).toContain("\x1b[31m") // red for deny
  })

  it("falls back to white when color disabled", () => {
    const line = formatActivityLine(baseEntry, false)
    expect(line).not.toContain("\x1b[")
  })
})

describe("readEntriesSince — walks daily files in chronological order", () => {
  it("returns entries from multiple day-files filtered by ts >= sinceMs", () => {
    const now = new Date(2026, 4, 9, 12, 0, 0)
    const today = new Date(2026, 4, 9, 8, 0, 0)
    const yesterday = new Date(2026, 4, 8, 22, 0, 0)
    const dayBefore = new Date(2026, 4, 7, 10, 0, 0)
    writeEntry(dayBefore, {
      ts: dayBefore.getTime(),
      source: "tribe",
      kind: "dm",
      session: "old",
      preview: "old-event",
    })
    writeEntry(yesterday, {
      ts: yesterday.getTime(),
      source: "recall",
      kind: "inject",
      session: "yesterday",
      preview: "yesterday-event",
    })
    writeEntry(today, {
      ts: today.getTime(),
      source: "gate",
      kind: "gate",
      session: "today",
      type: "deny",
      preview: "today-event",
    })
    // since = 36h ago → captures yesterday + today, drops dayBefore
    const sinceMs = now.getTime() - 36 * 3_600_000
    const entries = readEntriesSince(sinceMs, now)
    expect(entries.map((e) => e.preview)).toEqual(["yesterday-event", "today-event"])
  })

  it("handles missing day-files gracefully (no entries → empty)", () => {
    // No files written
    const entries = readEntriesSince(Date.now() - 86_400_000)
    expect(entries).toEqual([])
  })

  it("drops malformed lines silently", () => {
    const today = new Date()
    const path = activityFileFor(today)
    writeFileSync(
      path,
      [
        JSON.stringify({ ts: today.getTime(), source: "tribe", kind: "dm", session: "ok", preview: "good" }),
        "not-json-{",
        JSON.stringify({ ts: today.getTime(), source: "tribe", kind: "dm", session: "ok2", preview: "good2" }),
      ].join("\n") + "\n",
    )
    const entries = readEntriesSince(today.getTime() - 1000)
    expect(entries.map((e) => e.preview)).toEqual(["good", "good2"])
  })
})

describe("phantom-chief replay — incident is discoverable from the log alone", () => {
  // Simulates the 2026-04-21 incident: vault-2's transcript showed an
  // "accepted" reply to a "chief offered prep checklist" DM that never
  // travelled through tribe. With the unified activity log, the absence
  // of a corresponding chief→vault-2 DM should be discoverable from the
  // JSONL file alone — no tribe.db introspection required.

  it("vault-2 acceptance is recorded but no corresponding chief→vault-2 offer exists in the log", async () => {
    const day = new Date()
    day.setHours(12, 30, 0, 0)
    // Ground truth: chief broadcast a 'joined' announcement (not a DM).
    writeEntry(day, {
      ts: day.getTime() - 60_000,
      source: "tribe",
      kind: "session",
      session: "chief",
      type: "session",
      preview: "chief joined",
    })
    // vault-2 accepts a phantom offer — this DM IS in the log because
    // vault-2 actually sent it through tribe.
    writeEntry(day, {
      ts: day.getTime(),
      source: "tribe",
      kind: "dm",
      session: "vault-2",
      peer: "chief",
      type: "notify",
      preview: "yes please, send the prep checklist",
      id: "msg-vault2-accept",
    })

    // Forensics from log alone: did chief send vault-2 anything before
    // vault-2's acceptance?
    const entries = readEntriesSince(day.getTime() - 3_600_000)
    const acceptance = entries.find((e) => e.id === "msg-vault2-accept")
    expect(acceptance).toBeDefined()
    expect(acceptance?.session).toBe("vault-2")
    expect(acceptance?.peer).toBe("chief")

    // Look for any chief→vault-2 DM whose ts is before the acceptance
    const priorChiefToVault2 = entries.filter(
      (e) =>
        e.source === "tribe" &&
        e.kind === "dm" &&
        e.session === "chief" &&
        e.peer === "vault-2" &&
        e.ts < acceptance!.ts,
    )
    // Phantom-chief signature: an acceptance with NO corresponding
    // sender-side DM. The log alone reveals the discrepancy.
    expect(priorChiefToVault2).toHaveLength(0)
  })

  it("legitimate exchange shows both sides (control case)", async () => {
    const day = new Date()
    day.setHours(13, 0, 0, 0)
    writeEntry(day, {
      ts: day.getTime() - 30_000,
      source: "tribe",
      kind: "dm",
      session: "chief",
      peer: "vault-2",
      type: "notify",
      preview: "want a prep checklist?",
      id: "msg-chief-offer",
    })
    writeEntry(day, {
      ts: day.getTime(),
      source: "tribe",
      kind: "dm",
      session: "vault-2",
      peer: "chief",
      type: "notify",
      preview: "yes please",
      id: "msg-vault2-accept",
    })
    const entries = readEntriesSince(day.getTime() - 3_600_000)
    const acceptance = entries.find((e) => e.id === "msg-vault2-accept")!
    const priorOffer = entries.filter(
      (e) =>
        e.source === "tribe" &&
        e.kind === "dm" &&
        e.session === "chief" &&
        e.peer === "vault-2" &&
        e.ts < acceptance.ts,
    )
    // Healthy exchange: the acceptance has a sender-side DM behind it.
    expect(priorOffer).toHaveLength(1)
    expect(priorOffer[0]?.id).toBe("msg-chief-offer")
  })
})

describe("watchActivity — no-follow replay", () => {
  it("emits all entries since today midnight then returns", async () => {
    const today = new Date()
    today.setHours(10, 0, 0, 0)
    writeEntry(today, {
      ts: today.getTime(),
      source: "tribe",
      kind: "dm",
      session: "a",
      peer: "b",
      preview: "first",
    })
    writeEntry(today, {
      ts: today.getTime() + 1000,
      source: "recall",
      kind: "inject",
      session: "a",
      preview: "second",
    })
    const lines: string[] = []
    await watchActivity({ follow: false, noColor: true, out: (l) => lines.push(l) })
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain("first")
    expect(lines[1]).toContain("second")
  })

  it("--since 1h drops events older than the cutoff", async () => {
    const today = new Date()
    const recent = new Date(today.getTime() - 30 * 60_000)
    const old = new Date(today.getTime() - 2 * 3_600_000)
    writeEntry(today, {
      ts: old.getTime(),
      source: "tribe",
      kind: "dm",
      session: "a",
      preview: "stale",
    })
    writeEntry(today, {
      ts: recent.getTime(),
      source: "tribe",
      kind: "dm",
      session: "a",
      preview: "fresh",
    })
    const lines: string[] = []
    await watchActivity({ follow: false, since: "1h", noColor: true, out: (l) => lines.push(l) })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("fresh")
  })

  it("rejects an invalid --since duration", async () => {
    await expect(watchActivity({ follow: false, since: "forever" })).rejects.toThrow(/invalid --since/)
  })
})
