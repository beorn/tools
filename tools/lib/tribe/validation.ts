/**
 * Tribe input validation — name format and message sanitization.
 */

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
  const cleaned = content.replace(/[\x00-\x09\x0B-\x1F\x7F]/g, "")
  // Cap at 4096 chars
  if (cleaned.length > 4096) return cleaned.slice(0, 4093) + "..."
  return cleaned
}
