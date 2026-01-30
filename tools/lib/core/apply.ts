import { readFileSync, writeFileSync, existsSync } from "fs"
import { createHash } from "crypto"
import type { Editset, ApplyOutput, Edit } from "./types"

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
  endCol: number
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

    // Sort edits by offset descending (apply from end to start to avoid offset drift)
    const sortedEdits = [...fileEdits].sort((a, b) => b.offset - a.offset)

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
 * Verify an editset can be applied without drift
 */
export function verifyEditset(editset: Editset): { valid: boolean; issues: string[] } {
  const issues: string[] = []

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

  return {
    valid: issues.length === 0,
    issues,
  }
}
