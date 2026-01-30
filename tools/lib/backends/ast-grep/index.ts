import { registerBackend, type RefactorBackend } from "../../backend"
import { findPatterns, createPatternReplaceProposal } from "./patterns"

// Re-export for direct use
export { findPatterns, createPatternReplaceProposal }

/**
 * ast-grep backend for structural pattern matching across many languages.
 * Supports: Go, Rust, Python, Ruby, C, C++, Java, JSON, YAML, and more.
 *
 * Requires: ast-grep CLI (`sg`) - install via `brew install ast-grep` or `cargo install ast-grep`
 */
export const AstGrepBackend: RefactorBackend = {
  name: "ast-grep",
  // Lower priority than ts-morph for JS/TS (ts-morph handles symbols better)
  // Higher priority for other languages where it's the only option
  extensions: [".go", ".rs", ".py", ".rb", ".c", ".cpp", ".java", ".json", ".yaml", ".yml"],
  priority: 50,

  findPatterns(pattern, glob) {
    return findPatterns(pattern, glob)
  },

  createPatternReplaceProposal(pattern, replacement, glob) {
    return createPatternReplaceProposal(pattern, replacement, glob)
  },
}

// Register the backend
registerBackend(AstGrepBackend)
