/**
 * TSConfig.json Parser
 *
 * Finds all path references in tsconfig.json files:
 * - paths (module path mappings)
 * - baseUrl
 * - outDir, rootDir, declarationDir
 * - include, exclude, files
 * - references (project references)
 * - extends
 */

export interface TsConfigPathRef {
  field: string // e.g., "paths['@app/*']", "include[]", "references[].path"
  path: string // the actual path value
  start: number // byte offset in file
  end: number // byte offset end
  isGlob?: boolean // true for patterns like "src/**/*"
}

/**
 * Parse tsconfig.json and extract all path references
 */
export function parseTsConfig(content: string): TsConfigPathRef[] {
  const refs: TsConfigPathRef[] = []

  let config: Record<string, unknown>
  try {
    // Handle JSON with comments (JSONC) - strip comments first
    const stripped = stripJsonComments(content)
    config = JSON.parse(stripped) as Record<string, unknown>
  } catch {
    return refs
  }

  // extends
  if (typeof config.extends === "string") {
    const ref = findStringInJson(content, config.extends)
    if (ref) refs.push({ field: "extends", path: config.extends, ...ref })
  }

  // compilerOptions paths
  const compilerOptions = config.compilerOptions as Record<string, unknown> | undefined
  if (compilerOptions) {
    // baseUrl
    if (typeof compilerOptions.baseUrl === "string") {
      const ref = findStringInJson(content, compilerOptions.baseUrl)
      if (ref) refs.push({ field: "compilerOptions.baseUrl", path: compilerOptions.baseUrl, ...ref })
    }

    // outDir, rootDir, declarationDir
    for (const field of ["outDir", "rootDir", "declarationDir", "outFile"]) {
      if (typeof compilerOptions[field] === "string") {
        const ref = findStringInJson(content, compilerOptions[field] as string)
        if (ref) refs.push({ field: `compilerOptions.${field}`, path: compilerOptions[field] as string, ...ref })
      }
    }

    // paths mapping
    if (compilerOptions.paths && typeof compilerOptions.paths === "object") {
      for (const [alias, targets] of Object.entries(compilerOptions.paths as Record<string, unknown>)) {
        if (Array.isArray(targets)) {
          for (const target of targets) {
            if (typeof target === "string") {
              const ref = findStringInJson(content, target)
              if (ref) {
                refs.push({
                  field: `compilerOptions.paths['${alias}']`,
                  path: target,
                  ...ref,
                  isGlob: target.includes("*"),
                })
              }
            }
          }
        }
      }
    }

    // typeRoots
    if (Array.isArray(compilerOptions.typeRoots)) {
      for (const typeRoot of compilerOptions.typeRoots) {
        if (typeof typeRoot === "string") {
          const ref = findStringInJson(content, typeRoot)
          if (ref) refs.push({ field: "compilerOptions.typeRoots[]", path: typeRoot, ...ref })
        }
      }
    }
  }

  // include, exclude, files
  for (const field of ["include", "exclude", "files"]) {
    if (Array.isArray(config[field])) {
      for (const pattern of config[field] as string[]) {
        if (typeof pattern === "string") {
          const ref = findStringInJson(content, pattern)
          if (ref) {
            refs.push({
              field: `${field}[]`,
              path: pattern,
              ...ref,
              isGlob: pattern.includes("*"),
            })
          }
        }
      }
    }
  }

  // references (project references)
  if (Array.isArray(config.references)) {
    for (const ref of config.references) {
      if (typeof ref === "object" && ref && "path" in ref && typeof ref.path === "string") {
        const pathRef = findStringInJson(content, ref.path)
        if (pathRef) refs.push({ field: "references[].path", path: ref.path, ...pathRef })
      }
    }
  }

  return refs
}

/**
 * Strip JSON comments (single-line and multi-line) for parsing
 */
function stripJsonComments(content: string): string {
  let result = ""
  let inString = false
  let inSingleLineComment = false
  let inMultiLineComment = false

  for (let i = 0; i < content.length; i++) {
    const char = content[i]
    const nextChar = content[i + 1]

    if (inSingleLineComment) {
      if (char === "\n") {
        inSingleLineComment = false
        result += char
      }
      continue
    }

    if (inMultiLineComment) {
      if (char === "*" && nextChar === "/") {
        inMultiLineComment = false
        i++ // skip the /
      }
      continue
    }

    if (inString) {
      result += char
      if (char === '"' && content[i - 1] !== "\\") {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      result += char
      continue
    }

    if (char === "/" && nextChar === "/") {
      inSingleLineComment = true
      i++ // skip the second /
      continue
    }

    if (char === "/" && nextChar === "*") {
      inMultiLineComment = true
      i++ // skip the *
      continue
    }

    result += char
  }

  return result
}

/**
 * Find a string value in JSON content and return its position
 */
function findStringInJson(content: string, value: string): { start: number; end: number } | null {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const pattern = new RegExp(`"${escaped}"`, "g")

  const match = pattern.exec(content)
  if (match) {
    return {
      start: match.index,
      end: match.index + match[0].length,
    }
  }

  return null
}

/**
 * Check if a tsconfig path pattern matches a file
 */
export function tsconfigPathMatchesFile(tsconfigPath: string, filePath: string): boolean {
  // Handle glob patterns
  if (tsconfigPath.includes("*")) {
    // Convert glob to regex
    const regexPattern = tsconfigPath
      .replace(/\./g, "\\.")
      .replace(/\*\*/g, "<<<GLOBSTAR>>>")
      .replace(/\*/g, "[^/]*")
      .replace(/<<<GLOBSTAR>>>/g, ".*")

    const regex = new RegExp(`^${regexPattern}$`)
    return regex.test(filePath)
  }

  // Direct match
  const normalized1 = tsconfigPath.replace(/^\.\//, "").replace(/\\/g, "/")
  const normalized2 = filePath.replace(/^\.\//, "").replace(/\\/g, "/")

  return normalized1 === normalized2 || normalized1 === normalized2.replace(/\.(ts|tsx|js|jsx)$/, "")
}

/**
 * Generate replacement path for tsconfig
 */
export function generateTsConfigReplacementPath(
  originalPath: string,
  oldFile: string,
  newFile: string
): string {
  // For glob patterns, we need to update the base directory if it changed
  if (originalPath.includes("*")) {
    const oldDir = oldFile.split("/").slice(0, -1).join("/")
    const newDir = newFile.split("/").slice(0, -1).join("/")

    if (oldDir !== newDir) {
      return originalPath.replace(oldDir, newDir)
    }
    return originalPath // Glob pattern, file moved within same dir
  }

  // For direct paths, similar logic to package.json
  const hadDotSlash = originalPath.startsWith("./")
  let result = newFile

  if (hadDotSlash && !result.startsWith("./")) {
    result = "./" + result
  }

  return result
}
