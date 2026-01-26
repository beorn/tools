#!/usr/bin/env bun
/**
 * ts-rename.ts - Type-safe TypeScript symbol renaming using ts-morph
 *
 * Unlike ast-grep, this tool understands TypeScript's type system and will
 * rename ALL references to a symbol, including:
 * - Interface/type property definitions
 * - Destructuring patterns
 * - Type annotations
 * - JSDoc references
 *
 * Usage:
 *   bun run ts-rename.ts <file> <line> <symbol> <newName> [--dry-run]
 *
 * Examples:
 *   # Preview rename of vaultDir property
 *   bun run ts-rename.ts packages/km-storage/src/testing/env.ts 114 vaultDir repoDir --dry-run
 *
 *   # Actually rename
 *   bun run ts-rename.ts packages/km-storage/src/testing/env.ts 114 vaultDir repoDir
 *
 * The file and line specify WHERE to find the symbol definition.
 * ts-morph will find and rename all references across the project.
 */

import { Project, Node, SyntaxKind } from "ts-morph"

function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes("--dry-run")
  const filteredArgs = args.filter((a) => !a.startsWith("--"))

  if (filteredArgs.length < 4) {
    console.error("Usage: ts-rename.ts <file> <line> <symbol> <newName> [--dry-run]")
    console.error("Example: ts-rename.ts src/types.ts 42 oldName newName --dry-run")
    process.exit(1)
  }

  const [filePath, lineStr, symbolName, newName] = filteredArgs
  const line = parseInt(lineStr, 10)

  if (isNaN(line)) {
    console.error("Error: line must be a number")
    process.exit(1)
  }

  // Find tsconfig.json
  const project = new Project({ tsConfigFilePath: "tsconfig.json" })

  const sourceFile = project.getSourceFile(filePath)
  if (!sourceFile) {
    console.error(`Error: Could not find source file: ${filePath}`)
    console.error("Available files:", project.getSourceFiles().length)
    process.exit(1)
  }

  // Find the symbol at the given line
  const lineStart = sourceFile.compilerNode.getPositionOfLineAndCharacter(line - 1, 0)
  const lineEnd = sourceFile.compilerNode.getPositionOfLineAndCharacter(line, 0)

  let targetNode: Node | undefined

  sourceFile.forEachDescendant((node) => {
    const start = node.getStart()
    const end = node.getEnd()

    // Check if node is on the target line
    if (start >= lineStart && end <= lineEnd) {
      // Check if this node's text matches the symbol name
      if (Node.isIdentifier(node) && node.getText() === symbolName) {
        targetNode = node
      }
      // Also check property declarations
      if (Node.isPropertySignature(node) && node.getName() === symbolName) {
        targetNode = node.getNameNode()
      }
      if (Node.isPropertyDeclaration(node) && node.getName() === symbolName) {
        targetNode = node.getNameNode()
      }
    }
  })

  if (!targetNode) {
    console.error(`Error: Could not find symbol '${symbolName}' on line ${line} in ${filePath}`)
    console.error("Tip: Make sure the line number points to the symbol definition")
    process.exit(1)
  }

  console.log(`Found symbol: ${symbolName} at ${filePath}:${line}`)

  // Get references before rename
  const referencesBeforeRename = targetNode.findReferencesAsNodes?.() || []
  console.log(`References found: ${referencesBeforeRename.length}`)

  // Perform the rename
  if (Node.isRenameable(targetNode)) {
    targetNode.rename(newName)
  } else {
    console.error("Error: Node is not renameable")
    process.exit(1)
  }

  // Get modified files
  const modifiedFiles = project.getSourceFiles().filter((sf) => !sf.isSaved())
  console.log(`\nModified files: ${modifiedFiles.length}`)

  modifiedFiles.forEach((sf) => {
    const relativePath = sf.getFilePath().replace(process.cwd() + "/", "")
    console.log(`  - ${relativePath}`)
  })

  if (dryRun) {
    console.log("\n[DRY RUN - no changes saved]")
    console.log("Run without --dry-run to apply changes")
  } else {
    project.saveSync()
    console.log("\n✓ Changes saved!")
  }
}

main()
