import { registerBackend, type RefactorBackend } from "../../backend"
import { findLinksToFile, createFileRenameEditset, findBrokenLinks } from "./search"

// Re-export for direct use
export { findLinksToFile, createFileRenameEditset, findBrokenLinks }
export * from "./parser"

/**
 * Wiki-link backend for markdown-based knowledge repos.
 *
 * Supports link formats from:
 * - Obsidian: [[note]], [[note|alias]], ![[embed]], [[note#heading]]
 * - Foam: [[note]], [text](path.md)
 * - Dendron: [[folder.note]] (hierarchical)
 * - Logseq: [[note]], ((block-ref))
 * - GitHub Wiki: [[Page Name]]
 * - MkDocs/Docusaurus/VitePress: [text](path.md)
 *
 * Primary operations:
 * - findLinksToFile: Find all links pointing to a file
 * - createFileRenameEditset: Update links when renaming files
 * - findBrokenLinks: Detect links to non-existent files
 *
 * Requires: ripgrep (`rg`) for fast file searching
 */
export const WikilinkBackend: RefactorBackend = {
  name: "wikilink",
  // Handles markdown files
  extensions: [".md", ".markdown", ".mdx"],
  // Higher than ripgrep (10) but lower than ts-morph (100)
  // This ensures wikilink-aware processing for markdown files
  priority: 40,

  /**
   * Find wikilinks matching a pattern
   *
   * Pattern format: file name to search for links to
   * Returns all wikilinks pointing to that file
   */
  findPatterns(pattern, glob) {
    return findLinksToFile(pattern, ".", glob ?? "**/*.md")
  },

  /**
   * Create editset for updating wikilinks when renaming a file
   *
   * Pattern: old file name (or path)
   * Replacement: new file name (or path)
   */
  createPatternReplaceProposal(pattern, replacement, glob) {
    // For wikilink backend, pattern is old file path, replacement is new path
    const editset = createFileRenameEditset(pattern, replacement, ".")

    // Convert FileEditset to standard Editset format for compatibility
    return {
      id: editset.id,
      operation: "rename" as const,
      pattern: editset.pattern,
      from: pattern,
      to: replacement,
      refs: [], // Refs are embedded in the edits
      edits: editset.importEdits,
      createdAt: editset.createdAt,
    }
  },
}

// Register the backend
registerBackend(WikilinkBackend)
