import { registerBackend, type RefactorBackend } from "../../backend"
import { findPatterns, createPatternReplaceProposal } from "./search"

// Re-export for direct use
export { findPatterns, createPatternReplaceProposal }

/**
 * Ripgrep backend for fast text search and batch replace.
 * Ideal for text/markdown files where structural patterns aren't needed.
 *
 * Advantages over Edit+replace_all:
 * - Dry-run preview before applying
 * - Checksum verification (drift detection)
 * - Batch replace across hundreds of files in one operation
 * - JSON output for programmatic use
 *
 * Requires: ripgrep (`rg`) - usually pre-installed or via `brew install ripgrep`
 */
export const RipgrepBackend: RefactorBackend = {
  name: "ripgrep",
  // Wildcard - handles any text file
  // Lower priority so language-specific backends take precedence
  extensions: ["*"],
  priority: 10,

  findPatterns(pattern, glob) {
    return findPatterns(pattern, glob)
  },

  createPatternReplaceProposal(pattern, replacement, glob) {
    return createPatternReplaceProposal(pattern, replacement, glob)
  },
}

// Register the backend
registerBackend(RipgrepBackend)
