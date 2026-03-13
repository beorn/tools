import { readFileSync, writeFileSync, existsSync } from "fs"
import { createHash } from "crypto"
import type { Editset, ApplyOutput, Edit } from "./types"

/**
 * Detect whether edits for a file use byte offsets instead of character offsets.
 * Compares: if offsets are byte-based, converting them to char offsets will produce
 * different values for files containing multi-byte characters (UTF-8 sequences > 1 byte
 * per character: CJK, emoji, box-drawing, etc.).
 *
 * Returns converted edits if byte offsets detected, or the originals if already char-based.
 */
function normalizeOffsets(content: string, edits: Edit[]): { edits: Edit[]; converted: boolean } {
  // Quick check: if content has no multi-byte chars, byte === char offsets
  const byteLen = Buffer.byteLength(content, "utf-8")
  if (byteLen === content.length) {
    return { edits, converted: false }
  }

  // Build byte→char offset map lazily (only when needed)
  // Check if any edit offset exceeds content.length (clear sign of byte offsets)
  const maxCharOffset = content.length
  const looksLikeBytes = edits.some((e) => e.offset > maxCharOffset || e.offset + e.length > maxCharOffset)

  if (!looksLikeBytes) {
    // Offsets fit within character range — could still be byte offsets that happen to be
    // in range. Spot-check: verify the text at each offset is plausible.
    // For now, trust them as character offsets.
    return { edits, converted: false }
  }

  // Convert byte offsets to character offsets
  const buf = Buffer.from(content, "utf-8")
  const converted = edits.map((edit) => {
    const prefix = buf.subarray(0, edit.offset).toString("utf-8")
    const charOffset = prefix.length
    const segment = buf.subarray(edit.offset, edit.offset + edit.length).toString("utf-8")
    const charLength = segment.length
    return { ...edit, offset: charOffset, length: charLength }
  })

  return { edits: converted, converted: true }
}

/**
 * Compute SHA256 checksum of content (first 12 chars)
 */
export function computeChecksum(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 12)
}

/**
 * Compute stable reference ID from location
 */
export function computeRefId(
  file: string,
  startLine: number,
  startCol: number,
  endLine: number,
  endCol: number,
): string {
  const input = `${file}:${startLine}:${startCol}:${endLine}:${endCol}`
  return createHash("sha256").update(input).digest("hex").slice(0, 8)
}

/**
 * Apply an editset with checksum verification
 *
 * Returns details about what was applied, skipped, or had drift detected.
 */
export function applyEditset(editset: Editset, dryRun = false): ApplyOutput {
  const result: ApplyOutput = {
    applied: 0,
    skipped: 0,
    driftDetected: [],
  }

  // Group edits by file
  const editsByFile = new Map<string, Edit[]>()
  for (const edit of editset.edits) {
    if (!editsByFile.has(edit.file)) {
      editsByFile.set(edit.file, [])
    }
    editsByFile.get(edit.file)!.push(edit)
  }

  // Get selected refs for checksum verification
  const selectedRefs = editset.refs.filter((ref) => ref.selected)
  const refsByFile = new Map<string, (typeof selectedRefs)[0][]>()
  for (const ref of selectedRefs) {
    if (!refsByFile.has(ref.file)) {
      refsByFile.set(ref.file, [])
    }
    refsByFile.get(ref.file)!.push(ref)
  }

  // Process each file
  for (const [filePath, fileEdits] of editsByFile) {
    // Check if file exists
    if (!existsSync(filePath)) {
      result.driftDetected.push({
        file: filePath,
        reason: "File not found",
      })
      result.skipped += fileEdits.length
      continue
    }

    // Read current content
    const currentContent = readFileSync(filePath, "utf-8")
    const currentChecksum = computeChecksum(currentContent)

    // Verify checksum if we have refs for this file
    const refs = refsByFile.get(filePath) || []
    if (refs.length > 0) {
      const expectedChecksum = refs[0]!.checksum
      if (currentChecksum !== expectedChecksum) {
        result.driftDetected.push({
          file: filePath,
          reason: `Checksum mismatch: expected ${expectedChecksum}, got ${currentChecksum}`,
        })
        result.skipped += fileEdits.length
        continue
      }
    }

    // Normalize offsets: detect and convert byte offsets to character offsets
    const { edits: normalizedEdits, converted } = normalizeOffsets(currentContent, fileEdits)
    if (converted) {
      console.warn(`  ⚠ ${filePath}: converted byte offsets → character offsets (multi-byte chars detected)`)
    }

    // Sort edits by offset descending (apply from end to start to avoid offset drift)
    const sortedEdits = [...normalizedEdits].sort((a, b) => b.offset - a.offset)

    // Apply edits
    let newContent = currentContent
    for (const edit of sortedEdits) {
      const before = newContent.slice(0, edit.offset)
      const after = newContent.slice(edit.offset + edit.length)
      newContent = before + edit.replacement + after
      result.applied++
    }

    // Write file (unless dry run)
    if (!dryRun) {
      writeFileSync(filePath, newContent)
    }
  }

  return result
}

/**
 * Verify an editset can be applied without drift.
 * Checks file existence, checksums, and edit offset validity.
 */
export function verifyEditset(editset: Editset): {
  valid: boolean
  issues: string[]
  warnings: string[]
} {
  const issues: string[] = []
  const warnings: string[] = []

  // Check all files exist and checksums match
  const checkedFiles = new Set<string>()

  for (const ref of editset.refs) {
    if (checkedFiles.has(ref.file)) continue
    checkedFiles.add(ref.file)

    if (!existsSync(ref.file)) {
      issues.push(`File not found: ${ref.file}`)
      continue
    }

    const content = readFileSync(ref.file, "utf-8")
    const checksum = computeChecksum(content)

    if (checksum !== ref.checksum) {
      issues.push(`Checksum mismatch for ${ref.file}: expected ${ref.checksum}, got ${checksum}`)
    }
  }

  // Verify edit offsets are within bounds and detect byte/char offset confusion
  const fileContents = new Map<string, string>()
  for (const edit of editset.edits) {
    let content = fileContents.get(edit.file)
    if (content === undefined) {
      if (!existsSync(edit.file)) continue
      content = readFileSync(edit.file, "utf-8")
      fileContents.set(edit.file, content)
    }

    if (edit.offset + edit.length > content.length) {
      const byteLen = Buffer.byteLength(content, "utf-8")
      if (edit.offset + edit.length <= byteLen) {
        warnings.push(
          `${edit.file}: offset ${edit.offset}+${edit.length} exceeds string length ${content.length} ` +
            `but fits byte length ${byteLen} — likely byte offsets (will auto-convert on apply)`,
        )
      } else {
        issues.push(
          `${edit.file}: offset ${edit.offset}+${edit.length} exceeds both string length ${content.length} ` +
            `and byte length ${byteLen}`,
        )
      }
    }
  }

  return {
    valid: issues.length === 0,
    issues,
    warnings,
  }
}
