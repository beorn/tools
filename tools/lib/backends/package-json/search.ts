import { execSync } from "child_process"
import { readFileSync, existsSync } from "fs"
import { basename, dirname, join, relative } from "path"
import type { Reference, Edit, Editset } from "../../core/types"
import { computeChecksum, computeRefId } from "../../core/apply"
import { parsePackageJson, pathMatchesFile, generateReplacementPath } from "./parser"

/**
 * Find all package.json files that reference a specific file
 */
export function findPackageJsonRefs(
  targetFile: string,
  searchPath: string = ".",
  glob: string = "**/package.json"
): Reference[] {
  const refs: Reference[] = []

  // Find all package.json files
  const packageJsonFiles = findPackageJsonFiles(searchPath, glob)

  for (const pkgFile of packageJsonFiles) {
    if (!existsSync(pkgFile)) continue

    const content = readFileSync(pkgFile, "utf-8")
    const checksum = computeChecksum(content)
    const pathRefs = parsePackageJson(content)

    for (const pathRef of pathRefs) {
      // Check if this path references our target file
      // Need to resolve relative to the package.json location
      const pkgDir = dirname(pkgFile)
      const resolvedPath = join(pkgDir, pathRef.path)
      const targetResolved = join(searchPath, targetFile)

      if (pathMatchesFile(pathRef.path, relative(pkgDir, targetResolved))) {
        const [line, col] = offsetToLineCol(content, pathRef.start)
        const [endLine, endCol] = offsetToLineCol(content, pathRef.end)

        refs.push({
          refId: computeRefId(pkgFile, line, col, endLine, endCol),
          file: relative(searchPath, pkgFile),
          range: [line, col, endLine, endCol],
          preview: `${pathRef.field}: "${pathRef.path}"`,
          checksum,
          selected: true,
        })
      }
    }
  }

  return refs
}

/**
 * Generate edits to update package.json when files are renamed
 */
export function findPackageJsonEdits(
  oldPath: string,
  newPath: string,
  searchPath: string = "."
): Edit[] {
  const edits: Edit[] = []

  // Find all package.json files
  const packageJsonFiles = findPackageJsonFiles(searchPath, "**/package.json")

  for (const pkgFile of packageJsonFiles) {
    if (!existsSync(pkgFile)) continue

    const content = readFileSync(pkgFile, "utf-8")
    const pathRefs = parsePackageJson(content)
    const pkgDir = dirname(pkgFile)

    for (const pathRef of pathRefs) {
      // Check if this path references the old file
      const oldRelative = relative(pkgDir, join(searchPath, oldPath))

      if (pathMatchesFile(pathRef.path, oldRelative)) {
        // Generate the new path
        const newRelative = relative(pkgDir, join(searchPath, newPath))
        const replacement = generateReplacementPath(pathRef.path, oldPath, newRelative)

        // The replacement includes quotes
        const originalQuote = content[pathRef.start]
        const fullReplacement = `${originalQuote}${replacement}${originalQuote}`

        edits.push({
          file: relative(searchPath, pkgFile),
          offset: pathRef.start,
          length: pathRef.end - pathRef.start,
          replacement: fullReplacement,
        })
      }
    }
  }

  // Sort by file then offset descending
  return edits.sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file)
    return b.offset - a.offset
  })
}

/**
 * Create an editset for updating package.json paths
 */
export function createPackageJsonEditset(
  oldPath: string,
  newPath: string,
  searchPath: string = "."
): Editset {
  const edits = findPackageJsonEdits(oldPath, newPath, searchPath)

  // Convert edits to refs for the editset format
  const refs: Reference[] = []
  for (const edit of edits) {
    const filePath = join(searchPath, edit.file)
    if (!existsSync(filePath)) continue

    const content = readFileSync(filePath, "utf-8")
    const checksum = computeChecksum(content)
    const [line, col] = offsetToLineCol(content, edit.offset)
    const [endLine, endCol] = offsetToLineCol(content, edit.offset + edit.length)

    refs.push({
      refId: computeRefId(edit.file, line, col, endLine, endCol),
      file: edit.file,
      range: [line, col, endLine, endCol],
      preview: `Update path to ${newPath}`,
      checksum,
      selected: true,
    })
  }

  return {
    id: `package-json-${Date.now()}`,
    operation: "rename",
    from: oldPath,
    to: newPath,
    refs,
    edits,
    createdAt: new Date().toISOString(),
  }
}

/**
 * Find all package.json that might have outdated paths (for linting)
 */
export function findBrokenPackageJsonPaths(searchPath: string = "."): Reference[] {
  const refs: Reference[] = []
  const packageJsonFiles = findPackageJsonFiles(searchPath, "**/package.json")

  for (const pkgFile of packageJsonFiles) {
    if (!existsSync(pkgFile)) continue

    const content = readFileSync(pkgFile, "utf-8")
    const checksum = computeChecksum(content)
    const pathRefs = parsePackageJson(content)
    const pkgDir = dirname(pkgFile)

    for (const pathRef of pathRefs) {
      // Skip non-file paths (like package names in dependencies)
      if (!pathRef.path.startsWith(".") && !pathRef.path.startsWith("/")) continue

      // Check if the referenced file exists
      const resolvedPath = join(pkgDir, pathRef.path)

      // Try with common extensions
      const extensions = ["", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".json"]
      const exists = extensions.some((ext) => existsSync(resolvedPath + ext))

      if (!exists) {
        const [line, col] = offsetToLineCol(content, pathRef.start)
        const [endLine, endCol] = offsetToLineCol(content, pathRef.end)

        refs.push({
          refId: computeRefId(pkgFile, line, col, endLine, endCol),
          file: relative(searchPath, pkgFile),
          range: [line, col, endLine, endCol],
          preview: `BROKEN: ${pathRef.field} → "${pathRef.path}" not found`,
          checksum,
          selected: true,
        })
      }
    }
  }

  return refs
}

// Internal helpers

function findPackageJsonFiles(searchPath: string, glob: string): string[] {
  try {
    const output = execSync(`rg --files --glob "${glob}" "${searchPath}"`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    })
    return output
      .trim()
      .split("\n")
      .filter(Boolean)
      .filter((f) => !f.includes("node_modules"))
  } catch {
    return []
  }
}

function offsetToLineCol(content: string, offset: number): [number, number] {
  let line = 1
  let col = 1
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === "\n") {
      line++
      col = 1
    } else {
      col++
    }
  }
  return [line, col]
}
