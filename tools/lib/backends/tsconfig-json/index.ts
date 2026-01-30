import { registerBackend, type RefactorBackend } from "../../backend"
import { findTsConfigRefs, findTsConfigEdits, createTsConfigEditset } from "./search"

// Re-export
export { findTsConfigRefs, findTsConfigEdits, createTsConfigEditset }
export * from "./parser"

/**
 * TSConfig.json backend for updating TypeScript configuration paths.
 *
 * Handles:
 * - paths (module path mappings like @app/* -> src/*)
 * - baseUrl, outDir, rootDir, declarationDir
 * - include, exclude, files
 * - references (project references)
 * - extends
 *
 * When you rename/move TypeScript files, this backend updates all
 * tsconfig.json files that reference them.
 */
export const TsConfigJsonBackend: RefactorBackend = {
  name: "tsconfig-json",
  extensions: [".json"],
  priority: 46, // Just above package-json (45)

  findPatterns(pattern, glob) {
    return findTsConfigRefs(pattern, ".", glob ?? "**/tsconfig*.json")
  },

  createPatternReplaceProposal(pattern, replacement, _glob) {
    return createTsConfigEditset(pattern, replacement, ".")
  },
}

// Register
registerBackend(TsConfigJsonBackend)
