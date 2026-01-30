import { writeFileSync, readFileSync, existsSync } from "fs"
import type { Editset } from "./types"

/**
 * Filter an editset to include/exclude specific refs
 */
export function filterEditset(
  editset: Editset,
  include?: string[],
  exclude?: string[]
): Editset {
  let refs = editset.refs

  if (include && include.length > 0) {
    const includeSet = new Set(include)
    refs = refs.map((ref) => ({
      ...ref,
      selected: includeSet.has(ref.refId),
    }))
  }

  if (exclude && exclude.length > 0) {
    const excludeSet = new Set(exclude)
    refs = refs.map((ref) => ({
      ...ref,
      selected: ref.selected && !excludeSet.has(ref.refId),
    }))
  }

  // Regenerate edits for selected refs only
  const selectedFiles = new Set(refs.filter((r) => r.selected).map((r) => r.file))
  const edits = editset.edits.filter((e) => selectedFiles.has(e.file))

  return {
    ...editset,
    refs,
    edits,
  }
}

/**
 * Save editset to file
 */
export function saveEditset(editset: Editset, outputPath: string): void {
  writeFileSync(outputPath, JSON.stringify(editset, null, 2))
}

/**
 * Load editset from file
 */
export function loadEditset(inputPath: string): Editset {
  if (!existsSync(inputPath)) {
    throw new Error(`Editset file not found: ${inputPath}`)
  }
  const content = readFileSync(inputPath, "utf-8")
  return JSON.parse(content) as Editset
}
