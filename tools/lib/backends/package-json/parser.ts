/**
 * Package.json Parser
 *
 * Finds all path references in package.json files:
 * - main, module, types, browser (entry points)
 * - exports (subpath exports)
 * - imports (subpath imports)
 * - bin (executable paths)
 * - files (included files)
 * - typesVersions (TypeScript version-specific paths)
 */

export interface PackagePathRef {
  field: string // e.g., "main", "exports['.'].import", "bin.cli"
  path: string // the actual path value
  start: number // byte offset in file
  end: number // byte offset end
}

/**
 * Parse package.json and extract all path references
 */
export function parsePackageJson(content: string): PackagePathRef[] {
  const refs: PackagePathRef[] = []

  let pkg: Record<string, unknown>
  try {
    pkg = JSON.parse(content) as Record<string, unknown>
  } catch {
    return refs
  }

  // Simple entry points
  for (const field of ["main", "module", "types", "browser", "typings"]) {
    if (typeof pkg[field] === "string") {
      const ref = findStringInJson(content, field, pkg[field] as string)
      if (ref) refs.push({ field, path: pkg[field] as string, ...ref })
    }
  }

  // bin - can be string or object
  if (pkg.bin) {
    if (typeof pkg.bin === "string") {
      const ref = findStringInJson(content, "bin", pkg.bin)
      if (ref) refs.push({ field: "bin", path: pkg.bin, ...ref })
    } else if (typeof pkg.bin === "object") {
      for (const [name, binPath] of Object.entries(pkg.bin as Record<string, string>)) {
        const ref = findStringInJson(content, binPath, binPath)
        if (ref) refs.push({ field: `bin.${name}`, path: binPath, ...ref })
      }
    }
  }

  // files array
  if (Array.isArray(pkg.files)) {
    for (const filePath of pkg.files) {
      if (typeof filePath === "string") {
        const ref = findStringInJson(content, filePath, filePath)
        if (ref) refs.push({ field: "files[]", path: filePath, ...ref })
      }
    }
  }

  // exports - complex nested structure
  if (pkg.exports) {
    parseExportsField(content, pkg.exports, "exports", refs)
  }

  // imports - similar to exports
  if (pkg.imports) {
    parseExportsField(content, pkg.imports, "imports", refs)
  }

  // typesVersions
  if (pkg.typesVersions && typeof pkg.typesVersions === "object") {
    for (const [version, mappings] of Object.entries(pkg.typesVersions as Record<string, unknown>)) {
      if (typeof mappings === "object" && mappings) {
        for (const [pattern, paths] of Object.entries(mappings as Record<string, unknown>)) {
          if (Array.isArray(paths)) {
            for (const p of paths) {
              if (typeof p === "string") {
                const ref = findStringInJson(content, p, p)
                if (ref) refs.push({ field: `typesVersions.${version}.${pattern}`, path: p, ...ref })
              }
            }
          }
        }
      }
    }
  }

  return refs
}

/**
 * Parse exports/imports field recursively
 */
function parseExportsField(
  content: string,
  value: unknown,
  fieldPath: string,
  refs: PackagePathRef[]
): void {
  if (typeof value === "string") {
    // Direct path: "exports": "./dist/index.js"
    const ref = findStringInJson(content, value, value)
    if (ref) refs.push({ field: fieldPath, path: value, ...ref })
  } else if (typeof value === "object" && value !== null) {
    // Object with conditions or subpaths
    for (const [key, subValue] of Object.entries(value as Record<string, unknown>)) {
      const subPath = key.startsWith(".") ? `${fieldPath}['${key}']` : `${fieldPath}.${key}`
      parseExportsField(content, subValue, subPath, refs)
    }
  }
}

/**
 * Find a string value in JSON content and return its position
 * This is a simple approach that finds the quoted string
 */
function findStringInJson(content: string, _key: string, value: string): { start: number; end: number } | null {
  // Escape special regex characters in the value
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

  // Find the quoted string - could be single or double quotes
  const patterns = [
    new RegExp(`"${escaped}"`, "g"),
    new RegExp(`'${escaped}'`, "g"),
  ]

  for (const pattern of patterns) {
    const match = pattern.exec(content)
    if (match) {
      return {
        start: match.index,
        end: match.index + match[0].length,
      }
    }
  }

  return null
}

/**
 * Check if a path in package.json matches a file being renamed
 */
export function pathMatchesFile(pkgPath: string, filePath: string): boolean {
  // Normalize both paths
  const normalizedPkg = pkgPath.replace(/^\.\//, "").replace(/\\/g, "/")
  const normalizedFile = filePath.replace(/^\.\//, "").replace(/\\/g, "/")

  // Direct match
  if (normalizedPkg === normalizedFile) return true

  // Match without extension (package.json might omit .js)
  const pkgWithoutExt = normalizedPkg.replace(/\.(js|mjs|cjs|ts|tsx)$/, "")
  const fileWithoutExt = normalizedFile.replace(/\.(js|mjs|cjs|ts|tsx)$/, "")
  if (pkgWithoutExt === fileWithoutExt) return true

  // Match with dist/src swap (common pattern)
  const pkgAsSrc = normalizedPkg.replace(/^dist\//, "src/").replace(/\.js$/, ".ts")
  if (pkgAsSrc === normalizedFile) return true

  return false
}

/**
 * Generate replacement path preserving the original style
 */
export function generateReplacementPath(originalPath: string, oldFile: string, newFile: string): string {
  // Preserve the ./ prefix if present
  const hadDotSlash = originalPath.startsWith("./")

  // Preserve the extension style
  const hadExtension = /\.(js|mjs|cjs|ts|tsx)$/.test(originalPath)

  // Get the directory part of the original path
  const originalDir = originalPath.replace(/[^/]+$/, "")

  // Get the new filename
  let newName = newFile.split("/").pop() || newFile

  // If original didn't have extension, remove it from new
  if (!hadExtension) {
    newName = newName.replace(/\.(js|mjs|cjs|ts|tsx)$/, "")
  } else {
    // If original had .js but new file is .ts, convert
    const originalExt = originalPath.match(/\.(js|mjs|cjs|ts|tsx)$/)?.[1]
    if (originalExt === "js" && newName.endsWith(".ts")) {
      newName = newName.replace(/\.ts$/, ".js")
    }
  }

  let result = originalDir + newName

  // Ensure ./ prefix if original had it
  if (hadDotSlash && !result.startsWith("./")) {
    result = "./" + result
  }

  return result
}
