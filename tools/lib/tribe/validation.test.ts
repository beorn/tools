/**
 * Regression guard for the lone-surrogate poison bug.
 *
 * Incident: a tribe channel message carried a lone UTF-16 high surrogate into
 * an agent's conversation context. When the Claude Code harness
 * `JSON.stringify`d the request body, the Anthropic API rejected it with
 * `400 ... no low surrogate in string`, hard-blocking the agent for the rest
 * of its session (every subsequent call replays the poisoned history).
 *
 * Root cause: `sanitizeMessage` capped messages with `str.slice(0, 4093)` —
 * a UTF-16 *code-unit* slice. When index 4093 lands between the two halves of
 * a surrogate pair (an emoji / astral-plane char), the truncated string ends
 * with a lone high surrogate. Lone surrogates are legal in JS strings but
 * illegal in transmitted JSON.
 *
 * Two complementary fixes, both asserted here:
 *   1. `truncateSurrogateSafe` cuts on code-point boundaries — never mid-pair.
 *   2. `stripLoneSurrogates` replaces any lone surrogate with U+FFFD as a
 *      defensive net at the tribe boundary.
 */

import { describe, test, expect } from "vitest"
import { sanitizeMessage, stripLoneSurrogates, truncateSurrogateSafe } from "./validation.ts"

// A lone high surrogate appears anywhere in a string iff this matches.
const HAS_LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

describe("truncateSurrogateSafe", () => {
  test("never splits a surrogate pair when the cut lands mid-pair", () => {
    // 😀 (U+1F600) is a surrogate pair: 😀 — two UTF-16 code units.
    // Place it so a slice at the chosen length would cut between its halves.
    const text = "a".repeat(10) + "😀" + "b".repeat(10)
    // Index 11 is between the high (10) and low (11) surrogate of the emoji.
    const out = truncateSurrogateSafe(text, 11)
    expect(HAS_LONE_SURROGATE.test(out)).toBe(false)
    // The half-emoji is dropped entirely, leaving the clean prefix.
    expect(out).toBe("a".repeat(10))
  })

  test("keeps a whole surrogate pair when the cut lands after it", () => {
    const text = "a".repeat(10) + "😀" + "b".repeat(10)
    // Index 12 is after both halves of the emoji.
    const out = truncateSurrogateSafe(text, 12)
    expect(HAS_LONE_SURROGATE.test(out)).toBe(false)
    expect(out).toBe("a".repeat(10) + "😀")
  })

  test("returns input unchanged when shorter than the cap", () => {
    expect(truncateSurrogateSafe("hello 😀", 100)).toBe("hello 😀")
  })

  test("a naive slice WOULD have produced a lone surrogate (proves the bug)", () => {
    const text = "a".repeat(10) + "😀" + "b".repeat(10)
    const naive = text.slice(0, 11)
    expect(HAS_LONE_SURROGATE.test(naive)).toBe(true)
  })
})

describe("stripLoneSurrogates", () => {
  test("replaces a lone high surrogate with U+FFFD", () => {
    const poisoned = "before\uD83Dafter" // \uD83D with no following low surrogate
    const out = stripLoneSurrogates(poisoned)
    expect(HAS_LONE_SURROGATE.test(out)).toBe(false)
    expect(out).toBe("before�after")
  })

  test("replaces a lone low surrogate with U+FFFD", () => {
    const poisoned = "before\uDE00after" // \uDE00 with no preceding high surrogate
    const out = stripLoneSurrogates(poisoned)
    expect(HAS_LONE_SURROGATE.test(out)).toBe(false)
  })

  test("leaves well-formed surrogate pairs (emoji) untouched", () => {
    const clean = "emoji 😀 and 🎉 astral 𝕏 text"
    expect(stripLoneSurrogates(clean)).toBe(clean)
  })

  test("output is always valid JSON", () => {
    const poisoned = "x".repeat(50) + "\uD800" + "y".repeat(50)
    const out = stripLoneSurrogates(poisoned)
    // JSON.parse(JSON.stringify(...)) round-trips iff no lone surrogate.
    expect(() => JSON.parse(JSON.stringify(out))).not.toThrow()
    expect(JSON.parse(JSON.stringify(out))).toBe(out)
  })
})

describe("sanitizeMessage — lone-surrogate poison guard", () => {
  test("truncating a 4096+ char message at a surrogate boundary never poisons", () => {
    // Build a message where the 4093-char cap lands mid-emoji.
    // 4092 'a' + 😀 (units 4092,4093) + filler past 4096 to trigger truncation.
    const text = "a".repeat(4092) + "😀" + "b".repeat(200)
    expect(text.length).toBeGreaterThan(4096)
    const out = sanitizeMessage(text)
    expect(HAS_LONE_SURROGATE.test(out)).toBe(false)
    // Result is JSON-serializable — the actual failure mode in the incident.
    expect(() => JSON.parse(JSON.stringify(out))).not.toThrow()
  })

  test("sanitized message containing astral input round-trips through JSON", () => {
    const text = "agent says: 😀 deployed 🎉 — astral char 𝕏 ok"
    const out = sanitizeMessage(text)
    expect(out).toBe(text) // short, well-formed → passes through verbatim
    expect(JSON.parse(JSON.stringify(out))).toBe(out)
  })

  test("an already-poisoned message (lone surrogate from upstream) is sanitized", () => {
    const poisoned = "tribe notification ends here\uD83D"
    const out = sanitizeMessage(poisoned)
    expect(HAS_LONE_SURROGATE.test(out)).toBe(false)
    expect(() => JSON.parse(JSON.stringify(out))).not.toThrow()
  })

  test("tolerates astral input at every truncation boundary offset", () => {
    // Sweep the emoji across the cut point: any position must stay clean.
    for (let pad = 4088; pad <= 4096; pad++) {
      const text = "a".repeat(pad) + "😀" + "b".repeat(100)
      const out = sanitizeMessage(text)
      expect(HAS_LONE_SURROGATE.test(out)).toBe(false)
    }
  })
})
