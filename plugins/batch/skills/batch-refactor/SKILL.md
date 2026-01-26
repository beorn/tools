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
- **Terminology migrations**: vault→repo, old API→new API

**Trigger phrases**:
- "rename X to Y everywhere"
- "change all X to Y"
- "refactor X across the codebase"
- "batch replace"
- "update terminology"
- "migrate from X to Y"
- "rename function/variable everywhere"
- "change wording in all files"

## Workflow

1. **SAFETY CHECK**: Ensure changes can be undone (git status, clean working tree)
2. **GATHER CONTEXT**: Read CLAUDE.md, ADRs, docs to understand the project
3. **SEARCH**: Find all matches using ast-grep (code) or Grep (text)
4. **ANALYZE**: Group matches, identify external references, assess clarity
5. **CLARIFY** (if needed): Ask grouped questions, not item-by-item
6. **APPLY**: Bulk apply with ast-grep -U or Edit replace_all
7. **VERIFY**: Run project's test/lint commands

## Safety Check

**Before making batch changes, ensure they can be undone.**

```bash
# Check if in git repo
git rev-parse --is-inside-work-tree 2>/dev/null

# Check for uncommitted changes
git status --porcelain
```

| Situation | Action |
|-----------|--------|
| Git repo, clean working tree | ✅ Proceed |
| Git repo, uncommitted changes | ⚠️ Ask user to commit first or stash |
| Git worktree | ✅ Proceed (isolated by design) |
| Not a git repo | ⚠️ Warn user: no undo available, confirm before proceeding |

If changes are uncommitted, ask:
```
You have uncommitted changes. Batch operations affect many files.
Options:
1. Commit current changes first (recommended)
2. Proceed anyway (can use git checkout to revert)
3. Cancel
```

## Context Gathering

Before asking any questions, gather project context:

1. **Read CLAUDE.md** - look for:
   - Mentioned migrations or refactoring plans
   - ADR references
   - Terminology notes
   - Deprecated patterns

2. **Check for migration scripts** (optional reference):
   - `scripts/check-migration.ts` or similar
   - These may have ALLOWED_PATTERNS that indicate known exclusions

3. **Read relevant ADRs** if mentioned in CLAUDE.md

## Deciding What to Ask

| Context Clarity | Action |
|-----------------|--------|
| Well-documented migration (ADR, CLAUDE.md) | Apply all, no questions |
| Clear our-concept vs external | Apply ours, skip external, one confirmation |
| Ambiguous/mixed contexts | Group by context type, ask once per group |

**Never ask item-by-item.** If you have 100+ matches:
- Group by context (our code, external refs, URLs, etc.)
- Ask 1-3 grouped questions max
- Default to applying all if context is clear

## Confidence Philosophy

**Be aggressive. Tests catch mistakes.**

Confidence is based on **our concept vs external reference**, not code vs string/comment.

| Context | Example | Confidence |
|---------|---------|------------|
| Our code | `const vaultRoot = ...` | HIGH |
| Our compound identifier | `vaultHelper`, `byVault` | HIGH |
| Our error message | `"vault not found"` | HIGH |
| Our comment | `// handle vault sync` | HIGH |
| Our docs | `# Vault Guide` | HIGH |
| External reference | `"Obsidian vault"` | LOW |
| External docs | `// Obsidian stores data in vaults` | LOW |
| URL/path | `https://vault.example.com` | LOW |

**Default to HIGH** unless the context clearly refers to an external system.

If project has ALLOWED_PATTERNS (e.g., check-migration.ts), trust those exclusions.

## Search Tools

**For code files (.ts, .tsx, .js, .py)** - use ast-grep:
```bash
ast-grep run -p "oldName" -l typescript --json=stream packages/ 2>/dev/null
```

**For text/markdown** - use Grep tool:
```typescript
Grep({ pattern: "oldName", path: "packages/", output_mode: "content", "-C": 3 })
```

## Apply Tools

**For code files** - use ast-grep bulk mode:
```bash
ast-grep run -p "oldName" -r "newName" -l typescript -U packages/
```

**For text/markdown** - use Edit tool with replace_all:
```typescript
Edit({
  file_path: match.file,
  old_string: "oldName",
  new_string: "newName",
  replace_all: true
})
```

## Verify

Run project verification:
```bash
# Bun projects
bun fix && bun run test:fast
```

Report summary:
```
Applied 765 changes across 93 files.
Verification: PASSED (all tests pass)
```

## When to Ask User

Only ask if there's genuine ambiguity:
- **Different concept**: "Obsidian vault" (external system, not our term)
- **URL/path**: `https://vault.example.com` (might be intentional)
- **User explicitly said** to review certain patterns

For terminology migrations, default to **apply all**.

## Supported Operations

| Operation | Tool | File types |
|-----------|------|------------|
| Code refactoring | ast-grep -U | .ts, .tsx, .js, .py |
| Text search-replace | Edit replace_all | .md, .txt, any text |
| Type-safe renames | mcp-refactor-typescript | TypeScript |
| File renaming | Bash mv | Any (future) |

## AST Pattern Syntax (ast-grep)

| Pattern | Matches |
|---------|---------|
| `$VAR` | Single identifier/expression |
| `$$$ARGS` | Multiple nodes (spread) |
| `console.log($MSG)` | Function call with one arg |
| `import { $IMPORTS } from "$MOD"` | Import statement |

## Important

1. **Be aggressive** - apply all matches, let tests catch mistakes
2. **Use bulk mode** - ast-grep -U for code, Edit replace_all for text
3. **Trust the tests** - "No refactoring tool guarantees behavior preservation. Your test suite does."
4. **Check for project scripts** - check-migration.ts tells you exactly what to fix
