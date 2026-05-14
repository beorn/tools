/**
 * Tribe tool handlers — all MCP tool case implementations.
 */

import type { Database } from "bun:sqlite"
import { createLogger } from "loggily"
import type { TribeContext } from "./context.ts"
import type { TribeRole } from "./config.ts"

const log = createLogger("tribe:handlers")
import { existsSync, readFileSync, statSync } from "node:fs"
import { validateName, sanitizeMessage } from "./validation.ts"
import { sendMessage, logEvent } from "./messaging.ts"
import { isPidAlive as pidStillAlive } from "./session.ts"

// ---------------------------------------------------------------------------
// Reconciler snapshot — read-only view into chief-reconciler output, surfaced
// inside tribe.health() so consumers see stale leases / dead sessions /
// orphan worktrees in real-time without a separate `km tribe doctor` call.
// Path comes from `TRIBE_RECONCILER_SNAPSHOT` so the daemon stays
// km-agnostic (matches vendor/CLAUDE.md: no hardcoded km paths in vendor).
// ---------------------------------------------------------------------------

const RECONCILER_STALE_MS = 20 * 60 * 1000 // 20min

interface ReconcilerFinding {
  kind: string
  severity?: "info" | "warn" | "action"
  summary?: string
  bead?: string
  agent?: string
  worktree?: string
  pid?: number
  fix?: string
}

interface ReconcilerSnapshotShape {
  ts: number
  findings: ReconcilerFinding[]
}

interface ReconcilerSection {
  lastTickAt?: number
  ageMs?: number
  findings?: Record<string, number>
  actions?: ReconcilerFinding[]
  error?: string
  snapshotPath?: string
}

/** Read + summarize the chief-reconciler snapshot. Returns null when the
 *  feature is opt-out (env var unset). All errors degrade gracefully into
 *  an `error` field — never throws, because tribe.health() must keep
 *  working when the snapshot file is missing, corrupt, or stale. */
export function readReconcilerSnapshot(): ReconcilerSection | null {
  const path = process.env.TRIBE_RECONCILER_SNAPSHOT
  if (!path) return null
  if (!existsSync(path)) {
    return { error: "snapshot not found", snapshotPath: path }
  }
  try {
    const raw = readFileSync(path, "utf8")
    const report = JSON.parse(raw) as ReconcilerSnapshotShape
    const lastTickAt = typeof report.ts === "number" ? report.ts : statSync(path).mtimeMs
    // statSync's mtimeMs is fractional; clamp to nonneg so a snapshot
    // written in the same tick doesn't surface a slightly-negative ageMs.
    const ageMs = Math.max(0, Date.now() - lastTickAt)
    const findings: Record<string, number> = {}
    const actions: ReconcilerFinding[] = []
    for (const f of Array.isArray(report.findings) ? report.findings : []) {
      const kind = String(f.kind ?? "unknown")
      findings[kind] = (findings[kind] ?? 0) + 1
      if (f.severity === "action") {
        actions.push({
          kind,
          ...(f.bead ? { bead: f.bead } : {}),
          ...(f.agent ? { agent: f.agent } : {}),
          ...(f.worktree ? { worktree: f.worktree } : {}),
          ...(f.pid ? { pid: f.pid } : {}),
          ...(f.fix ? { fix: f.fix } : {}),
        })
      }
    }
    if (ageMs > RECONCILER_STALE_MS) {
      findings["stale-snapshot"] = (findings["stale-snapshot"] ?? 0) + 1
    }
    return { lastTickAt, ageMs, findings, actions }
  } catch (err) {
    return { error: `snapshot parse failed: ${err instanceof Error ? err.message : String(err)}`, snapshotPath: path }
  }
}

// ---------------------------------------------------------------------------
// Canonical tribe-coordination daemon RPC method names.
// ---------------------------------------------------------------------------

export const TRIBE_COORD_METHODS = {
  send: "tribe.send",
  fetch: "tribe.fetch",
  members: "tribe.members",
  rename: "tribe.rename",
  health: "tribe.health",
  join: "tribe.join",
  reload: "tribe.reload",
  retro: "tribe.retro",
  chief: "tribe.chief",
  claimChief: "tribe.claim-chief",
  releaseChief: "tribe.release-chief",
  debug: "tribe.debug",
  filter: "tribe.filter",
} as const

export type TribeCoordMethod = (typeof TRIBE_COORD_METHODS)[keyof typeof TRIBE_COORD_METHODS]

