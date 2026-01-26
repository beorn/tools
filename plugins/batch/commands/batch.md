---
description: Batch search, select, and transform code. Use for mass refactoring with interactive selection.
argument-hint: [rename|search|apply] <pattern> [replacement] [--glob <glob>] [--mode text|ast]
allowed-tools: Bash, Read, Edit, Grep, Glob, AskUserQuestion
---

# /batch - Batch Code Transformation

Intelligent batch refactoring with confidence-based auto-apply. Claude reviews all matches, auto-applies high-confidence changes, and asks about uncertain ones.

**Keywords**: batch rename, mass refactor, find and replace, bulk edit, rename across files, search and replace, codemod, ast-grep

## Main Command: `/batch rename`

```
/batch rename "oldName" "newName" --glob "packages/**/*.ts"
```

### Workflow

1. **SEARCH**: Find all matches using ast-grep (code) or Grep (text)
2. **ANALYZE**: Claude reviews each match and scores confidence
3. **AUTO-CATEGORIZE**:
   - HIGH confidence → auto-apply
   - MEDIUM confidence → ask user
   - LOW confidence → skip with explanation
4. **REVIEW**: Present uncertain matches to user via AskUserQuestion
5. **APPLY**: Execute approved changes
6. **VERIFY**: Run project's lint/test commands (e.g., `npm test`, `bun fix`)

### Confidence Scoring

| Confidence | Criteria | Action |
|------------|----------|--------|
| **HIGH** | Exact match in code context (function call, import, type) | Auto-apply |
| **MEDIUM** | Match in string, comment, or ambiguous context | Ask user |
| **LOW** | False positive, different semantic meaning, or risky | Skip |

**Examples:**
- `oldFunc()` call site → HIGH (clear usage)
- `"oldFunc"` in error message → MEDIUM (might be intentional)
- `oldFunc` as part of `myOldFuncHelper` → LOW (partial match, different thing)

## Step-by-Step Instructions

When user invokes `/batch rename "old" "new" --glob "path"`:

### Step 1: Search

**For code files (.ts, .tsx, .js, .py, etc.)** - use ast-grep:
```bash
ast-grep run -p "old" -l typescript --json=stream path/ 2>/dev/null
```

**For text files (.md, .txt, etc.) or with `--mode text`** - use Grep:
```bash
# Use the Grep tool instead of bash grep
Grep({ pattern: "old", path: "path/", output_mode: "content", "-C": 3 })
```

Parse output. Each match needs: `file`, `line`, `column`, `text`, surrounding context.

### Step 2: Analyze Each Match

For each match, read surrounding context (5 lines before/after) and classify:

```typescript
interface Match {
  file: string
  line: number
  column: number
  matchText: string
  context: string
  confidence: 'high' | 'medium' | 'low'
  reason: string
}
```

**Classification rules:**
- **HIGH**: Function/method call, import statement, type reference, variable declaration
- **MEDIUM**: String literal, comment, documentation, test description
- **LOW**: Partial match (substring), different semantic meaning, in archive/vendor

### Step 3: Report Summary

```
Found 47 matches across 12 files.

Confidence breakdown:
- HIGH (auto-apply): 38 matches
- MEDIUM (needs review): 7 matches
- LOW (skip): 2 matches
```

### Step 4: Review MEDIUM Matches

Use AskUserQuestion with multiSelect to present uncertain matches:

```typescript
AskUserQuestion({
  question: "Which of these matches should be renamed?",
  header: "Review",
  options: [
    { label: "src/foo.ts:45", description: "In string: \"oldName not found\"" },
    { label: "src/bar.ts:120", description: "In comment: // oldName handler" },
    // ... (max 4 options per question, batch if more)
  ],
  multiSelect: true
})
```

If more than 4 MEDIUM matches, batch into multiple questions or group by file.

### Step 5: Apply Changes

For each approved match, use Edit tool:

```typescript
Edit({
  file_path: match.file,
  old_string: matchContext,  // Include enough context to be unique
  new_string: replacedContext
})
```

### Step 6: Verify

Ask user what verification command to run, or detect from project:
- **Node.js**: `npm test` or `npm run lint`
- **Bun**: `bun test` or `bun run lint`
- **Python**: `pytest` or `ruff check`

Report final summary:
```
Applied 43 changes (38 auto + 5 user-approved)
Skipped 4 (2 low-confidence + 2 user-rejected)
Verification: [PASSED/FAILED]
```

## Other Commands

### `/batch search <pattern>` - Preview Only

Just search and show matches without making changes:

```bash
# AST-aware search
ast-grep run -p "pattern" -l typescript -C 3 packages/

# Text search (use Grep tool)
Grep({ pattern: "pattern", path: "packages/", output_mode: "content", "-C": 3 })
```

### `/batch apply --all` - Force Apply All

Skip confidence analysis and apply all matches (use with caution):

```bash
ast-grep run -p "old" -r "new" -l typescript -U packages/
```

## Options

| Option | Description |
|--------|-------------|
| `--glob <pattern>` | Limit search to files matching glob |
| `--mode text` | Force text-based search (Grep) even for code files |
| `--mode ast` | Force AST-based search (ast-grep) |

## Tools Available

| Tool | Best for | When to use |
|------|----------|-------------|
| **ast-grep** | Structural patterns | Code refactoring (default for .ts/.js/.py) |
| **Grep** | Text patterns | Markdown, comments, or `--mode text` |
| **mcp-refactor-typescript** | Type-safe renames | When semantic correctness is critical |

## AST Pattern Syntax (ast-grep)

| Pattern | Matches |
|---------|---------|
| `$VAR` | Single node (identifier, expression) |
| `$$$ARGS` | Multiple nodes (spread) |
| `console.log($MSG)` | Function call with one arg |
| `function $NAME($ARGS) { $BODY }` | Function declaration |
| `import { $IMPORTS } from "$MOD"` | Import statement |

## MCP Integration

For semantically-correct renames using TypeScript's language server:

```
Use mcp__refactor-typescript__rename_symbol to rename
"oldFunction" to "newFunction" in src/index.ts
```

**Setup** (if MCP not connected):
```bash
claude mcp add --transport stdio --scope project refactor-typescript -- bunx mcp-refactor-typescript
# Restart Claude Code session
```

## Important Notes

1. **ast-grep's -i flag doesn't work** in Claude Code (requires TTY)
2. **Always verify** with your project's test/lint commands
3. **Commit atomically** - related changes together
4. **Check partial matches** - `oldName` might match `myOldNameHelper`
5. **Tests are truth** - "No refactoring tool guarantees behavior preservation. Your test suite does."
