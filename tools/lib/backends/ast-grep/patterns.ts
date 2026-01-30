import { execFileSync } from "child_process"
import { readFileSync, existsSync } from "fs"
import type { Reference, Editset, Edit } from "../../core/types"
import { computeChecksum, computeRefId } from "../../core/apply"

/**
 * Find patterns using ast-grep structural search
 *
 * @param pattern - ast-grep pattern (e.g., "fmt.Println($MSG)" for Go)
 * @param glob - Optional file glob filter (e.g., "**\/*.go")
 */
export function findPatterns(pattern: string, glob?: string): Reference[] {
  const args = ["run", "-p", pattern, "--json"]
  if (glob) {
    args.push("--filter", glob)
  }

  const result = runSg(args)
  if (!result) return []

  return parseMatches(result)
}

/**
 * Create an editset for pattern-based replacements
 *
 * @param pattern - ast-grep pattern with metavariables (e.g., "fmt.Println($MSG)")
 * @param replacement - Replacement with metavariables (e.g., "log.Info($MSG)")
 * @param glob - Optional file glob filter
 */
export function createPatternReplaceProposal(
  pattern: string,
  replacement: string,
  glob?: string
): Editset {
  const refs = findPatterns(pattern, glob)

  const id = `pattern-replace-${Date.now()}`

  // Generate edits from matches
  const edits = generateEdits(refs, replacement)

  return {
    id,
    operation: "rename", // Using "rename" since that's what Editset supports
    pattern,
    from: pattern,
    to: replacement,
    refs,
    edits,
    createdAt: new Date().toISOString(),
  }
}

// Internal helpers

interface SgMatch {
  file: string
  range: {
    byteOffset: { start: number; end: number }
    start: { line: number; column: number }
    end: { line: number; column: number }
  }
  text: string
  replacement?: string
  metaVariables?: Record<string, { text: string }>
}

function runSg(args: string[]): SgMatch[] | null {
  try {
    const output = execFileSync("sg", args, {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large codebases
      stdio: ["pipe", "pipe", "pipe"],
    })
    return JSON.parse(output) as SgMatch[]
  } catch (error: unknown) {
    // ast-grep returns exit code 1 when no matches found
    const execError = error as { status?: number; stdout?: string }
    if (execError.status === 1 && !execError.stdout) {
      return []
    }
    // Check if sg is installed
    if (
      error instanceof Error &&
      (error.message.includes("ENOENT") || error.message.includes("not found"))
    ) {
      throw new Error(
        "ast-grep CLI (sg) not found. Install via: brew install ast-grep or cargo install ast-grep"
      )
    }
    throw error
  }
}

function parseMatches(matches: SgMatch[]): Reference[] {
  const refs: Reference[] = []
  const fileContents = new Map<string, string>()

  for (const match of matches) {
    // Get file content for checksum
    let content = fileContents.get(match.file)
    if (!content) {
      if (!existsSync(match.file)) continue
      content = readFileSync(match.file, "utf-8")
      fileContents.set(match.file, content)
    }

    const checksum = computeChecksum(content)
    const { start, end } = match.range
    const refId = computeRefId(match.file, start.line, start.column, end.line, end.column)

    // Get preview (the line containing the match)
    const lines = content.split("\n")
    const preview = lines[start.line - 1]?.trim() || ""

    refs.push({
      refId,
      file: match.file,
      range: [start.line, start.column, end.line, end.column],
      preview,
      checksum,
      selected: true,
    })
  }

  return refs
}

function generateEdits(refs: Reference[], _replacement: string): Edit[] {
  const edits: Edit[] = []
  const fileContents = new Map<string, string>()

  for (const ref of refs) {
    if (!ref.selected) continue

    // Get file content
    let content = fileContents.get(ref.file)
    if (!content) {
      if (!existsSync(ref.file)) continue
      content = readFileSync(ref.file, "utf-8")
      fileContents.set(ref.file, content)
    }

    // Calculate byte offset from line/col
    const lines = content.split("\n")
    let startOffset = 0
    for (let i = 0; i < ref.range[0] - 1; i++) {
      startOffset += lines[i]!.length + 1 // +1 for newline
    }
    startOffset += ref.range[1] - 1

    let endOffset = 0
    for (let i = 0; i < ref.range[2] - 1; i++) {
      endOffset += lines[i]!.length + 1
    }
    endOffset += ref.range[3] - 1

    const length = endOffset - startOffset

    // Note: For ast-grep, the replacement should ideally come from sg --rewrite
    // For now, we use the provided replacement directly
    // TODO: Use `sg run -p <pattern> --rewrite <replacement> --json` to get actual replacements
    edits.push({
      file: ref.file,
      offset: startOffset,
      length,
      replacement: _replacement,
    })
  }

  // Sort by file then by offset descending
  return edits.sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file)
    return b.offset - a.offset
  })
}
