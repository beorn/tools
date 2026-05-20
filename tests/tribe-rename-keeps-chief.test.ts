/**
 * Rename carries the chief claim.
 *
 * Regression test for the 2026-05-20 chief-identity flap: a session that holds
 * the explicit chief claim renames itself via `tribe.rename`. A rename is the
 * SAME session — same pid, same socket, same ctx.sessionId — so it must NOT
 * look like the chief left. Before the fix, a rename that the chief observed
 * dropped the claim back to connection-order derivation and a random session
 * became chief.
 *
 * The handler-level contract: after a chief-held rename, `tribe.chief` still
 * reports the renaming session as chief, with `source: "explicit-claim"` and
 * the NEW name (not the old one, not a derived fallback).
 */

import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, afterEach, describe, expect, it } from "vitest"

import { createTribeContext, type TribeContext } from "../tools/lib/tribe/context.ts"
import { createStatements, openDatabase } from "../tools/lib/tribe/database.ts"
import { handleToolCall, TRIBE_COORD_METHODS, type ActiveSessionInfo, type HandlerOpts } from "../tools/lib/tribe/handlers.ts"
import { deriveChiefId, deriveChiefInfo, type ChiefCandidate } from "../tools/lib/tribe/chief.ts"

// ---------------------------------------------------------------------------
// Test harness — a minimal stand-in for the daemon's withClientRegistry.
// `chiefClaim` is keyed by ctx.sessionId, exactly like the real registry; the
// handler opts read/write it through the same accessors the daemon wires.
// ---------------------------------------------------------------------------

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tribe-rename-chief-"))
  const path = join(dir, "tribe.db")
  const db = openDatabase(path)
  const stmts = createStatements(db)
  return { db, stmts, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function ctxFor(
  db: ReturnType<typeof openDatabase>,
  stmts: ReturnType<typeof createStatements>,
  name: string,
): TribeContext {
  const sessionId = randomUUID()
  const now = Date.now()
  db.prepare(
    `INSERT INTO sessions (id, name, role, domains, pid, started_at, updated_at)
     VALUES ($id, $name, 'member', '[]', 0, $now, $now)`,
  ).run({ $id: sessionId, $name: name, $now: now })
  return createTribeContext({
    db,
    stmts,
    sessionId,
    sessionRole: "member",
    initialName: name,
    domains: [],
    claudeSessionId: null,
    claudeSessionName: null,
  })
}

function parseTool<T>(result: Awaited<ReturnType<typeof handleToolCall>>): T {
  return JSON.parse(result.content[0]!.text) as T
}

describe("tribe.rename carries the chief claim", () => {
  let db: ReturnType<typeof openDatabase>
  let stmts: ReturnType<typeof createStatements>
  let cleanup: () => void

  beforeEach(() => {
    ;({ db, stmts, cleanup } = fixture())
  })
  afterEach(() => cleanup())

  it("a chief-held rename keeps the claim — chief stays the renamed session", async () => {
    // Two connected sessions. `agentA` is the chief claimer; `agentB` is older
    // (smaller registeredAt) so it would win the connection-order derivation
    // the moment the claim is lost. This makes a dropped claim observable.
    const chiefCtx = ctxFor(db, stmts, "agent5")
    const otherCtx = ctxFor(db, stmts, "agent0")

    const candidates: ChiefCandidate[] = [
      { name: "agent0", role: "member", registeredAt: 1000, ctx: { sessionId: otherCtx.sessionId } },
      { name: "agent5", role: "member", registeredAt: 2000, ctx: { sessionId: chiefCtx.sessionId } },
    ]
    function syncCandidateName(sessionId: string, name: string): void {
      const c = candidates.find((x) => x.ctx.sessionId === sessionId)
      if (c) c.name = name
    }

    // chiefClaim is keyed by sessionId — identical to the real registry.
    let chiefClaim: string | null = null
    const opts: HandlerOpts = {
      cleanup: () => {},
      userRenamed: false,
      setUserRenamed: () => {},
      getChiefId: () => deriveChiefId(candidates, chiefClaim),
      getChiefInfo: () => deriveChiefInfo(candidates, chiefClaim),
      claimChief: (sessionId, name) => {
        chiefClaim = sessionId
        syncCandidateName(sessionId, name)
      },
      releaseChief: (sessionId) => {
        if (chiefClaim === sessionId) chiefClaim = null
      },
      getActiveSessionIds: () => new Set(candidates.map((c) => c.ctx.sessionId)),
      getActiveSessionInfo: () => [] as ActiveSessionInfo[],
    }

    // 1. agent5 claims chief explicitly.
    const claim = parseTool<{ chief: string; claimed: boolean }>(
      await handleToolCall(chiefCtx, TRIBE_COORD_METHODS.claimChief, {}, opts),
    )
    expect(claim).toEqual({ chief: "agent5", claimed: true })
    expect(chiefClaim).toBe(chiefCtx.sessionId)

    // Sanity: before the rename, agent5 is chief by explicit claim.
    const before = parseTool<{ holder_name: string; claimed: boolean; source: string }>(
      await handleToolCall(chiefCtx, TRIBE_COORD_METHODS.chief, {}, opts),
    )
    expect(before).toMatchObject({ holder_name: "agent5", claimed: true, source: "explicit-claim" })

    // 2. agent5 renames itself to @chief.
    const renamed = parseTool<{ renamed: boolean; old_name: string; new_name: string }>(
      await handleToolCall(chiefCtx, TRIBE_COORD_METHODS.rename, { new_name: "@chief" }, opts),
    )
    expect(renamed).toEqual({ renamed: true, old_name: "agent5", new_name: "@chief" })

    // 3. The claim must have moved with the rename — same session, new name.
    expect(chiefClaim).toBe(chiefCtx.sessionId)

    // 4. tribe.chief: still the renamed session, still explicitly claimed,
    //    reported under the NEW name — not "agent5", not the derived agent0.
    const after = parseTool<{ holder_name: string; holder_id: string; claimed: boolean; source: string }>(
      await handleToolCall(chiefCtx, TRIBE_COORD_METHODS.chief, {}, opts),
    )
    expect(after.holder_name).toBe("@chief")
    expect(after.holder_id).toBe(chiefCtx.sessionId)
    expect(after.claimed).toBe(true)
    expect(after.source).toBe("explicit-claim")

    // Negative: the older session must NOT have become chief via derivation.
    expect(after.holder_id).not.toBe(otherCtx.sessionId)
  })

  it("a rename by a non-chief session leaves the chief claim untouched", async () => {
    const chiefCtx = ctxFor(db, stmts, "agent5")
    const memberCtx = ctxFor(db, stmts, "agent0")

    const candidates: ChiefCandidate[] = [
      { name: "agent5", role: "member", registeredAt: 1000, ctx: { sessionId: chiefCtx.sessionId } },
      { name: "agent0", role: "member", registeredAt: 2000, ctx: { sessionId: memberCtx.sessionId } },
    ]
    function syncCandidateName(sessionId: string, name: string): void {
      const c = candidates.find((x) => x.ctx.sessionId === sessionId)
      if (c) c.name = name
    }
    let chiefClaim: string | null = chiefCtx.sessionId // agent5 already chief
    const opts: HandlerOpts = {
      cleanup: () => {},
      userRenamed: false,
      setUserRenamed: () => {},
      getChiefId: () => deriveChiefId(candidates, chiefClaim),
      getChiefInfo: () => deriveChiefInfo(candidates, chiefClaim),
      claimChief: (sessionId, name) => {
        chiefClaim = sessionId
        syncCandidateName(sessionId, name)
      },
      releaseChief: (sessionId) => {
        if (chiefClaim === sessionId) chiefClaim = null
      },
      getActiveSessionIds: () => new Set(candidates.map((c) => c.ctx.sessionId)),
      getActiveSessionInfo: () => [] as ActiveSessionInfo[],
    }

    // A non-chief member renames itself — the claim stays on agent5.
    await handleToolCall(memberCtx, TRIBE_COORD_METHODS.rename, { new_name: "worker-1" }, opts)
    expect(chiefClaim).toBe(chiefCtx.sessionId)

    const after = parseTool<{ holder_name: string; claimed: boolean }>(
      await handleToolCall(chiefCtx, TRIBE_COORD_METHODS.chief, {}, opts),
    )
    expect(after).toMatchObject({ holder_name: "agent5", claimed: true })
  })
})
