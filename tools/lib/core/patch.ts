import type { Editset, Reference } from "./types"

/**
 * Patch format: refId → replacement or null
 * - string: use this replacement instead of default
 * - null: skip this ref (don't apply)
 * - missing: apply with default replacement
 */
export type Patch = Record<string, string | null>

/**
 * Apply a patch to an editset, modifying the `replace` field of each ref.
 *
 * @param editset - The editset to patch
 * @param patch - Map of refId → replacement (string) or null (skip)
 * @returns Modified editset with updated refs and edits
 */
export function applyPatch(editset: Editset, patch: Patch): Editset {
  const defaultReplacement = editset.to

  // Update refs with patch values
  const patchedRefs: Reference[] = editset.refs.map((ref) => {
    if (ref.refId in patch) {
      const value = patch[ref.refId]
      return {
        ...ref,
        replace: value, // null = skip, string = custom replacement
        selected: value !== null, // Update selected based on skip
      }
    }
    // Not in patch: keep existing or set to default
    return {
      ...ref,
      replace: ref.replace ?? defaultReplacement,
      selected: ref.replace !== null,
    }
  })

  // Update edits with custom replacements from patched refs
  const patchedEdits = editset.edits
    .map((edit) => {
      // Try to find matching ref by computing the key
      // Edits use byte offset, refs use line/col - we need to match them
      // For now, just update based on default vs custom replacement
      const matchingRef = patchedRefs.find(
        (r) => r.file === edit.file && r.selected && r.replace !== null
      )
      if (matchingRef && matchingRef.replace !== defaultReplacement) {
        return { ...edit, replacement: matchingRef.replace! }
      }
      return edit
    })
    .filter((edit) => {
      // Only keep edits for files that have selected refs
      return patchedRefs.some((r) => r.file === edit.file && r.selected && r.replace !== null)
    })

  return {
    ...editset,
    refs: patchedRefs,
    edits: patchedEdits,
  }
}

/**
 * Parse patch from JSON input (stdin or file).
 * Accepts either a full editset or a minimal patch object.
 */
export function parsePatch(input: string): Patch {
  const parsed = JSON.parse(input) as { refs?: Array<{ refId?: string; replace?: string }> }

  // If it has refs/edits, it's a full editset - extract replace values
  if (parsed.refs && Array.isArray(parsed.refs)) {
    const patch: Patch = {}
    for (const ref of parsed.refs) {
      if (ref.refId && ref.replace !== undefined) {
        patch[ref.refId] = ref.replace
      }
    }
    return patch
  }

  // Otherwise it's a minimal patch: { refId: value, ... }
  return parsed as Patch
}