const REMOVED_TRIBE_METHODS = new Set(["tribe.broadcast", "tribe.history", "tribe.inbox", "tribe.ping", "tribe.read", "broadcast", "history", "inbox", "ping", "read"])
const REMOVED_TRIBE_METHOD_HINT = "use send/fetch/filter — see hub/bearly/design/tribe-message-bus.md"

export function isRemovedTribeMethod(name: string): boolean {
  return REMOVED_TRIBE_METHODS.has(name)
}

export function removedTribeMethodMessage(name: string): string {
  return `${name} removed; ${REMOVED_TRIBE_METHOD_HINT}`
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ToolResult = { content: Array<{ type: string; text: string }> }
type ToolArgs = Record<string, unknown>

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export type ActiveSessionInfo = {
  id: string
  name: string
  pid: number
  role: string
  claudeSessionId: string | null
  registeredAt: number
}

export type HandlerOpts = {
  cleanup: () => void
  userRenamed: boolean
  setUserRenamed: (v: boolean) => void
  /** Return the ctx.sessionId of the current chief (derived or explicitly claimed), or null. */
  getChiefId: () => string | null
  /** Return the current chief's id + name + whether the role was explicitly claimed. */
  getChiefInfo: () => { id: string; name: string; claimed: boolean } | null
  /** Explicitly claim chief for the given session. Idempotent. */
  claimChief: (sessionId: string, name: string) => void
  /** Release an explicit chief claim (if this session holds it). Idempotent. */
  releaseChief: (sessionId: string) => void
  /**
   * Return ctx.sessionId of every currently-connected eligible session — used
   * to compute `alive` on DB-sourced session rows without a heartbeat timer.
   * Excludes daemon / watch-* / pending-*.
   */
  getActiveSessionIds: () => Set<string>
  /** Realtime snapshot of connected sessions (daemon clients Map). */
  getActiveSessionInfo: () => ActiveSessionInfo[]
  /** Optional: dump daemon internals for `tribe.debug`. Daemon-only (tests using
   *  handlers directly can omit this — `tribe.debug` then returns a minimal
   *  snapshot synthesized from the other accessors). */
  getDebugState?: () => Record<string, unknown>
}

export function handleToolCall(
  ctx: TribeContext,
  name: string,
  a: ToolArgs,
  opts: HandlerOpts,
): ToolResult | Promise<ToolResult> {
  switch (name) {
    case TRIBE_COORD_METHODS.send:
      return handleSend(ctx, a, opts)
    case TRIBE_COORD_METHODS.fetch:
      return handleFetch(ctx, a)
    case TRIBE_COORD_METHODS.members:
      return handleSessions(ctx, a, opts)
    case TRIBE_COORD_METHODS.rename:
      return handleRename(ctx, a, opts)
    case TRIBE_COORD_METHODS.join:
      return handleJoin(ctx, a, opts)
    case TRIBE_COORD_METHODS.health:
      return handleHealth(ctx, opts)
    case TRIBE_COORD_METHODS.reload:
      return handleReload(ctx, a, opts.cleanup)
    case TRIBE_COORD_METHODS.retro:
      return handleRetro(ctx, a)
    case TRIBE_COORD_METHODS.chief:
      return handleChief(ctx, opts)
    case TRIBE_COORD_METHODS.claimChief:
      return handleClaimChief(ctx, opts)
    case TRIBE_COORD_METHODS.releaseChief:
      return handleReleaseChief(ctx, opts)
    case TRIBE_COORD_METHODS.debug:
      return handleDebug(ctx, a, opts)
    case TRIBE_COORD_METHODS.filter:
      return handleFilter(ctx, a)
    default:
      if (REMOVED_TRIBE_METHODS.has(name)) {
        throw new Error(removedTribeMethodMessage(name))
      }
      throw new Error(`Unknown tool: ${name}`)
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** Names of currently-active sessions, lexicographically sorted. Returned as
 *  `existing_names` on conflict errors so the caller can pick a non-colliding
 *  alternative without a separate `tribe.sessions` round-trip. */
function listActiveSessionNames(ctx: TribeContext, activeIds?: Set<string>): string[] {
  const rows = ctx.db.prepare("SELECT id, name FROM sessions").all() as Array<{ id: string; name: string }>
  const active = activeIds ?? new Set(rows.map((r) => r.id))
  return rows
    .filter((r) => active.has(r.id))
    .map((r) => r.name)
    .sort()
}

function handleSend(ctx: TribeContext, a: ToolArgs, opts: HandlerOpts): ToolResult {
  const msgType = (a.type as string) ?? "notify"
  // Only the current chief can assign or verdict
  if ((msgType === "assign" || msgType === "verdict") && opts.getChiefId() !== ctx.sessionId) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: "Only the current chief can send assign/verdict messages" }),
        },
      ],
    }
  }
  const sanitized = sanitizeMessage(a.message as string)
  // Dead-letter fallback for `to: "chief"` when no chief exists:
  // drain to '*' with a `[no-chief]` prefix so the message still reaches the
  // tribe rather than vanishing into an unread queue no one polls.
  const { recipient, content, routedFromChief } = routeChiefFallback(opts, a.to as string, sanitized)
  const result = sendMessage(
    ctx,
    recipient,
    content,
    msgType,
    a.bead as string | undefined,
    a.ref as string | undefined,
  )
  logEvent(ctx, `message.sent.${msgType}`, a.bead as string | undefined, {
    to: a.to,
    message_id: result.id,
    routedFromChief: routedFromChief || undefined,
  })
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ sent: true, id: result.id, routedFromChief: routedFromChief || undefined }),
      },
    ],
  }
}

