# Batch Plugin for Claude Code

Batch operations across files. Claude automatically uses this skill when you ask to rename, refactor, or migrate terminology.

## Features at a Glance

| Feature | What it does |
|---------|--------------|
| **TypeScript/JS Refactoring** | Rename functions, variables, types, interfaces — catches destructuring, re-exports, type references |
| **File Renames** | Rename files with automatic import path updates |
| **Wiki-link Updates** | Obsidian/Foam/Dendron: update `[[wikilinks]]` when renaming notes |
| **package.json Updates** | Update exports, main, types, bin paths when renaming files |
| **tsconfig.json Updates** | Update paths, references, includes when renaming files |
| **Multi-language Patterns** | Go, Rust, Python, Ruby via ast-grep structural patterns |
| **Text/Markdown Replace** | Fast search/replace across any files via ripgrep |
| **Migrate Command** | Full terminology migration: files → symbols → text in one command |
| **LLM Patch Workflow** | Review editsets with context, selectively modify replacements |
| **Case Preservation** | widget→gadget, Widget→Gadget, WIDGET→GADGET automatically |
| **Conflict Detection** | Check for naming conflicts before applying changes |
| **Checksum Verification** | Never corrupt files — drifted files are skipped |

## What it does

- **File renames**: batch rename files with automatic import path updates
- **TypeScript/JavaScript refactoring**: rename functions, variables, types across your codebase
- **Multi-language structural patterns**: Go, Rust, Python, Ruby, JSON, YAML via ast-grep
- **Batch text/markdown replace**: fast search/replace across any text files via ripgrep
- **Terminology migrations**: widget→gadget, oldAPI→newAPI, vault→repo
- **Case preservation**: automatically handles Widget→Gadget, WIDGET→GADGET
- **LLM-assisted patching**: review editsets with context, skip or customize specific replacements

## Installation

```bash
# Add the claude-tools marketplace (one-time)
claude plugin marketplace add github:beorn/claude-tools

# Install the plugin
claude plugin install batch@beorn/claude-tools
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

1. **FIND**: Discover all symbols matching your pattern using ts-morph AST analysis
2. **CHECK**: Detect naming conflicts before making changes
3. **PROPOSE**: Generate an editset with all changes and file checksums
4. **PREVIEW**: Review changes with `--dry-run` before applying
5. **APPLY**: Execute all edits atomically, skip any drifted files
6. **VERIFY**: Run `tsc --noEmit && bun test` to confirm

## Requirements

- **Bun** or **Node.js** for running the refactor CLI
- **mcp-refactor-typescript** (optional, provides additional type-safe rename capabilities)

---

## Architecture

### Backend System

The plugin uses a prioritized backend system - higher priority backends handle files they specialize in:

| Backend | Priority | Extensions | Use Case |
|---------|----------|------------|----------|
| **ts-morph** | 100 | .ts, .tsx, .js, .jsx | Type-aware symbol renames |
| **ast-grep** | 50 | .go, .rs, .py, .rb, .json, .yaml | Structural pattern matching |
| **tsconfig-json** | 46 | tsconfig*.json | TSConfig paths, references |
| **package-json** | 45 | package.json | Exports, main, types paths |
| **wikilink** | 40 | .md, .markdown, .mdx | Wiki link updates (Obsidian, Foam, etc.) |
| **ripgrep** | 10 | * (any file) | Fast text search/replace |

```typescript
// Auto-detection: patterns with $METAVAR use ast-grep, text patterns use ripgrep
pattern.replace --pattern "fmt.Println($MSG)" --replace "log.Info($MSG)"  // → ast-grep
pattern.replace --pattern "widget" --replace "gadget" --glob "*.md"        // → ripgrep
```

**Dependencies:**
- ts-morph: bundled (no external CLI needed)
- ast-grep: requires `sg` CLI (`brew install ast-grep` or `cargo install ast-grep`)
- ripgrep: requires `rg` CLI (usually pre-installed, or `brew install ripgrep`)

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

### File Operations

Automatically updates references based on file type:
- **TypeScript/JS files** → updates import paths
- **Markdown files** → updates `[[wikilinks]]` (Obsidian, Foam, etc.)
- **package.json** → updates exports, main, types, bin paths
- **tsconfig.json** → updates paths mappings, includes, references

| Command | Purpose | Output |
|---------|---------|--------|
| `file.find --pattern <p> --replace <r> [--glob]` | Find files to rename | `{files[], count}` |
| `file.rename --pattern <p> --replace <r> [--glob] [-o] [--check-conflicts]` | Create file rename editset | `FileEditset` |
| `file.verify <file>` | Check files haven't drifted | `{valid, drifted[]}` |
| `file.apply <file> [--dry-run]` | Apply file renames | `{applied, skipped, errors[]}` |

### TypeScript/JavaScript Commands (ts-morph)

| Command | Purpose | Output |
|---------|---------|--------|
| `symbol.at <file> <line> [col]` | Find symbol at location | `SymbolInfo` |
| `refs.list <symbolKey>` | List all references | `Reference[]` |
| `symbols.find --pattern <regex>` | Find matching symbols | `SymbolMatch[]` |
| `rename.propose <key> <new> [-o]` | Single symbol editset | `ProposeOutput` |
| `rename.batch --pattern --replace [-o] [--check-conflicts]` | Batch rename editset | `ProposeOutput` |

### Multi-Language Commands (ast-grep/ripgrep)

| Command | Purpose | Output |
|---------|---------|--------|
| `pattern.find --pattern <p> [--glob] [--backend]` | Find structural patterns | `Reference[]` |
| `pattern.replace --pattern <p> --replace <r> [--glob] [--backend] [-o]` | Create pattern replace editset | `ProposeOutput` |
| `backends.list` | List available backends | `Backend[]` |

### Wiki-Link Commands (Obsidian, Foam, Dendron, etc.)

| Command | Purpose | Output |
|---------|---------|--------|
| `wikilink.find --target <file> [--glob]` | Find all links to a file | `{links[], count}` |
| `wikilink.rename --old <path> --new <path> [-o]` | Update links when renaming | `FileEditset` |
| `wikilink.broken [--glob]` | Find broken links | `{brokenLinks[], count}` |

### Package.json Commands

| Command | Purpose | Output |
|---------|---------|--------|
| `package.find --target <file> [--glob]` | Find package.json refs to a file | `{refs[], count}` |
| `package.rename --old <path> --new <path> [-o]` | Update paths when renaming | `Editset` |
| `package.broken` | Find broken path references | `{brokenPaths[], count}` |

### TSConfig.json Commands

| Command | Purpose | Output |
|---------|---------|--------|
| `tsconfig.find --target <file> [--glob]` | Find tsconfig refs to a file | `{refs[], count}` |
| `tsconfig.rename --old <path> --new <path> [-o]` | Update paths when renaming | `Editset` |

### Editset Commands

| Command | Purpose | Output |
|---------|---------|--------|
| `editset.select <file> [--include/--exclude] [-o]` | Filter editset | Updated editset |
| `editset.patch <file> [-o]` | Apply LLM patch from stdin | Updated editset |
| `editset.verify <file>` | Check for drift | `{valid, issues[]}` |
| `editset.apply <file> [--dry-run]` | Apply with checksums | `ApplyOutput` |

### Migration Commands

| Command | Purpose | Output |
|---------|---------|--------|
| `migrate --from <p> --to <r> [--glob] [--dry-run] [-o dir]` | Full terminology migration | Phases summary |

### Example: Batch File Rename

```bash
# 1. Find files matching pattern
bun tools/refactor.ts file.find --pattern repo --replace repo --glob "**/*.ts"

