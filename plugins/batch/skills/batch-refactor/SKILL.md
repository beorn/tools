---
name: batch-refactor
description: Batch operations across files with confidence-based auto-apply. Use for renaming, search-replace, refactoring code, updating text/markdown, and migrating terminology.
allowed-tools: Bash, Read, Edit, Grep, Glob, AskUserQuestion
---

# Batch Operations Skill

Use this skill when the user wants to make changes across multiple files:
- **Code refactoring**: rename functions, variables, types
- **Text/markdown updates**: change terminology, update docs
- **File operations**: batch rename files (future)
- **Terminology migrations**: widget→gadget, old API→new API

**Trigger phrases**:
- "rename X to Y everywhere"
- "change all X to Y"
- "refactor X across the codebase"
- "batch replace"
- "update terminology"
- "migrate from X to Y"
- "rename function/variable everywhere"
- "change wording in all files"

## Tool Selection

| What you're changing | File Type | Tool |
|---------------------|-----------|------|
| TypeScript identifiers | .ts, .tsx, .js, .jsx | `refactor.ts` (editset workflow) |
| Code patterns | Any language | ast-grep |
| String literals | Any | ast-grep or Edit |
| Text/markdown | .md, .txt | Edit with `replace_all` |

**CRITICAL for TypeScript**: Always use ts-morph (via `refactor.ts`) for identifiers. ast-grep misses destructuring patterns.

## Editset Workflow (TypeScript)

The editset workflow provides safe, reviewable batch renames with checksum verification.

### 1. Find Symbols

```bash
cd vendor/beorn-claude-tools/plugins/batch
bun tools/refactor.ts symbols.find --pattern widget
```

Output: JSON array of matching symbols with location and reference count.

### 2. Check for Conflicts

```bash
bun tools/refactor.ts rename.batch --pattern widget --replace gadget --check-conflicts
```

Output: Conflict report showing:
- `conflicts`: Symbols that would clash with existing names
- `safe`: Symbols safe to rename

### 3. Create Editset (Proposal)

```bash
# Skip conflicting symbols
bun tools/refactor.ts rename.batch --pattern widget --replace gadget \
  --skip createWidget,Widget \
  --output editset.json
```

Output: JSON editset file with all edits and file checksums.

### 4. Preview Changes

```bash
bun tools/refactor.ts editset.apply editset.json --dry-run
```

### 5. Apply Changes

```bash
bun tools/refactor.ts editset.apply editset.json
```

### 6. Verify

```bash
bun tsc --noEmit  # Check types
bun fix           # Fix lint issues
bun run test:fast # Run tests
```

## CLI Reference

| Command | Purpose |
|---------|---------|
| `symbol.at <file> <line> [col]` | Find symbol at location |
| `refs.list <symbolKey>` | List all references to a symbol |
| `symbols.find --pattern <regex>` | Find symbols matching pattern |
| `rename.propose <key> <new>` | Single symbol rename proposal |
| `rename.batch --pattern <p> --replace <r>` | Batch rename proposal |
| `editset.select <file> --include/--exclude` | Filter editset refs |
| `editset.verify <file>` | Check editset can be applied |
| `editset.apply <file> [--dry-run]` | Apply with checksum verification |

## Case Preservation

The tool preserves case during renames:

| Original | Pattern | Replacement | Result |
|----------|---------|-------------|--------|
| `widget` | `widget` | `gadget` | `gadget` |
| `Widget` | `widget` | `gadget` | `Gadget` |
| `WIDGET` | `widget` | `gadget` | `GADGET` |
| `widgetPath` | `widget` | `gadget` | `gadgetPath` |

## Safety Check

**Before making batch changes, ensure they can be undone.**

```bash
git rev-parse --is-inside-work-tree 2>/dev/null
git status --porcelain
```

| Situation | Action |
|-----------|--------|
| Git repo, clean working tree | ✅ Proceed |
| Git repo, uncommitted changes | ⚠️ Ask user to commit first |
| Not a git repo | ⚠️ Warn: no undo available |

## Context Gathering

Before making changes, gather project context:

1. **Read CLAUDE.md** - look for:
   - Mentioned migrations or refactoring plans
   - ADR references
   - Terminology notes

2. **Check for migration scripts** (optional):
   - `scripts/check-migration.ts` or similar
   - May have ALLOWED_PATTERNS for exclusions

## Confidence Philosophy

**Be aggressive. Tests catch mistakes.**

| Context | Confidence |
|---------|------------|
| Our code (`const widgetRoot`) | HIGH |
| Our compound identifier (`widgetHelper`) | HIGH |
| Our error message (`"widget not found"`) | HIGH |
| External reference (`"third-party widget"`) | LOW |
| URL/path (`widget.example.com`) | LOW |

**Default to HIGH** unless clearly external.

## Why ast-grep Fails for TypeScript Identifiers

ast-grep misses TypeScript-specific patterns:

```typescript
// ast-grep renames this ✓
const widgetDir = "/path"

// But MISSES these ✗
interface TestEnv { widgetDir: string }  // property definition
({ widgetDir }) => { ... }               // destructuring
```

**Rule**: If it shows up in "Find All References" in your IDE, use ts-morph.

## Text/Markdown Operations

For non-code files, use Edit with `replace_all`:

```typescript
Edit({
  file_path: "docs/README.md",
  old_string: "widget",
  new_string: "gadget",
  replace_all: true
})
```

## Pattern Operations (ast-grep)

For code patterns (not identifiers):

```bash
# Search
ast-grep run -p "console.log($MSG)" -l typescript --json=stream packages/

# Replace
ast-grep run -p "console.log($MSG)" -r "debug($MSG)" -l typescript -U packages/
```

## Important

1. **Use editset workflow** for TypeScript identifiers
2. **Always run tsc** after batch changes
3. **Check conflicts first** with `--check-conflicts`
4. **Preview with --dry-run** before applying
5. **Trust checksums** - editset won't apply to modified files
6. **Be aggressive** - apply all matches, let tests catch mistakes