function routeChiefFallback(
  opts: HandlerOpts,
  to: string,
  content: string,
): { recipient: string; content: string; routedFromChief: boolean } {
  if (to !== "chief") return { recipient: to, content, routedFromChief: false }
  if (opts.getChiefId() !== null) {
    return { recipient: to, content, routedFromChief: false }
  }
  // No chief — drain to the tribe so somebody sees it.
  return { recipient: "*", content: `[no-chief] ${content}`, routedFromChief: true }
}

function handleSessions(ctx: TribeContext, a: ToolArgs, opts: HandlerOpts): ToolResult {
  // Membership is sourced from the `room_members` table (Matrix-shape, see
  // km-tribe.matrix-shape). Today every project has exactly one default room
  // and registerSession() populates the join row, so this is functionally a
  // no-op vs the prior `clients` Map sweep — but it exercises the schema so
  // the table stops being inert. Liveness still comes from the daemon's
  // in-memory clients Map (no DB-level tri-state).
  const activeIds = opts.getActiveSessionIds()
  // INNER JOIN on room_members: a session that hasn't joined any room is not
  // visible. The startup invariant + per-register backfill (joinDefaultRoom)
  // guarantee every active session has a row, so this match is total in
  // practice. Sessions appear once per room they belong to — DISTINCT collapses
  // multi-room sessions to one row (future-proofs sub-room work without
  // changing today's output shape).
  const rows = ctx.db
    .prepare(`
      SELECT DISTINCT s.id, s.name, s.role, s.domains, s.pid, s.cwd,
        s.claude_session_id, s.claude_session_name, s.started_at, s.updated_at
      FROM sessions s
      INNER JOIN room_members rm ON rm.session_id = s.id
      ORDER BY s.started_at
    `)
    .all() as Array<{
    id: string
    name: string
    role: string
    domains: string
    pid: number
    cwd: string
    claude_session_id: string | null
    claude_session_name: string | null
    started_at: number
    updated_at: number
  }>

  // By default return only currently-connected sessions. `a.all` exposes the
  // full DB (useful for diagnostics and tribe retro).
  const visibleRows = a.all ? rows : rows.filter((r) => activeIds.has(r.id))

  // Build parent map: first session per claudeSessionId is the parent, rest are sub-agents
  const parentMap = new Map<string, string>()
  for (const r of visibleRows) {
    if (!r.claude_session_id) continue
    if (!parentMap.has(r.claude_session_id)) {
      parentMap.set(r.claude_session_id, r.name)
    }
  }

  const sessions = visibleRows.map((r) => {
    const parent = r.claude_session_id ? parentMap.get(r.claude_session_id) : undefined
    return {
      name: r.name,
      role: r.role,
      domains: JSON.parse(r.domains),
      pid: r.pid,
      cwd: r.cwd,
      claude_session_id: r.claude_session_id,
      claude_session_name: r.claude_session_name,
      alive: activeIds.has(r.id),
      uptime_min: Math.round((Date.now() - r.started_at) / 60_000),
      last_seen_sec: Math.round((Date.now() - r.updated_at) / 1000),
      parent: parent && parent !== r.name ? parent : undefined,
    }
  })
  return { content: [{ type: "text", text: JSON.stringify({ sessions }, null, 2) }] }
}

