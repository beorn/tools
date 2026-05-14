/**
 * resolve-name — session name resolution for `tribe.join` / `register`.
 *
 * Resolves the friendly session name to display in tribe.members from the
 * registration params. Two-layer logic:
 *
 *   1. **Explicit-name passthrough** — user-chosen names (`TRIBE_NAME=foo`,
 *      `@agent/3`, `chief`, anything that doesn't match a flavor-default
 *      pattern) are returned verbatim. The user opted in; honour it.
 *
 *   2. **Flavor auto-numbering** — when the supplied name is a known flavor
 *      default (e.g. `codex-12345-67890` from `~/.codex/config.toml`'s
 *      `${PPID:-0}-$$` fallback, or absent entirely for claude-code), strip
 *      to the flavor (`codex`, `claude`, `kimi`, `gemini`, `pi`) and assign
 *      the lowest free integer for that flavor across currently-connected
 *      sessions. First codex spawn → `codex1`, second → `codex2`.
 *
 * **Why** — `codex-56775-56857` is unique but useless: chief looking at
 * `tribe.members` can't tell what agent is running or whether it's the first
 * or seventeenth spawn. `codex1` / `codex2` is both unique within the daemon
 * AND immediately readable. See `@km/bearly/tribe-default-session-names`.
 *
 * **Reserved patterns that bypass auto-numbering**:
 *   - `@agent/<N>` — slot identity (worker hat)
 *   - `chief` — explicit chief role
 *   - User-set `TRIBE_NAME=anything-not-matching-a-flavor-default` — wins
 *
 * **Not in scope**:
 *   - Renaming live sessions retroactively (today's join = today's number).
 *   - Persistent identity across daemon restarts (cold daemon = fresh 1).
 */

import type { TribeRole } from "./config.ts"

export type PriorSession = { id: string; name: string; role: string }

// ---------------------------------------------------------------------------
// Flavor detection — these patterns appear in MCP-client config fallbacks
// (`~/.codex/config.toml`, etc.) and represent "the user didn't pick a name,
// the launcher fabricated one for uniqueness." We strip them back to the
// flavor and number freshly.
//
// The shape we recognize: `<flavor>-<digits>-<digits>` (codex's PPID-PID
// shell-substitution form) and bare `<flavor>` (claude-code's null default).
// Anything else — including `codex-bjorn` or `codex-feature-x` — is treated
// as user-chosen and passes through verbatim.
// ---------------------------------------------------------------------------

const KNOWN_FLAVORS = ["codex", "claude", "kimi", "gemini", "pi", "agent"] as const
export type Flavor = (typeof KNOWN_FLAVORS)[number]

/**
 * If `name` matches a flavor-default pattern, return the flavor. Otherwise
 * return null (caller treats the name as explicit and passes through).
 *
 * Recognized patterns (case-insensitive):
 *   - `codex-<digits>-<digits>` → "codex" (PPID-PID fallback)
 *   - `gemini-<digits>-<digits>` → "gemini"
 *   - `kimi-<digits>-<digits>` → "kimi"
 *   - `pi-<digits>-<digits>` → "pi"
 *   - `claude-<digits>-<digits>` → "claude"
 *   - bare `codex` / `claude` / `kimi` / `gemini` / `pi` (no number suffix)
 *
 * NOT recognized (return null, pass through):
 *   - `codex1`, `claude2` — already auto-numbered
 *   - `codex-bjorn`, `claude-review` — user-suffixed
 *   - `@agent/3` — slot
 *   - `chief` — role
 *   - `foo`, `km`, anything else — explicit
 */
export function detectFlavorDefault(name: string | null | undefined): Flavor | null {
  if (!name) return null
  const lower = name.toLowerCase()
  for (const flavor of KNOWN_FLAVORS) {
    // PPID-PID shell-substitution fallback: `<flavor>-<digits>-<digits>`
    if (new RegExp(`^${flavor}-\\d+-\\d+$`).test(lower)) return flavor
    // Bare flavor (rare, but covers `TRIBE_NAME=codex` etc.)
    if (lower === flavor) return flavor
  }
  return null
}

/**
 * Lowest free positive integer for `flavor` given the set of currently-taken
 * names. Scans `<flavor>1`, `<flavor>2`, ... until it finds an unused slot.
 * Bounded by `taken.size + 1` (worst case: every existing name is a flavor
 * collision, we pick the next one).
 */
export function nextFlavorNumber(flavor: Flavor, taken: ReadonlySet<string>): number {
  for (let n = 1; n <= taken.size + 1; n++) {
    if (!taken.has(`${flavor}${n}`)) return n
  }
  // Unreachable: the loop's upper bound guarantees a free slot.
  return taken.size + 1
}

/**
 * Build the auto-numbered name for a flavor default, given currently-taken
 * names. Returns `<flavor><N>` (e.g. `codex1`, `claude3`).
 */
export function assignFlavorName(flavor: Flavor, taken: ReadonlySet<string>): string {
  return `${flavor}${nextFlavorNumber(flavor, taken)}`
}

// ---------------------------------------------------------------------------
// Adoption helpers (project-and-role + identity-token reuse)
// ---------------------------------------------------------------------------

