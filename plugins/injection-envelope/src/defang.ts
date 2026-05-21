/**
 * Make a string less transcript-shaped before it lands in user-role
 * context, breaking the autocatalytic role-prefix hallucination trigger.
 *
 * The trigger: when Claude Code's harness wraps captured text in
 * `<system-reminder>UserPromptSubmit hook ...</system-reminder>` and
 * the captured text contains either (a) loggily-style log lines
 * (HH:MM:SS LEVEL ns msg ...) or (b) literal role prefixes at line
 * starts (Human / Assistant / User / H followed by a colon), the
 * model's next token is heavily biased toward emitting `Human:` itself,
 * producing a phantom user-role boundary in the assistant's response.
 *
 * Upstream issue: https://github.com/anthropics/claude-code/issues/50972.
 *
 * Two-source insufficiency (why this exists in addition to the hook
 * stderr muzzle in `tools/lib/tribe/hook-dispatch.ts`): the harness
 * wraps captured text under at least two framings —
 *   - `UserPromptSubmit hook success: <stderr>` (closed by the muzzle), and
 *   - `UserPromptSubmit hook additional context: <additionalContext>` (THIS path).
 * The second framing carries our intentional payload (recall snippets,
 * tribe channel forwarding, ...) so we can't muzzle it; we have to make
 * the payload itself non-transcript-shaped before emit.
 *
 * Three transformations, applied in order:
 *
 *   1. `[log-redacted]` substitution for `HH:MM:SS LEVEL <namespace>` line
 *      shapes. These produced 80+ violations / 9h on 2026-05-09 from
 *      loggily-default console output captured into hook stderr; the
 *      muzzle closed that source, but tribe / recall payloads can still
 *      carry log-shaped strings (quoted commit messages, daemon status
 *      lines). Redact the *shape*, keep neighboring prose.
 *
 *   2. Zero-width-space defang of role-prefix literals at line starts.
 *      The literal stays readable to a human eye but tokenizes
 *      differently — typically as `H` + ZWSP + `uman:` rather than the
 *      single trained-on token — breaking autoregressive
 *      pattern-completion at exactly that shape.
 *
 *   3. Cap consecutive newlines at 2. Multi-newline dumps mimic
 *      transcript structure; tighten to running-prose layout.
 *
 *   4. Replace any *lone* UTF-16 surrogate with U+FFFD. Lone surrogates are
 *      legal in JS strings but illegal in transmitted JSON: when the Claude
 *      Code harness `JSON.stringify`s a conversation that contains one, the
 *      Anthropic API rejects the whole request body with
 *      `400 ... no low surrogate in string`, hard-blocking the agent for the
 *      rest of its session. A single poisoned channel message is enough.
 *      They get here when some upstream truncation (`str.slice(0, n)`,
 *      byte-length cap, regex) cuts a string mid-surrogate-pair. This is the
 *      universal safety net — `defangModelInput` is the single chokepoint all
 *      injected payloads pass through before reaching the model's context, so
 *      stripping here means no truncation bug anywhere can poison an agent.
 *
 * What this is NOT for: user-typed text. The hook's `userPrompt`
 * parameter is high-trust by definition (the user typed it). Defanging
 * it would distort code samples and other literal content the user
 * intends. Apply this only to *injected* payloads — `additionalContext`
 * envelopes, item snippets, item summaries — never to the user's
 * verbatim prompt.
 */

/**
 * Match `HH:MM:SS LEVEL ns ...` lines (loggily / console-style logs).
 * Conservative: requires a known level keyword to avoid eating user
 * prose that happens to start with a time-of-day.
 */
const LOG_LINE_RE = /\d{2}:\d{2}:\d{2}\s+(?:INFO|WARN|ERROR|DEBUG|TRACE)\s+\S+(?:\s[^\n]*)?/g

/**
 * Match `Human:` / `Assistant:` / `User:` / `H:` at the start of a line
 * followed by whitespace or end-of-string. The `H` short-form is in the
 * detector regex in `~/.claude/hooks/detect-role-prefix.sh`, so we match
 * it here too.
 */
const ROLE_PREFIX_RE = /(^|\n)(Human|Assistant|User|H):(?=\s|$)/g

/**
 * Zero-width space (U+200B) — built from a code point so the source
 * stays grep-safe and survives editor / formatter round-trips. Do NOT
 * replace with a literal U+200B character: invisible characters in
 * source confuse readers and some editors strip them.
 */
const ZWSP = String.fromCharCode(0x200b)

/**
 * Match a *lone* UTF-16 surrogate code unit — a high surrogate
 * (U+D800–U+DBFF) not followed by a low surrogate, or a low surrogate
 * (U+DC00–U+DFFF) not preceded by a high surrogate. Well-formed surrogate
 * pairs (emoji, astral-plane characters) do NOT match and pass through
 * untouched.
 */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

function defangRolePrefix(_match: string, lead: string, role: string): string {
  return `${lead}${role[0]}${ZWSP}${role.slice(1)}:`
}

/**
 * Apply transcript-shape defanging to a string bound for the model's
 * user-role context.
 *
 * Idempotent: applying twice is the same as applying once (log lines
 * have already become `[log-redacted]`; ROLE-prefix matches don't
 * survive the first pass).
 */
export function defangModelInput(text: string): string {
  if (text.length === 0) return text
  return text
    .replace(LOG_LINE_RE, "[log-redacted]")
    .replace(ROLE_PREFIX_RE, defangRolePrefix)
    .replace(/\n{3,}/g, "\n\n")
    .replace(LONE_SURROGATE_RE, "�")
}