function handleRename(
  ctx: TribeContext,
  a: ToolArgs,
  opts: {
    userRenamed: boolean
    setUserRenamed: (v: boolean) => void
    /** Optional: when provided, allow reclaiming names held by non-active sessions. */
    getActiveSessionIds?: () => Set<string>
  },
): ToolResult {
  const newName = a.new_name as string
  // Rename-to-self: silent no-op. Without this short-circuit, the rest of the
  // handler still validates, broadcasts "Member X is now X", and emits a
  // session.renamed event — pure noise.
  if (newName === ctx.getName()) {
    return { content: [{ type: "text", text: JSON.stringify({ renamed: false, name: newName }) }] }
  }
  // Validate name format
  const nameError = validateName(newName)
  if (nameError) {
    return { content: [{ type: "text", text: JSON.stringify({ error: nameError }) }] }
  }
  // Check if name is taken. If the holder is a non-active (dead / disconnected)
  // session, reclaim the name — tombstone the old row so journaled messages
  // stay addressable (recipient column still points at the old id) but the
  // unique `name` column is freed. See km-bearly.tribe-session-resume F1-B.
  const existing = ctx.stmts.checkNameTaken.get({ $name: newName, $session_id: ctx.sessionId }) as
    | { id: string }
    | undefined
  if (existing) {
    const activeIds = opts.getActiveSessionIds?.()
    const isActive = activeIds ? activeIds.has(existing.id) : true
    if (isActive) {
      const existing_names = listActiveSessionNames(ctx, activeIds)
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: `Name "${newName}" is already taken`, existing_names }),
          },
        ],
      }
    }
    // Tombstone the dead holder's name so the current session can claim it.
    // Format: `<name>-dead-<8-char-id-prefix>` — deterministic, preserves the
    // old row (message journal stays valid), avoids collisions between
    // multiple sequential reclaims.
    const tombstoneName = `${newName}-dead-${existing.id.slice(0, 8)}`
    ctx.db
      .prepare("UPDATE sessions SET name = $tomb, updated_at = $now WHERE id = $id")
      .run({ $tomb: tombstoneName, $now: Date.now(), $id: existing.id })
    log.info?.(`reclaimed name "${newName}" from dead session ${existing.id} (tombstoned as "${tombstoneName}")`)
  }
  const oldName = ctx.getName()
  ctx.stmts.renameSession.run({ $new_name: newName, $session_id: ctx.sessionId, $now: Date.now() })
  ctx.setName(newName)
  opts.setUserRenamed(true) // Explicit rename — name is now sticky, won't be overridden
  // Broadcast the rename
  sendMessage(ctx, "*", `Member "${oldName}" is now "${newName}"`, "notify")
  logEvent(ctx, "session.renamed", undefined, { old_name: oldName, new_name: newName })
  return {
    content: [{ type: "text", text: JSON.stringify({ renamed: true, old_name: oldName, new_name: newName }) }],
  }
}