/**
 * True if a session name looks auto-generated (daemon fallback) and should NOT
 * be adopted by later sessions. Covers: member-<digits>, km-<digits>,
 * member-<short>, chief, tombstoned dead rows, flavor-numbered names, and
 * generic project fallbacks.
 *
 * Flavor-numbered names (`codex1`, `claude2`, ...) are auto-generated by
 * design — they represent "first/second codex in this daemon" and shouldn't
 * be adopted by a later session that happens to land at the same project.
 */
export function isAutoGeneratedName(name: string): boolean {
  if (!name) return true
  if (name === "chief") return true
  if (name.includes("-dead-")) return true
  if (/^member-[\w\d]{3,}$/.test(name)) return true
  if (/^km-?\d+$/.test(name)) return true
  if (/^km-[a-z0-9]{3,4}$/.test(name)) return true
  if (/^agent-[a-f0-9]+$/.test(name)) return true
  if (/^user-[\w\d]+$/.test(name)) return true
  // Flavor-numbered auto-assigned names (codex1, claude2, kimi3, ...)
  for (const flavor of KNOWN_FLAVORS) {
    if (new RegExp(`^${flavor}\\d+$`).test(name)) return true
  }
  return false
}

/**
 * F1-D — find a prior, non-active session at the same project_id + role
 * whose name is user-chosen (not auto-generated).
 */
export function adoptByProjectAndRole(
  db: import("bun:sqlite").Database,
  projectId: string | null,
  role: TribeRole,
  isActive: (sessionId: string) => boolean,
): PriorSession | null {
  if (!projectId) return null
  const candidates = db
    .prepare("SELECT id, name, role FROM sessions WHERE project_id = ? AND role = ? ORDER BY updated_at DESC LIMIT 50")
    .all(projectId, role) as PriorSession[]
  for (const c of candidates) {
    if (isActive(c.id)) continue
    if (isAutoGeneratedName(c.name)) continue
    return { id: c.id, name: c.name, role: c.role }
  }
  return null
}

/**
 * If the proxy supplied an identity token matching a prior, currently-
 * disconnected row, return that row so the caller can adopt its sessionId +
 * name + role. Returns null when there's no match or the prior session is
 * still actively connected.
 */
export function adoptIdentity(
  db: import("bun:sqlite").Database,
  identityToken: string | null,
  isActive: (sessionId: string) => boolean,
): PriorSession | null {
  if (!identityToken) return null
  const prior = db
    .prepare("SELECT id, name, role FROM sessions WHERE identity_token = ? ORDER BY updated_at DESC LIMIT 1")
    .get(identityToken) as PriorSession | null
  if (!prior) return null
  if (isActive(prior.id)) return null
  return prior
}

// ---------------------------------------------------------------------------
// resolveName — the main entry point. Layered fallback:
//
//   1. p.name is a flavor default → assign <flavor><N>
//   2. p.name is explicit (non-flavor-default) → return verbatim
//   3. claudeSessionName is set → return it
//   4. adopted (identity-token) → return adopted.name
//   5. prior claude-session row (non-auto) → return its name
//   6. project-and-role adopted → return its name
//   7. chief role → "chief"
//   8. fallback: claude-flavor auto-number (claude1, claude2, ...) when no
//      other signal; or projectName if we're in a non-claude context.
//
// The "currently-taken names" set is passed in by the caller (read from the
// live clients map). This is intentional: only count *connected* sessions,
// not historical DB rows. A codex that disconnects frees up `codex1` for the
// next spawn — matches user expectation ("how many codex agents are online
// right now?").
// ---------------------------------------------------------------------------

export interface ResolveNameContext {
  db: import("bun:sqlite").Database
  p: Record<string, unknown>
  adopted: PriorSession | null
  claudeSessionName: string | null
  claudeSessionId: string | null
  role: TribeRole
  isActive: (sessionId: string) => boolean
  projectId: string | null
  /** Names currently held by connected clients. Used for flavor-number assignment. */
  takenNames: ReadonlySet<string>
  /** Client OS PID. Used as last-resort fallback name suffix. */
  clientPid?: number
}

/**
 * Resolve a session name at registration time.
 *
 * Adoption logic removed (2026-05-14) after a chief session registered as
 * `@agent/4` because the daemon adopted a stale `@agent/4` row matching
 * the chief's claude_session_id. Adoption-by-prior-state is non-deterministic
 * across daemon restarts and conflates session identity with role/hat names.
 *
 * Sessions decide their identity from inside via tribe.rename / tribe.join.
 * Hats (`@agent/N`) are claimed via the bead lease system; the /claim and
 * /up skills sync the tribe session name to the hat at claim time.
 */
export function resolveName(ctx: ResolveNameContext): string {
  const { p, claudeSessionName, role, takenNames, clientPid } = ctx

  // 1. p.name set — split into flavor-default (auto-number) vs explicit (verbatim)
  if (p.name) {
    const candidate = String(p.name)
    const flavor = detectFlavorDefault(candidate)
    if (flavor) return assignFlavorName(flavor, takenNames)
    return candidate
  }

  // 2. claudeSessionName — claude-code-supplied display name from the harness.
  if (claudeSessionName) return claudeSessionName

  // 3. Chief role keeps the special name (explicit identity assertion).
  if (role === "chief") return "chief"

  // 4. Default: agent-<N> auto-number. The daemon can't reliably tell which
  //    flavor (codex/claude/kimi) it's talking to from the register call —
  //    sessions rename to a meaningful name from inside via tribe.rename or
  //    tribe.join after they know their own identity.
  return assignFlavorName("agent", takenNames)
}
