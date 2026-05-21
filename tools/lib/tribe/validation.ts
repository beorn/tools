/**
 * Tribe input validation — name format and message sanitization.
 */

// ---------------------------------------------------------------------------
// Surrogate-safe string helpers
// ---------------------------------------------------------------------------

/**
 * Matches a *lone* UTF-16 surrogate code unit — a high surrogate not followed
 * by a low surrogate, or a low surrogate not preceded by a high surrogate.
 *
 * Lone surrogates are legal in JavaScript strings but illegal in transmitted
 * JSON. When the Claude Code harness `JSON.stringify`s a conversation that
 * contains one, the Anthropic API rejects the request body with
 * `400 ... no low surrogate in string`. A single poisoned tribe channel
 * message therefore hard-blocks the receiving agent for the rest of its
 * session. This regex is the safety net: strip lone surrogates at the
 * tribe boundary so no truncation bug anywhere can poison an agent.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/**
 * Replace any lone UTF-16 surrogate with U+FFFD (REPLACEMENT CHARACTER).
 * Well-formed surrogate pairs (emoji, astral-plane characters) pass through
 * untouched.
 */
export function stripLoneSurrogates(text: string): string {
  return text.replace(LONE_SURROGATE, "�")
}

/**
 * Truncate `text` to at most `maxCodeUnits` UTF-16 code units **without ever
 * splitting a surrogate pair**. A naive `str.slice(0, n)` can cut between the
 * two halves of a surrogate pair (e.g. an emoji), leaving a lone high
 * surrogate at the end of the result — which then breaks JSON serialization
 * downstream. If the slice would land mid-pair, the trailing lone high
 * surrogate is dropped so the result stays well-formed.
 */
export function truncateSurrogateSafe(text: string, maxCodeUnits: number): string {
  if (text.length <= maxCodeUnits) return text
  let sliced = text.slice(0, maxCodeUnits)
  // If the last code unit is a high surrogate, the slice cut a pair in half.
  const lastUnit = sliced.charCodeAt(sliced.length - 1)
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) {
    sliced = sliced.slice(0, -1)
  }
  return sliced
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export function validateName(name: string): string | null {
  // Sigil-prefixed agent names (e.g. `@agent/2`) match slot-bead lease IDs.
  // The `@` is optional and only meaningful at position 0; the `/` is allowed
  // inside the body alongside dots/dashes/underscores.
  if (!/^@?[a-z0-9][a-z0-9_./-]{0,31}$/.test(name)) {
    return "Name must be 1-32 chars: lowercase letters, digits, hyphens, underscores, dots, slashes. Optional `@` prefix. Must start with letter or digit."
  }
  return null
}

export function sanitizeMessage(content: string): string {
  // Strip control chars except newlines
  let cleaned = content.replace(/[\x00-\x09\x0B-\x1F\x7F]/g, "")
  // Cap at 4096 chars — surrogate-safe so the cut never lands mid-pair.
  if (cleaned.length > 4096) {
    cleaned = truncateSurrogateSafe(cleaned, 4093) + "..."
  }
  // Defensive net: replace any lone surrogate (from this or any upstream
  // truncation, or malformed input) with U+FFFD so the message can never
  // poison a downstream JSON serialization.
  return stripLoneSurrogates(cleaned)
}