function handleJoin(ctx: TribeContext, a: ToolArgs, opts: HandlerOpts): ToolResult {
  let joinName = a.name as string
  let joinRole = (a.role as string) ?? ctx.sessionRole
  const joinDomains = (a.domains as string[]) ?? ctx.domains
  const identityToken = (a.identity_token as string) ?? (a.identityToken as string) ?? null

  // Identity-token adoption: if the caller supplies a token that matches a
  // non-active prior session, inherit its name/role when the caller didn't
  // pass them explicitly. Symmetric with the register path in tribe-daemon.
  if (identityToken) {
    const prior = ctx.db
      .prepare(
        "SELECT id, name, role FROM sessions WHERE identity_token = $tok AND id != $id ORDER BY updated_at DESC LIMIT 1",
      )
      .get({ $tok: identityToken, $id: ctx.sessionId }) as {
      id: string
      name: string
      role: string
    } | null
    if (prior) {
      const isActive = opts.getActiveSessionIds().has(prior.id)
      if (!isActive) {
        if (!a.name) joinName = prior.name
        if (!a.role) joinRole = prior.role
      }
    }
  }

  // Validate name format
  const joinNameError = validateName(joinName)
  if (joinNameError) {
    return { content: [{ type: "text", text: JSON.stringify({ error: joinNameError }) }] }
  }

  // Check if name is taken. Like handleRename, reclaim from non-active holders
  // by tombstoning the dead row (preserves message journal addressability).
  const taken = ctx.stmts.checkNameTaken.get({ $name: joinName, $session_id: ctx.sessionId }) as
    | { id: string }
    | undefined
  if (taken) {
    const isActive = opts.getActiveSessionIds().has(taken.id)
    if (isActive) {
      // Auto-suffix instead of rejecting — sessions should always be able to join.
      // The caller can rename later via tribe.rename if the suffixed name isn't ideal.
      for (let n = 2; n <= 100; n++) {
        const candidate = `${joinName}-${n}`
        const candidateTaken = ctx.stmts.checkNameTaken.get({ $name: candidate, $session_id: ctx.sessionId }) as
          | { id: string }
          | undefined
        if (!candidateTaken || !opts.getActiveSessionIds().has(candidateTaken.id)) {
          if (candidateTaken) {
            const tombName = `${candidate}-dead-${candidateTaken.id.slice(0, 8)}`
            ctx.db
              .prepare("UPDATE sessions SET name = $tomb, updated_at = $now WHERE id = $id")
              .run({ $tomb: tombName, $now: Date.now(), $id: candidateTaken.id })
          }
          log.info?.(`name "${joinName}" taken by active session; auto-assigned "${candidate}"`)
          joinName = candidate
          break
        }
      }
    } else {
      const tombstoneName = `${joinName}-dead-${taken.id.slice(0, 8)}`
      ctx.db
        .prepare("UPDATE sessions SET name = $tomb, updated_at = $now WHERE id = $id")
        .run({ $tomb: tombstoneName, $now: Date.now(), $id: taken.id })
      log.info?.(`reclaimed name "${joinName}" from dead session ${taken.id} (tombstoned as "${tombstoneName}")`)
    }
  }

  // Joining with role=chief is now an explicit claim — derived chief otherwise.
  if (joinRole === "chief") {
    opts.claimChief(ctx.sessionId, joinName)
  }

  const prevName = ctx.getName()
  // Note: renames are in-place; the old name is not preserved.

  ctx.stmts.updateSessionMeta.run({
    $id: ctx.sessionId,
    $name: joinName,
    $role: joinRole,
    $domains: JSON.stringify(joinDomains),
    $now: Date.now(),
  })
  ctx.setName(joinName)
  ctx.setRole(joinRole as TribeRole)

  // km-bearly.tribe-dm-delivery-gap: declare delivery mode. `push` (default)
  // means the daemon fans events out on the MCP channel; `pull` queues them
  // and the agent drains via tribe.fetch. MCP-only clients (codex, gemini,
  // etc.) without a notification reader should join with `pull`.
  const deliveryRaw = a.delivery
  if (deliveryRaw === "push" || deliveryRaw === "pull") {
    ctx.stmts.setSessionDelivery.run({
      $id: ctx.sessionId,
      $delivery: deliveryRaw,
      $now: Date.now(),
    })
  }
  const delivery =
    deliveryRaw === "push" || deliveryRaw === "pull"
      ? deliveryRaw
      : (ctx.db.prepare("SELECT delivery FROM sessions WHERE id = $id").get({ $id: ctx.sessionId }) as
          | { delivery: string }
          | undefined)?.delivery ?? "push"

  logEvent(ctx, "session.joined", undefined, {
    name: joinName,
    role: joinRole,
    domains: joinDomains,
    delivery,
    rejoin: true,
  })

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          joined: true,
          name: joinName,
          role: joinRole,
          domains: joinDomains,
          delivery,
          previous_name: joinName !== prevName ? prevName : undefined,
        }),
      },
    ],
  }
}

