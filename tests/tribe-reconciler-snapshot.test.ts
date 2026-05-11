/**
 * tribe.health() reconciler-snapshot integration — pure-function unit tests.
 *
 * Bead: @km/bearly/tribe-health-incorporates-reconciler. The daemon reads
 * a chief-reconciler JSON snapshot (path from TRIBE_RECONCILER_SNAPSHOT
 * env var) and surfaces findings inline in tribe.health(). Stale snapshots
 * (>20min) raise a `stale-snapshot` finding so consumers can tell the tick
 * is wedged.
 *
 * `readReconcilerSnapshot` is the seam — it parses + summarizes a snapshot
 * file. tribe.health() composes its result on top. Test the seam directly
 * (no daemon spawn needed for these cases).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readReconcilerSnapshot } from "../tools/lib/tribe/handlers.ts"

describe("readReconcilerSnapshot", () => {
  let tmpDir: string
  let snapshotPath: string
  const prevEnv = process.env.TRIBE_RECONCILER_SNAPSHOT

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tribe-recon-snap-"))
    snapshotPath = join(tmpDir, "latest.json")
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    if (prevEnv === undefined) delete process.env.TRIBE_RECONCILER_SNAPSHOT
    else process.env.TRIBE_RECONCILER_SNAPSHOT = prevEnv
  })

  it("returns null when env var is unset (opt-in)", () => {
    delete process.env.TRIBE_RECONCILER_SNAPSHOT
    expect(readReconcilerSnapshot()).toBeNull()
  })

  it("returns error shape when env path doesn't exist", () => {
    process.env.TRIBE_RECONCILER_SNAPSHOT = join(tmpDir, "missing.json")
    const out = readReconcilerSnapshot()
    expect(out?.error).toMatch(/not found/i)
    expect(out?.snapshotPath).toBeTruthy()
  })

  it("returns error shape on parse failure (corrupt JSON)", () => {
    writeFileSync(snapshotPath, "{not json")
    process.env.TRIBE_RECONCILER_SNAPSHOT = snapshotPath
    const out = readReconcilerSnapshot()
    expect(out?.error).toMatch(/parse failed/i)
  })

  it("groups findings by kind and surfaces actions", () => {
    const now = Date.now()
    writeFileSync(
      snapshotPath,
      JSON.stringify({
        ts: now,
        findings: [
          {
            kind: "stale-lease",
            severity: "action",
            bead: "@km/foo/bar",
            agent: "@agent/5",
            fix: "km bd update @km/foo/bar --assignee '' --status open",
          },
          { kind: "stale-lease", severity: "action", bead: "@km/baz/qux", agent: "@agent/4", fix: "km bd update ..." },
          { kind: "legacy-worktree", severity: "warn", worktree: ".claude/worktrees/agent-abc123" },
          { kind: "unleased-process", severity: "info", pid: 12345, agent: "@agent/7" },
        ],
      }),
    )
    process.env.TRIBE_RECONCILER_SNAPSHOT = snapshotPath
    const out = readReconcilerSnapshot()!
    expect(out.findings).toEqual({
      "stale-lease": 2,
      "legacy-worktree": 1,
      "unleased-process": 1,
    })
    expect(out.actions).toHaveLength(2)
    expect(out.actions![0]!.bead).toBe("@km/foo/bar")
    expect(out.actions![0]!.fix).toMatch(/km bd update/)
    expect(out.lastTickAt).toBe(now)
    expect(out.ageMs).toBeGreaterThanOrEqual(0)
  })

  it("emits stale-snapshot finding when snapshot is older than 20 minutes", () => {
    const ancient = Date.now() - 21 * 60 * 1000
    writeFileSync(
      snapshotPath,
      JSON.stringify({
        ts: ancient,
        findings: [{ kind: "stale-lease", severity: "action" }],
      }),
    )
    process.env.TRIBE_RECONCILER_SNAPSHOT = snapshotPath
    const out = readReconcilerSnapshot()!
    expect(out.findings!["stale-snapshot"]).toBe(1)
    expect(out.findings!["stale-lease"]).toBe(1)
    expect(out.ageMs).toBeGreaterThan(20 * 60 * 1000)
  })

  it("does NOT emit stale-snapshot for fresh tick", () => {
    writeFileSync(snapshotPath, JSON.stringify({ ts: Date.now(), findings: [] }))
    process.env.TRIBE_RECONCILER_SNAPSHOT = snapshotPath
    const out = readReconcilerSnapshot()!
    expect(out.findings!["stale-snapshot"]).toBeUndefined()
  })

  it("handles missing findings array (returns empty findings map)", () => {
    writeFileSync(snapshotPath, JSON.stringify({ ts: Date.now() }))
    process.env.TRIBE_RECONCILER_SNAPSHOT = snapshotPath
    const out = readReconcilerSnapshot()!
    expect(out.findings).toEqual({})
    expect(out.actions).toEqual([])
  })

  it("falls back to file mtime when ts is missing or non-numeric", () => {
    writeFileSync(snapshotPath, JSON.stringify({ findings: [] }))
    process.env.TRIBE_RECONCILER_SNAPSHOT = snapshotPath
    const out = readReconcilerSnapshot()!
    expect(out.lastTickAt).toBeGreaterThan(0)
    expect(out.ageMs).toBeGreaterThanOrEqual(0)
  })
})