# 2. Check for conflicts
bun tools/refactor.ts file.rename --pattern repo --replace repo --glob "**/*.ts" --check-conflicts

# 3. Create editset
bun tools/refactor.ts file.rename --pattern repo --replace repo --glob "**/*.ts" -o file-editset.json

# 4. Preview changes
bun tools/refactor.ts file.apply file-editset.json --dry-run

# 5. Apply
bun tools/refactor.ts file.apply file-editset.json
```

### Example: TypeScript Batch Rename

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

### Example: Go Function Migration (ast-grep)

```bash
# Find all fmt.Println calls
bun tools/refactor.ts pattern.find --pattern 'fmt.Println($MSG)' --glob '**/*.go'

# Create editset to replace with log.Info
bun tools/refactor.ts pattern.replace \
  --pattern 'fmt.Println($MSG)' \
  --replace 'log.Info($MSG)' \
  --glob '**/*.go' \
  -o editset.json

# Preview and apply
bun tools/refactor.ts editset.apply editset.json --dry-run
bun tools/refactor.ts editset.apply editset.json
```

### Example: Markdown Text Replace (ripgrep)

```bash
# Find all mentions of "widget" in docs
bun tools/refactor.ts pattern.find --pattern widget --glob '**/*.md'

# Create editset to replace with "gadget"
bun tools/refactor.ts pattern.replace \
  --pattern widget \
  --replace gadget \
  --glob '**/*.md' \
  --backend ripgrep \
  -o editset.json

# Preview and apply
bun tools/refactor.ts editset.apply editset.json --dry-run
bun tools/refactor.ts editset.apply editset.json
```

### Example: Full Terminology Migration

```bash
# Preview all changes (dry run)
bun tools/refactor.ts migrate --from repo --to repo --dry-run

# Apply all changes: files → symbols → text
bun tools/refactor.ts migrate --from repo --to repo

# Outputs editsets to .editsets/ directory:
#   .editsets/01-file-renames.json
#   .editsets/02-symbol-renames.json
#   .editsets/03-text-patterns.json
```

### Example: LLM Patch Workflow

```bash
# 1. Generate editset with context
bun tools/refactor.ts rename.batch --pattern repo --replace repo -o editset.json

# 2. LLM reviews and patches (via heredoc)
bun tools/refactor.ts editset.patch editset.json <<'EOF'
{
  "b2c3": "Repository",
  "c3d4": null
}
EOF
# null = skip this ref, string = use custom replacement

# 3. Apply
bun tools/refactor.ts editset.apply editset.json
```

### Example: Wiki File Rename (Obsidian/Foam)

```bash
# Find all links pointing to "old-note.md"
bun tools/refactor.ts wikilink.find --target old-note.md

# Rename file and update all [[old-note]] links to [[new-note]]
bun tools/refactor.ts wikilink.rename --old old-note.md --new new-note.md -o wikilink-editset.json

# Preview and apply
bun tools/refactor.ts file.apply wikilink-editset.json --dry-run
bun tools/refactor.ts file.apply wikilink-editset.json

# Find broken links (links to non-existent files)
bun tools/refactor.ts wikilink.broken
```

**Supported link formats:**
- `[[note]]` - basic wikilink
- `[[note|alias]]` - with display text
- `[[note#heading]]` - with heading reference
- `![[embed]]` - embeds (Obsidian)
- `[text](path.md)` - standard markdown

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
  // Enriched fields for LLM review
  line?: number          // 1-indexed line number
  kind?: "call" | "decl" | "type" | "string" | "comment"  // Semantic kind
  scope?: string | null  // Enclosing function/class or null
  ctx?: string[]         // Context lines with ► marker
  replace?: string | null // null = skip, string = replacement
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

Arrow function parameters like `({ widgetPath }) => ...` use `ParameterDeclaration` nodes, not `VariableDeclaration`. Both must be handled.

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