function handleHealth(ctx: TribeContext, opts: HandlerOpts): ToolResult {
  const silentThreshold = Date.now() - 300_000 // 5 minutes

  // Liveness comes from the daemon's in-memory clients Map. Dead sessions
  // are simply absent from activeSessionInfo — no DB pruning required.
  const activeInfo = opts.getActiveSessionInfo()
  const byId = new Map(activeInfo.map((s) => [s.id, s]))
  const rows = ctx.stmts.allSessions.all() as Array<{
    id: string
    name: string
    role: string
    domains: string
    pid: number
    started_at: number
    updated_at: number
  }>
  const liveSessions = rows.filter((r) => byId.has(r.id))

  const members = liveSessions.map((s) => {
    const alive = true // by definition — only connected sessions reported
    // Find last message from this member
    const lastMsg = ctx.db
      .prepare("SELECT ts FROM messages WHERE sender = $name ORDER BY ts DESC LIMIT 1")
      .get({ $name: s.name }) as { ts: number } | null

    const lastMsgAge = lastMsg ? Date.now() - lastMsg.ts : null
    const warnings: string[] = []
    if (alive && lastMsgAge && lastMsgAge > silentThreshold) {
      warnings.push(`no message in ${Math.round(lastMsgAge / 60_000)} min`)
    }
    if (!lastMsg) warnings.push("never sent a message")

    // Spawn-time identity binding (@km/tribe/spawn-time-identity-binding):
    // a session whose stored PID is dead is a structural zombie — the
    // daemon thinks it's connected but the owning OS process is gone.
    // Surface this so health checks + chief reconciliation can detect
    // and clean up before a second `claude --name @agent/N` collides.
    const pidAlive = !s.pid || s.pid <= 0 ? true : pidStillAlive(s.pid)
    if (s.pid > 0 && !pidAlive) {
      warnings.push(`pid ${s.pid} is dead — session is a zombie`)
    }

    return {
      name: s.name,
      role: s.role,
      domains: JSON.parse(s.domains),
      pid: s.pid,
      alive,
      pid_alive: pidAlive,
      last_message: lastMsgAge ? `${Math.round(lastMsgAge / 60_000)} min ago` : "never",
      warnings,
    }
  })

  // Unread direct-message count per recipient — undelivered means the
  // recipient's cursor (sessions.last_delivered_seq) hasn't reached the
  // message's rowid yet. Broadcasts ('*') and event journal rows are
  // excluded. If no session row exists for a recipient name (pre-register
  // or retention has pruned it), all their directs count as unread.
  const unread = ctx.db
    .prepare(`
			SELECT m.recipient, COUNT(*) as count FROM messages m
			WHERE m.recipient != '*'
			AND m.kind = 'direct'
			AND m.rowid > COALESCE(
				(SELECT s.last_delivered_seq FROM sessions s WHERE s.name = m.recipient),
				0
			)
			GROUP BY m.recipient
		`)
    .all() as Array<{ recipient: string; count: number }>

  const stats = {
    messages: (ctx.db.prepare("SELECT COUNT(*) as n FROM messages").get() as any)?.n ?? 0,
    events: (ctx.db.prepare("SELECT COUNT(*) as n FROM messages WHERE kind = 'event'").get() as any)?.n ?? 0,
  }

  const result: Record<string, unknown> = { members, unread, stats, checked_at: new Date().toISOString() }
  // L4 of @km/tribe/stable-coordination: surface the chief-reconciler's
  // four-source reconciliation (live processes / bead claims / worktrees /
  // tribe sessions) inline so any session asking tribe.health() sees
  // orphans in real-time. Opt-in via TRIBE_RECONCILER_SNAPSHOT env var so
  // the bearly daemon stays km-agnostic for standalone deployments.
  const reconciler = readReconcilerSnapshot()
  if (reconciler) result.reconciler = reconciler
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
  }
}

function handleReload(ctx: TribeContext, a: ToolArgs, cleanup: () => void): ToolResult {
  const reason = (a.reason as string) ?? "manual reload"
  logEvent(ctx, "session.reload", undefined, { name: ctx.getName(), reason })
  log.info?.(`reloading: ${reason}`)

  // Schedule re-exec after responding to the tool call
  setTimeout(() => {
    cleanup()
    // Re-exec the same script with the same args — picks up latest code from disk
    const args = process.argv.slice(1) // drop the bun/node executable
    log.info?.(`exec: ${process.execPath} ${args.join(" ")}`)
    // Use Bun.spawn to replace the process
    const child = Bun.spawn([process.execPath, ...args], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: process.env,
    })
    // Forward exit
    child.exited.then((code) => process.exit(code ?? 0))
  }, 100) // small delay so the tool response gets sent first

  return {
    content: [{ type: "text", text: JSON.stringify({ reloading: true, reason, pid: process.pid }) }],
  }
}

async function handleRetro(ctx: TribeContext, a: ToolArgs): Promise<ToolResult> {
  const { generateRetro, formatMarkdown, parseDuration } = await import("./retro.ts")
  const sinceStr = a.since as string | undefined
  let sinceMs: number | undefined
  if (sinceStr) {
    try {
      sinceMs = parseDuration(sinceStr)
    } catch {
      return { content: [{ type: "text", text: JSON.stringify({ error: `Invalid duration: "${sinceStr}"` }) }] }
    }
  }
  const fmt = (a.format as string) ?? "markdown"
  const report = generateRetro(ctx.db, sinceMs)
  const text = fmt === "json" ? JSON.stringify(report, null, 2) : formatMarkdown(report)
  return { content: [{ type: "text", text }] }
}

