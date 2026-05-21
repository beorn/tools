/**
 * Tribe topic trust registry.
 *
 * The daemon owns the topic -> trust-tier decision so every consumer treats
 * cross-session context the same way. These tests pin the registry, spoofing
 * guard, per-id fetch ACL, and source coverage for daemon-emitted topics.
 */

import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

import { createTribeContext } from "../tools/lib/tribe/context.ts"
import { createStatements, openDatabase } from "../tools/lib/tribe/database.ts"
import { handleToolCall, type ActiveSessionInfo, type HandlerOpts } from "../tools/lib/tribe/handlers.ts"
import { sendMessage } from "../tools/lib/tribe/messaging.ts"
import {
  TRUST_TIERS,
  isRegisteredTrustTopic,
  trustTierFor,
  trustTierForTopic,
  type SessionRoster,
} from "../tools/lib/tribe/trust.ts"

const TRUSTED_ROSTER: SessionRoster = [
  { name: "daemon", role: "daemon" },
  { name: "alice", role: "member" },
  { name: "bob", role: "member" },
]

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tribe-trust-"))
  const path = join(dir, "tribe.db")
  const db = openDatabase(path)
  const stmts = createStatements(db)
  return { db, stmts, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function makeOpts(): HandlerOpts {
  return {
    cleanup: () => {},
    userRenamed: false,
    setUserRenamed: () => {},
    getActiveSessionIds: () => new Set<string>(),
    getActiveSessionInfo: () => [] as ActiveSessionInfo[],
  }
}

function ctxFor(
  db: ReturnType<typeof openDatabase>,
  stmts: ReturnType<typeof createStatements>,
  name: string,
  role: "member" | "watch" | "daemon" = "member",
) {
  const sessionId = randomUUID()
  const now = Date.now()
  db.prepare(
    `INSERT INTO sessions (id, name, role, domains, pid, started_at, updated_at)
     VALUES ($id, $name, $role, '[]', 0, $now, $now)`,
  ).run({ $id: sessionId, $name: name, $role: role, $now: now })
  return createTribeContext({
    db,
    stmts,
    sessionId,
    sessionRole: role,
    initialName: name,
    domains: [],
    claudeSessionId: null,
    claudeSessionName: null,
  })
}

function parseTool<T>(result: Awaited<ReturnType<typeof handleToolCall>>): T {
  return JSON.parse(result.content[0]!.text) as T
}

describe("tribe trust-tier registry", () => {
  it("classifies registered topics and fails closed for unknown topics", () => {
    expect(TRUST_TIERS).toMatchObject({
      "tribe.send": "internal",
      "daemon:*": "daemon",
      "git:commit": "external",
      "github:*": "external",
      "ci:*": "external",
      "health:*": "daemon",
    })
    expect(trustTierForTopic("tribe.send")).toBe("internal")
    expect(trustTierForTopic("daemon:joined")).toBe("daemon")
    expect(trustTierForTopic("health:account:status")).toBe("daemon")
    expect(trustTierForTopic("git:commit")).toBe("external")
    expect(trustTierForTopic("github:workflow:failure")).toBe("external")
    expect(trustTierForTopic("ci:build:failed")).toBe("external")
    expect(trustTierForTopic("unregistered:new-topic")).toBe("external")
  })

  it("combines registry lookup with roster membership for spoofing defense", () => {
    expect(trustTierFor("tribe.send", "alice", TRUSTED_ROSTER)).toBe("internal")
    expect(trustTierFor("tribe.send", "mallory", TRUSTED_ROSTER)).toBe("external")
    expect(trustTierFor("daemon:joined", "daemon", TRUSTED_ROSTER)).toBe("daemon")
    expect(trustTierFor("daemon:joined", "mallory", TRUSTED_ROSTER)).toBe("external")
    expect(trustTierFor("github:push", "mallory", TRUSTED_ROSTER)).toBe("external")
  })

  it("silently omits ids a caller cannot see under the roster-aware ACL", async () => {
    const f = fixture()
    const alice = ctxFor(f.db, f.stmts, "alice")
    const bob = ctxFor(f.db, f.stmts, "bob")
    const mallory = ctxFor(f.db, f.stmts, "mallory")

    const directId = sendMessage(alice, "bob", "private", "notify", undefined, undefined, "direct", {
      topic: "tribe.send",
    }).id
    const spoofedId = sendMessage(mallory, "*", "spoofed", "notify", undefined, undefined, "broadcast", {
      topic: "tribe.send",
    }).id

    f.db.prepare("DELETE FROM sessions WHERE name = 'mallory'").run()

    const byId = parseTool<{ events: Array<{ id: string; content: string }> }>(
      await handleToolCall(bob, "tribe.fetch", { ids: [directId, spoofedId] }, makeOpts()),
    )
    expect(byId.events).toHaveLength(1)
    expect(byId.events[0]).toMatchObject({ id: directId, content: "private" })
    f.cleanup()
  })

  it("advances drain cursors past spoofed internal-topic rows so they do not poison the inbox", async () => {
    const f = fixture()
    const bob = ctxFor(f.db, f.stmts, "bob")
    const mallory = ctxFor(f.db, f.stmts, "mallory")
    const spoofed = sendMessage(mallory, "*", "spoofed", "notify", undefined, undefined, "broadcast", {
      topic: "tribe.send",
    })

    f.db.prepare("DELETE FROM sessions WHERE name = 'mallory'").run()

    const first = parseTool<{ events: unknown[]; cursor: number }>(
      await handleToolCall(bob, "tribe.fetch", { limit: 50 }, makeOpts()),
    )
    expect(first.events).toEqual([])
    expect(first.cursor).toBe(spoofed.rowid)

    const second = parseTool<{ events: unknown[]; cursor: number }>(
      await handleToolCall(bob, "tribe.fetch", { limit: 50 }, makeOpts()),
    )
    expect(second.events).toEqual([])
    expect(second.cursor).toBe(spoofed.rowid)
    f.cleanup()
  })
})

describe("trust-tier source coverage", () => {
  it("has an explicit registry entry for every daemon-emitted topic shape", () => {
    const emitted = discoverDaemonTopicShapes()
    expect(emitted).toContain("github:ci-alert")
    expect(emitted).toContain("health:account:status")
    expect(emitted).toContain("bead:claimed")
    const missing = emitted.filter((topic) => !isRegisteredTrustTopic(topic))
    expect(missing).toEqual([])
  })
})

function discoverDaemonTopicShapes(): string[] {
  const root = resolve(import.meta.dirname, "../tools/lib/tribe")
  const paths = [
    "accountly-plugin.ts",
    "beads-plugin.ts",
    "git-plugin.ts",
    "github-plugin.ts",
    "health-monitor-plugin.ts",
    "compose/with-broadcast.ts",
    "compose/with-dispatcher.ts",
  ]
  const topics = new Set<string>()
  for (const rel of paths) {
    const source = readFileSync(resolve(root, rel), "utf8")
    for (const match of source.matchAll(/topic:\s*"([^"]+)"/g)) topics.add(match[1]!)
    for (const match of source.matchAll(/topic:\s*`([^`]+)`/g)) {
      topics.add(match[1]!.replace(/\$\{[^}]+\}/g, "*"))
    }
  }
  return Array.from(topics).sort()
}
