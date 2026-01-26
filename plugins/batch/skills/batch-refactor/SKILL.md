---
name: batch-refactor
description: Batch search and replace across codebase with confidence-based auto-apply. Use when user wants to rename, replace, or refactor terms across multiple files.
allowed-tools: Bash, Read, Edit, Grep, Glob, AskUserQuestion
---

# Batch Refactoring Skill

Use this skill when the user wants to rename, replace, or change terminology across multiple files in the codebase.

**Trigger phrases**: "rename X to Y everywhere", "change all X to Y", "refactor X across the codebase", "batch replace", "update terminology", "rename function/variable everywhere"

## Workflow

1. **SEARCH**: Find all matches using ast-grep (code) or Grep (text)
2. **ANALYZE**: Review each match and score confidence
3. **AUTO-APPLY**: HIGH confidence → apply without asking
4. **REVIEW**: MEDIUM confidence → ask user via AskUserQuestion
5. **SKIP**: LOW confidence → skip with explanation
6. **VERIFY**: Run project's lint/test commands

## Step 1: Search

**For code files (.ts, .tsx, .js, .py)** - use ast-grep:
```bash
ast-grep run -p "oldName" -l typescript --json=stream packages/ 2>/dev/null
```

**For text/markdown or general search** - use Grep tool:
```typescript
Grep({ pattern: "oldName", path: "packages/", output_mode: "content", "-C": 3 })
```

## Step 2: Classify Each Match

| Confidence | Context | Action |
|------------|---------|--------|
| **HIGH** | Function call, import, type reference, variable declaration | Auto-apply |
| **MEDIUM** | String literal, comment, documentation | Ask user |
| **LOW** | Partial match (substring of different word), archive/vendor | Skip |

**Examples:**
- `oldFunc()` call site → HIGH
- `"oldFunc"` in error message → MEDIUM
- `oldFunc` in `myOldFuncHelper` → LOW (different identifier)

## Step 3: Report Summary

```
Found 47 matches across 12 files.

Confidence breakdown:
- HIGH (auto-apply): 38 matches
- MEDIUM (needs review): 7 matches
- LOW (skip): 2 matches
```

## Step 4: Review MEDIUM Matches

Use AskUserQuestion with multiSelect:

```typescript
AskUserQuestion({
  question: "Which of these matches should be renamed?",
  header: "Review",
  options: [
    { label: "src/foo.ts:45", description: "In string: \"oldName not found\"" },
    { label: "src/bar.ts:120", description: "In comment: // oldName handler" },
  ],
  multiSelect: true
})
```

Group by file if more than 4 matches.

## Step 5: Apply Changes

**For HIGH confidence bulk changes** - use ast-grep directly:
```bash
ast-grep run -p "oldName" -r "newName" -l typescript -U packages/
```

**For individual/MEDIUM matches** - use Edit tool:
```typescript
Edit({
  file_path: match.file,
  old_string: matchContext,
  new_string: replacedContext
})
```

## Step 6: Verify

Detect and run project verification:
- **Bun**: `bun fix && bun run test:fast`
- **Node.js**: `npm run lint && npm test`
- **Python**: `ruff check && pytest`

Report final summary:
```
Applied 43 changes (38 auto + 5 user-approved)
Skipped 4 (2 low-confidence + 2 user-rejected)
Verification: PASSED
```

## Tools Reference

| Tool | Best for |
|------|----------|
| **ast-grep** | Code patterns, structural matching |
| **Grep** | Text patterns, markdown, comments |
| **mcp-refactor-typescript** | Type-safe renames with import updates |

## AST Pattern Syntax

| Pattern | Matches |
|---------|---------|
| `$VAR` | Single identifier/expression |
| `$$$ARGS` | Multiple nodes (spread) |
| `console.log($MSG)` | Function call with one arg |
| `import { $IMPORTS } from "$MOD"` | Import statement |

## Important

1. **Always verify** with project's test/lint commands
2. **Check partial matches** - `oldName` might match `myOldNameHelper`
3. **Tests are truth** - "No refactoring tool guarantees behavior preservation. Your test suite does."