function handleChief(_ctx: TribeContext, opts: HandlerOpts): ToolResult {
  const info = opts.getChiefInfo()
  if (!info) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ chief: null, message: "No chief — no eligible sessions connected" }),
        },
      ],
    }
  }
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            holder_name: info.name,
            holder_id: info.id,
            claimed: info.claimed,
            source: info.claimed ? "explicit-claim" : "derived-from-connection-order",
          },
          null,
          2,
        ),
      },
    ],
  }
}

function handleClaimChief(ctx: TribeContext, opts: HandlerOpts): ToolResult {
  opts.claimChief(ctx.sessionId, ctx.getName())
  return {
    content: [{ type: "text", text: JSON.stringify({ chief: ctx.getName(), claimed: true }) }],
  }
}

function handleReleaseChief(ctx: TribeContext, opts: HandlerOpts): ToolResult {
  opts.releaseChief(ctx.sessionId)
  const info = opts.getChiefInfo()
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ released: true, chief: info?.name ?? null }),
      },
    ],
  }
}

function handleDebug(_ctx: TribeContext, _a: ToolArgs, opts: HandlerOpts): ToolResult {
  // Prefer the daemon-provided dump when available (richest snapshot: clients
  // Map, chief claim, per-session cursors). Otherwise synthesize a minimal
  // view from the generic accessors so in-process tests still get meaningful
  // output without wiring getDebugState.
  const state = opts.getDebugState
    ? opts.getDebugState()
    : {
        clients: opts.getActiveSessionInfo(),
        chief: opts.getChiefInfo(),
        chiefClaim: null,
        cursors: [],
      }
  return { content: [{ type: "text", text: JSON.stringify(state) }] }
}

// ---------------------------------------------------------------------------
// km-tribe.event-classification handlers
// ---------------------------------------------------------------------------

type FetchRow = {
  id: string
  rowid: number
  type: string
  sender: string
  recipient: string
  content: string
  bead_id: string | null
  ref: string | null
  ts: number
  delivery: string
  topic: string | null
  room_id: string | null
}

function handleFetch(ctx: TribeContext, a: ToolArgs): ToolResult {
  const limit = typeof a.limit === "number" && a.limit > 0 && a.limit <= 500 ? a.limit : 50
  const topics = normalizeStringArray(a.topics)
  if (a.topics !== undefined && topics === null) {
    return { content: [{ type: "text", text: JSON.stringify({ error: "topics must be an array of strings." }) }] }
  }

  const cursor = ctx.stmts.getInboxCursor.get({ $id: ctx.sessionId }) as { last_inbox_pull_seq: number } | null
  const currentName = ctx.getName()
  let rows: FetchRow[]
  let shouldAdvance = false
  let cursorBase = cursor?.last_inbox_pull_seq ?? 0

  const ids = normalizeStringArray(a.ids)
  if (a.ids !== undefined && ids === null) {
    return { content: [{ type: "text", text: JSON.stringify({ error: "ids must be an array of strings." }) }] }
  }

  if (ids && ids.length > 0) {
    const placeholders = ids.map(() => "?").join(", ")
    rows = ctx.db
      .prepare(`
        SELECT id, rowid, type, sender, recipient, content, bead_id, ref, ts, delivery, topic, room_id
        FROM messages
        WHERE id IN (${placeholders})
          AND kind != 'event'
          AND (sender = ? OR recipient = ? OR recipient = '*')
        ORDER BY rowid ASC
        LIMIT ?
      `)
      .all(...ids, currentName, currentName, limit) as FetchRow[]
    const byId = new Map(rows.map((r) => [r.id, r]))
    rows = ids.map((id) => byId.get(id)).filter((r): r is FetchRow => !!r)
  } else if (typeof a.with === "string" && a.with.length > 0) {
    rows = ctx.db
      .prepare(`
        SELECT id, rowid, type, sender, recipient, content, bead_id, ref, ts, delivery, topic, room_id
        FROM messages
        WHERE kind != 'event'
          AND (
            (sender = $self AND recipient = $peer)
            OR (sender = $peer AND recipient = $self)
          )
        ORDER BY rowid ASC
        LIMIT $limit
      `)
      .all({ $self: currentName, $peer: a.with, $limit: limit }) as FetchRow[]
  } else if (typeof a.from === "string" && a.from.length > 0) {
    rows = ctx.db
      .prepare(`
        SELECT id, rowid, type, sender, recipient, content, bead_id, ref, ts, delivery, topic, room_id
        FROM messages
        WHERE kind != 'event'
          AND sender = $from
          AND (sender = $self OR recipient = $self OR recipient = '*')
        ORDER BY rowid ASC
        LIMIT $limit
      `)
      .all({ $from: a.from, $self: currentName, $limit: limit }) as FetchRow[]
  } else if (typeof a.to === "string" && a.to.length > 0) {
    rows = ctx.db
      .prepare(`
        SELECT id, rowid, type, sender, recipient, content, bead_id, ref, ts, delivery, topic, room_id
        FROM messages
        WHERE kind != 'event'
          AND recipient = $to
          AND (sender = $self OR recipient = $self OR recipient = '*')
        ORDER BY rowid ASC
        LIMIT $limit
      `)
      .all({ $to: a.to, $self: currentName, $limit: limit }) as FetchRow[]
  } else {
    const hasSince = typeof a.since === "number"
    const since = hasSince ? (a.since as number) : cursorBase
    cursorBase = since
    rows = ctx.stmts.getInboxRows.all({
      $since: since,
      $name: currentName,
      $limit: limit,
    }) as FetchRow[]
    shouldAdvance = hasSince ? a.advance === true : a.advance !== false
  }

  const filtered = topics && topics.length > 0 ? rows.filter((r) => matchesGlob(topics, r.topic)) : rows

  if (filtered.length > 0 && shouldAdvance) {
    const maxSeq = filtered[filtered.length - 1]!.rowid
    ctx.stmts.advanceInboxCursor.run({ $id: ctx.sessionId, $seq: maxSeq, $now: Date.now() })
  }

  const events = filtered.map((r) => ({
    id: r.id,
    rowid: r.rowid,
    type: r.type,
    from: r.sender,
    to: r.recipient,
    content: r.content,
    bead: r.bead_id,
    ref: r.ref,
    ts: new Date(r.ts).toISOString(),
    delivery: r.delivery,
    topic: r.topic,
    room_id: r.room_id,
  }))
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          { events, cursor: events.length > 0 ? events[events.length - 1]!.rowid : cursorBase },
          null,
          2,
        ),
      },
    ],
  }
}

