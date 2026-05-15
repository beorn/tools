/**
 * Tribe topic trust registry.
 *
 * The message bus carries events from daemon internals, peer sessions, local
 * project observers, and external systems. Consumers use this registry to
 * decide how much of an event may enter model context before explicit fetch.
 */

export type TrustTier = "daemon" | "internal" | "external"

export const TRUST_TIERS = {
  "tribe.send": "internal",
  "daemon:*": "daemon",
  "health:*": "daemon",
  "bead:*": "internal",
  "git:commit": "external",
  "github:*": "external",
  "ci:*": "external",
} as const satisfies Record<string, TrustTier>

export type TopicGlob = keyof typeof TRUST_TIERS

export type SessionRosterEntry = string | { readonly name: string; readonly role?: string | null }
export type SessionRoster = Iterable<SessionRosterEntry>

type RosterMatch = {
  readonly name: string
  readonly role: string | null
}

export function trustTierForTopic(topic: string | null | undefined): TrustTier {
  return registeredTrustTierForTopic(topic) ?? "external"
}

export function registeredTrustTierForTopic(topic: string | null | undefined): TrustTier | null {
  if (!topic) return null
  const normalized = topic.toLowerCase()
  for (const [glob, tier] of Object.entries(TRUST_TIERS) as Array<[TopicGlob, TrustTier]>) {
    if (topicGlobMatch(glob, normalized)) return tier
  }
  return null
}

export function isRegisteredTrustTopic(topic: string | null | undefined): boolean {
  return registeredTrustTierForTopic(topic) !== null
}

export function trustTierFor(topic: string, sender: string, roster: SessionRoster): TrustTier {
  const registered = registeredTrustTierForTopic(topic)
  if (!registered) return "external"
  if (registered === "external") return "external"
  if (registered === "daemon") return isDaemonSender(sender, roster) ? "daemon" : "external"
  return isRosteredSender(sender, roster) ? "internal" : "external"
}

export function senderMayUseRegisteredTrustTopic(
  topic: string | null | undefined,
  sender: string,
  roster: SessionRoster,
): boolean {
  const registered = registeredTrustTierForTopic(topic)
  if (!registered) return true
  return trustTierFor(topic ?? "", sender, roster) === registered
}

function isRosteredSender(sender: string, roster: SessionRoster): boolean {
  const match = findRosterMatch(sender, roster)
  return !!match && match.role !== "pending"
}

function isDaemonSender(sender: string, roster: SessionRoster): boolean {
  if (sender === "daemon") return true
  const match = findRosterMatch(sender, roster)
  return match?.role === "daemon"
}

function findRosterMatch(sender: string, roster: SessionRoster): RosterMatch | null {
  for (const entry of roster) {
    if (typeof entry === "string") {
      if (entry === sender) return { name: entry, role: null }
      continue
    }
    if (entry.name === sender) return { name: entry.name, role: entry.role ?? null }
  }
  return null
}

function topicGlobMatch(glob: string, topic: string): boolean {
  if (glob === "*") return true
  if (!glob.includes("*")) return glob === topic
  const re = new RegExp("^" + glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$")
  return re.test(topic)
}
