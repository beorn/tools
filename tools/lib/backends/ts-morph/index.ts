import { registerBackend, type RefactorBackend } from "../../backend"
import { getProject, resetProject } from "./project"
import { getSymbolAt, getReferences, findSymbols, findAllSymbols, computeNewName } from "./symbols"
import { createRenameProposal, createBatchRenameProposal, checkConflicts, createBatchRenameProposalFiltered } from "./edits"

// Re-export all functions for direct use
export {
  getProject,
  resetProject,
  getSymbolAt,
  getReferences,
  findSymbols,
  findAllSymbols,
  computeNewName,
  createRenameProposal,
  createBatchRenameProposal,
  createBatchRenameProposalFiltered,
  checkConflicts,
}

/**
 * ts-morph backend for TypeScript/JavaScript refactoring
 */
export const TsMorphBackend: RefactorBackend = {
  name: "ts-morph",
  extensions: [".ts", ".tsx", ".js", ".jsx"],
  priority: 100, // High priority for JS/TS files

  getSymbolAt(file, line, col) {
    const project = getProject()
    return getSymbolAt(project, file, line, col)
  },

  getReferences(symbolKey) {
    const project = getProject()
    return getReferences(project, symbolKey)
  },

  findSymbols(pattern) {
    const project = getProject()
    return findSymbols(project, pattern)
  },

  createRenameProposal(symbolKey, newName) {
    const project = getProject()
    return createRenameProposal(project, symbolKey, newName)
  },

  createBatchRenameProposal(pattern, replacement) {
    const project = getProject()
    return createBatchRenameProposal(project, pattern, replacement)
  },
}

// Register the backend
registerBackend(TsMorphBackend)
