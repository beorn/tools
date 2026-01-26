#!/usr/bin/env bun
/**
 * refactor.ts - Agent-first TypeScript refactoring CLI
 *
 * Editset workflow: propose → select → apply
 *
 * Commands:
 *   symbol.at <file> <line> [col]     Find symbol at location
 *   refs.list <symbolKey>             List all references
 *   symbols.find --pattern <regex>    Find all symbols matching pattern
 *   rename.propose <symbolKey> <new>  Create rename editset
 *   rename.batch --pattern <p> --replace <r>  Batch rename proposal
 *   editset.select <file> --exclude   Filter editset
 *   editset.apply <file>              Apply editset with checksums
 *   editset.verify <file>             Verify editset can be applied
 */

// Import ts-morph backend (registers itself)
import {
  getProject,
  getSymbolAt,
  getReferences,
  findSymbols,
  createRenameProposal,
  createBatchRenameProposal,
  createBatchRenameProposalFiltered,
  checkConflicts,
} from "./lib/backends/ts-morph"

// Import core utilities
import { filterEditset, saveEditset, loadEditset } from "./lib/core/editset"
import { applyEditset, verifyEditset } from "./lib/core/apply"

const args = process.argv.slice(2)
const command = args[0]

function output(data: unknown): void {
  console.log(JSON.stringify(data, null, 2))
}

function error(message: string): never {
  console.error(JSON.stringify({ error: message }))
  process.exit(1)
}

function usage(): never {
  console.error(`Usage: refactor.ts <command> [options]

Commands:
  symbol.at <file> <line> [col]           Find symbol at location
  refs.list <symbolKey>                   List all references
  symbols.find --pattern <regex>          Find all symbols matching pattern

  rename.propose <symbolKey> <newName>    Create rename editset
    --output <file>                       Output file (default: editset.json)

  rename.batch                            Batch rename proposal
    --pattern <regex>                     Symbol pattern to match
    --replace <string>                    Replacement string
    --output <file>                       Output file (default: editset.json)
    --check-conflicts                     Check for naming conflicts (no editset generated)
    --skip <names>                        Comma-separated symbol names to skip

  editset.select <file>                   Filter editset
    --include <refIds>                    Comma-separated refIds to include
    --exclude <refIds>                    Comma-separated refIds to exclude
    --output <file>                       Output file (default: overwrites input)

  editset.apply <file>                    Apply editset with checksums
    --dry-run                             Preview without applying

  editset.verify <file>                   Verify editset can be applied

Global Options:
  --tsconfig <file>                       Path to tsconfig.json (default: tsconfig.json)

Examples:
  # Find symbol at location
  refactor.ts symbol.at src/types.ts 42 5

  # List references
  refactor.ts refs.list "src/types.ts:42:5:widget"

  # Find all widget symbols
  refactor.ts symbols.find --pattern widget

  # Check for naming conflicts first
  refactor.ts rename.batch --pattern widget --replace gadget --check-conflicts

  # Create batch rename proposal (skipping conflicting symbols)
  refactor.ts rename.batch --pattern widget --replace gadget --skip createWidget,Widget --output editset.json

  # Preview apply
  refactor.ts editset.apply editset.json --dry-run

  # Apply
  refactor.ts editset.apply editset.json
`)
  process.exit(1)
}

function getArg(name: string): string | undefined {
  const idx = args.indexOf(name)
  if (idx === -1) return undefined
  return args[idx + 1]
}

function hasFlag(name: string): boolean {
  return args.includes(name)
}

