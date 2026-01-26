# Batch Plugin for Claude Code

Batch operations across files with confidence-based auto-apply. Claude automatically uses this skill when you ask to rename, replace, refactor, or migrate terminology.

## What it does

- **Code refactoring**: rename functions, variables, types across TypeScript/JavaScript
- **Text/markdown updates**: change terminology, update documentation
- **Terminology migrations**: widget→gadget, old API→new API
- **Pattern matching**: AST-aware search and replace via ast-grep

## Installation

```bash
# Add the claude-tools marketplace (one-time)
claude plugin marketplace add github:beorn/claude-tools

# Install the plugin
claude plugin install batch@@beorn/claude-tools
```

## Usage

Just ask naturally - Claude uses the skill automatically:

```
"rename createWidget to createGadget across the codebase"
"change all widget mentions to gadget in packages/"
"update the terminology from X to Y in the docs"
"refactor oldFunction to newFunction everywhere"
```

No slash command needed - the skill triggers on natural language.

## How It Works

1. **SEARCH**: Find all matches using ts-morph (code) or ripgrep (text)
2. **ANALYZE**: Claude reviews each match and scores confidence
3. **AUTO-APPLY**: HIGH confidence changes applied automatically
4. **REVIEW**: MEDIUM confidence matches presented for user approval
5. **SKIP**: LOW confidence matches skipped with explanation
6. **VERIFY**: Run your project's test/lint commands

### Confidence Scoring

| Confidence | Context | Action |
|------------|---------|--------|
| **HIGH** | Function call, import, type reference, variable declaration | Auto-apply |
| **MEDIUM** | String literal, comment, documentation, markdown | Ask user |
| **LOW** | Partial match (substring), archive/vendor dirs | Skip |

## Requirements

- **Bun** or **Node.js** for running the refactor CLI
- **mcp-refactor-typescript** (optional, provides additional type-safe rename capabilities)

---

## Architecture

### Backend System

The plugin uses a backend abstraction for multi-language support:

```
ts-morph backend   → TypeScript/JavaScript (priority 100)
ast-grep backend   → Pattern-based, any language (priority 10)
```

**Backend selection logic:**
1. User specifies `--backend=ast-grep` → Use that backend
2. File is `.ts/.tsx/.js/.jsx` → Use ts-morph (type-aware)
3. Other file types → Use ast-grep (pattern-based)

### Editset Workflow

For safe, reviewable batch changes:

1. **Propose** → Generate editset with all refs and checksums
2. **Review** → Filter refs with `--include` / `--exclude`
3. **Verify** → Check files haven't drifted (checksums match)
4. **Apply** → Execute byte-offset edits, skip drifted files
5. **Test** → Run `tsc --noEmit && bun test`

---

## CLI Reference

```bash
cd plugins/batch
bun tools/refactor.ts <command> [options]
```

| Command | Purpose | Output |
|---------|---------|--------|
| `symbol.at <file> <line> [col]` | Find symbol at location | `SymbolInfo` |
| `refs.list <symbolKey>` | List all references | `Reference[]` |
| `symbols.find --pattern <regex>` | Find matching symbols | `SymbolMatch[]` |
| `rename.propose <key> <new> [-o]` | Single symbol editset | `ProposeOutput` |
| `rename.batch --pattern --replace [-o]` | Batch rename editset | `ProposeOutput` |
| `editset.select <file> [--include/--exclude] [-o]` | Filter editset | Updated editset |
| `editset.verify <file>` | Check for drift | `{valid, issues[]}` |
| `editset.apply <file> [--dry-run]` | Apply with checksums | `ApplyOutput` |

### Example: Batch Rename

```bash
# 1. Find all widget* symbols
bun tools/refactor.ts symbols.find --pattern widget

# 2. Check for conflicts
bun tools/refactor.ts rename.batch --pattern widget --replace gadget --check-conflicts

# 3. Create editset
bun tools/refactor.ts rename.batch --pattern widget --replace gadget -o editset.json

# 4. Preview changes
bun tools/refactor.ts editset.apply editset.json --dry-run

# 5. Apply
bun tools/refactor.ts editset.apply editset.json

# 6. Verify
bun tsc --noEmit && bun test
```

---

## API Reference

### Core Types

```typescript
interface SymbolInfo {
  symbolKey: string      // "file:line:col:name"
  name: string
  kind: "variable" | "function" | "type" | "interface" | "property" | "class" | "method" | "parameter"
  file: string
  line: number
  column: number
}

interface Reference {
  refId: string          // 8-char hash of location
  file: string
  range: [number, number, number, number]  // [startLine, startCol, endLine, endCol]
  preview: string        // Context line
  checksum: string       // SHA256 of file (first 12 chars)
  selected: boolean      // For filtering
}

interface Editset {
  id: string             // "rename-widget-to-gadget-1706000000"
  operation: "rename"
  from: string
  to: string
  refs: Reference[]
  edits: Edit[]
  createdAt: string      // ISO timestamp
}
```

### Key Functions

| Module | Function | Purpose |
|--------|----------|---------|
| `core/editset` | `filterEditset(editset, include?, exclude?)` | Toggle ref selection |
| `core/apply` | `applyEditset(editset, dryRun?)` | Apply with checksum verification |
| `core/apply` | `verifyEditset(editset)` | Check files exist & checksums match |
| `ts-morph/symbols` | `findSymbols(project, pattern)` | Search AST for matching symbols |
| `ts-morph/edits` | `createBatchRenameProposal(...)` | Generate batch editset |
| `ts-morph/edits` | `detectConflicts(...)` | Find naming conflicts |

---

## Known Limitations

These edge cases were discovered during real-world migrations:

### 1. Local Variables in Functions

`getVariableDeclarations()` only returns top-level declarations. The fix uses `forEachDescendant()` to find all scopes, but complex nested scopes may still have edge cases.

### 2. Destructuring Patterns

Object/array destructuring requires special handling. The pattern `const { foo, bar } = obj` must extract individual identifiers, not the full pattern text.

### 3. Parameter Destructuring

Arrow function parameters like `({ vaultPath }) => ...` use `ParameterDeclaration` nodes, not `VariableDeclaration`. Both must be handled.

### 4. Partial Migration Conflicts

When a codebase is partially migrated (both `widget*` and `gadget*` exist), conflict detection may flag many symbols. Use `--skip` to exclude already-migrated areas, or review conflicts manually.

### Case Preservation

Renames preserve case automatically:
- `widget` → `gadget`
- `Widget` → `Gadget`
- `WIDGET` → `GADGET`
- `widgetPath` → `gadgetPath`

---

## Plugin Structure

```
batch/
├── .claude-plugin/
│   └── plugin.json       # Plugin manifest
├── package.json          # ts-morph, zod dependencies
├── skills/
│   └── batch-refactor/
│       └── SKILL.md      # Model-invoked skill
├── tools/
│   ├── refactor.ts       # CLI entry point
│   └── lib/
│       ├── core/         # Language-agnostic (types, editset, apply)
│       ├── backend.ts    # Backend interface
│       └── backends/     # ts-morph, ast-grep implementations
└── tests/
    └── fixtures/         # Edge case test fixtures
```

This plugin uses a **skill** (model-invoked) rather than a command (user-invoked), so Claude automatically uses it when the task matches.

## License

MIT