function normalizeStringArray(value: unknown): string[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((s) => typeof s !== "string")) return null
  return value as string[]
}

function matchesGlob(globs: string[], value: string | null): boolean {
  if (!value) return false
  for (const g of globs) {
    if (g === "*") return true
    if (!g.includes("*") && g === value) return true
    if (g.includes("*")) {
      const re: RegExp = new RegExp("^" + g.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$")
      if (re.test(value)) return true
    }
  }
  return false
}

/**
 * Apply a session-level event filter — combines persistent mode + time-bounded
 * mute + per-topic glob list into a single tool call.
 *
 * Empty args clear the filter (mode → 'normal', mute + until → null).
 * `until` is an absolute unix-ms timestamp. `mute` without `until` is persistent.
 *
 * Direct messages always bypass mute/until — only `mode: 'focus'` filters DMs.
 */
function handleFilter(ctx: TribeContext, a: ToolArgs): ToolResult {
  const rawMode = a.mode
  if (rawMode !== undefined && rawMode !== "focus" && rawMode !== "normal" && rawMode !== "ambient") {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: `Invalid mode: "${String(rawMode)}". Use focus|normal|ambient.` }),
        },
      ],
    }
  }
  const mode = (rawMode as string | undefined) ?? "normal"

  const rawUntil = a.until
  if (rawUntil !== undefined && (typeof rawUntil !== "number" || rawUntil < 0)) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: "until must be a non-negative unix-ms timestamp." }) }],
    }
  }
  const until = (rawUntil as number | undefined) ?? null

  const rawMute = a.mute
  if (rawMute !== undefined && (!Array.isArray(rawMute) || rawMute.some((topic) => typeof topic !== "string"))) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: "mute must be an array of strings." }) }],
    }
  }
  const mute = Array.isArray(rawMute) && rawMute.length > 0 ? JSON.stringify(rawMute) : null

  ctx.stmts.setSessionFilter.run({
    $id: ctx.sessionId,
    $mode: mode,
    $until: until,
    $mute: mute,
    $now: Date.now(),
  })

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          set: true,
          mode,
          until: until !== null ? new Date(until).toISOString() : null,
          mute: Array.isArray(rawMute) ? rawMute : null,
        }),
      },
    ],
  }
}