async function main() {
  if (!command || command === "--help" || command === "-h") {
    usage()
  }

  // Lazy project loading - only load when needed
  const tsConfigPath = getArg("--tsconfig") || "tsconfig.json"
  const lazyProject = () => getProject(tsConfigPath)

  switch (command) {
    case "symbol.at": {
      const file = args[1]
      const line = parseInt(args[2], 10)
      const col = parseInt(args[3] || "1", 10)

      if (!file || isNaN(line)) {
        error("Usage: symbol.at <file> <line> [col]")
      }

      const symbol = getSymbolAt(lazyProject(), file, line, col)
      if (!symbol) {
        error(`No symbol found at ${file}:${line}:${col}`)
      }
      output(symbol)
      break
    }

    case "refs.list": {
      const symbolKey = args[1]
      if (!symbolKey) {
        error("Usage: refs.list <symbolKey>")
      }

      const refs = getReferences(lazyProject(), symbolKey)
      output(refs)
      break
    }

    case "symbols.find": {
      const pattern = getArg("--pattern")
      if (!pattern) {
        error("Usage: symbols.find --pattern <regex>")
      }

      const regex = new RegExp(pattern, "i")
      const symbols = findSymbols(lazyProject(), regex)
      output(symbols)
      break
    }

    case "rename.propose": {
      const symbolKey = args[1]
      const newName = args[2]
      const outputFile = getArg("--output") || "editset.json"

      if (!symbolKey || !newName) {
        error("Usage: rename.propose <symbolKey> <newName> [--output file]")
      }

      const editset = createRenameProposal(lazyProject(), symbolKey, newName)
      saveEditset(editset, outputFile)
      output({
        editsetPath: outputFile,
        refCount: editset.refs.length,
        fileCount: new Set(editset.refs.map((r) => r.file)).size,
      })
      break
    }

    case "rename.batch": {
      const pattern = getArg("--pattern")
      const replacement = getArg("--replace")
      const outputFile = getArg("--output") || "editset.json"
      const checkConflictsFlag = hasFlag("--check-conflicts")
      const skipNames = getArg("--skip")?.split(",") || []

      if (!pattern || !replacement) {
        error("Usage: rename.batch --pattern <regex> --replace <string> [--output file] [--check-conflicts] [--skip names]")
      }

      const regex = new RegExp(pattern, "i")

      // Check for conflicts mode
      if (checkConflictsFlag) {
        const report = checkConflicts(lazyProject(), regex, replacement)
        output(report)
        break
      }

      // Normal batch rename (with optional skip)
      const symbols = findSymbols(lazyProject(), regex)
      const skippedCount = skipNames.length > 0 ? symbols.filter((s) => skipNames.includes(s.name)).length : 0
      console.error(`Found ${symbols.length} symbols matching /${pattern}/i`)
      if (skippedCount > 0) {
        console.error(`Skipping ${skippedCount} symbols: ${skipNames.join(", ")}`)
      }

      const editset =
        skipNames.length > 0
          ? createBatchRenameProposalFiltered(lazyProject(), regex, replacement, skipNames)
          : createBatchRenameProposal(lazyProject(), regex, replacement)
      saveEditset(editset, outputFile)

      output({
        editsetPath: outputFile,
        refCount: editset.refs.length,
        fileCount: new Set(editset.refs.map((r) => r.file)).size,
        symbolCount: symbols.length - skippedCount,
        skippedSymbols: skipNames.length > 0 ? skipNames : undefined,
      })
      break
    }

    case "editset.select": {
      const inputFile = args[1]
      const include = getArg("--include")?.split(",")
      const exclude = getArg("--exclude")?.split(",")
      const outputFile = getArg("--output") || inputFile

      if (!inputFile) {
        error("Usage: editset.select <file> [--include refIds] [--exclude refIds] [--output file]")
      }

      const editset = loadEditset(inputFile)
      const filtered = filterEditset(editset, include, exclude)
      saveEditset(filtered, outputFile)

      const selectedCount = filtered.refs.filter((r) => r.selected).length
      output({
        editsetPath: outputFile,
        selectedRefs: selectedCount,
        totalRefs: filtered.refs.length,
      })
      break
    }

    case "editset.apply": {
      const inputFile = args[1]
      const dryRun = hasFlag("--dry-run")

      if (!inputFile) {
        error("Usage: editset.apply <file> [--dry-run]")
      }

      const editset = loadEditset(inputFile)
      const result = applyEditset(editset, dryRun)

      if (dryRun) {
        console.error("[DRY RUN - no changes applied]")
      }

      output(result)
      break
    }

    case "editset.verify": {
      const inputFile = args[1]

      if (!inputFile) {
        error("Usage: editset.verify <file>")
      }

      const editset = loadEditset(inputFile)
      const result = verifyEditset(editset)
      output(result)
      break
    }

    default:
      error(`Unknown command: ${command}`)
  }
}

main().catch((err) => {
  error(err instanceof Error ? err.message : String(err))
})
