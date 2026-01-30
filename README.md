# Batch Plugin for Claude Code

Batch operations across files. Claude automatically uses this skill when you ask to rename, refactor, or migrate terminology.

## Note: Flat Structure Required

Claude Code's plugin skill discovery ignores the `source.path` field in marketplace.json when looking for skills. Skills must be at the repo root, not in a subdirectory. This prevents true monorepo plugin structures.

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
# Install the plugin directly from GitHub
claude plugin install github:beorn/claude-tools
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

## CLI Reference

```bash
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

---

## Plugin Structure

```
claude-tools/
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
