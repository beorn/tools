# Batch Refactoring Plugin for Claude Code

Intelligent batch refactoring with confidence-based auto-apply. Claude reviews all matches, auto-applies high-confidence changes, and asks about uncertain ones.

## Installation

```bash
# Add the beorn-claude-tools marketplace (one-time)
claude plugin marketplace add github:beorn/beorn-claude-tools

# Install the plugin
claude plugin install batch@beorn-claude-tools
```

## Usage

```bash
/batch rename "oldName" "newName" --glob "packages/**/*.ts"
```

### Workflow

1. **SEARCH**: Find all matches using ast-grep (code) or ripgrep (text)
2. **ANALYZE**: Claude reviews each match and scores confidence
3. **AUTO-CATEGORIZE**:
   - HIGH confidence → auto-apply
   - MEDIUM confidence → ask user
   - LOW confidence → skip with explanation
4. **REVIEW**: Present uncertain matches via AskUserQuestion
5. **APPLY**: Execute approved changes
6. **VERIFY**: Run your project's test/lint commands

### Confidence Scoring

| Confidence | Criteria | Action |
|------------|----------|--------|
| **HIGH** | Exact match in code context (function call, import, type) | Auto-apply |
| **MEDIUM** | Match in string, comment, or ambiguous context | Ask user |
| **LOW** | False positive, different semantic meaning, or risky | Skip |

## Commands

| Command | Description |
|---------|-------------|
| `/batch rename "old" "new" [--glob <pattern>]` | Rename with confidence-based apply |
| `/batch search "pattern" [--glob <pattern>]` | Preview matches without changes |
| `/batch apply --all` | Force apply all matches (use with caution) |

## Options

| Option | Description |
|--------|-------------|
| `--glob <pattern>` | Limit search to files matching glob (e.g., `"src/**/*.ts"`) |
| `--mode text\|ast` | Force text-based (ripgrep) or AST-based (ast-grep) search |

## Requirements

- **ast-grep** (for AST-aware code refactoring):
  ```bash
  # macOS/Linux with Nix
  nix profile install nixpkgs#ast-grep

  # Or via npm
  npm install -g @ast-grep/cli
  ```

- **mcp-refactor-typescript** (optional, bundled via MCP for type-safe renames)

## Scope

Works on **all text files**:
- **Code** (`.ts`, `.tsx`, `.js`, `.py`, etc.) - AST-aware with ast-grep
- **Markdown** (`.md`) - Text-based with ripgrep
- **Comments and notes** - Full support

## Examples

### Rename a function across TypeScript files
```bash
/batch rename "createVault" "createRepo" --glob "packages/**/*.ts"
```

### Search without applying changes
```bash
/batch search "TODO:" --glob "src/**/*"
```

### Force text-based search for code files
```bash
/batch rename "oldName" "newName" --glob "*.ts" --mode text
```

## How It Works

1. **Search Phase**: Uses ast-grep for structural code patterns or ripgrep for text
2. **Analysis Phase**: Claude examines each match with surrounding context
3. **Categorization**: Matches are scored HIGH/MEDIUM/LOW based on semantic certainty
4. **Review Phase**: MEDIUM matches presented to user for approval
5. **Apply Phase**: Approved changes applied via Edit tool
6. **Verify Phase**: User runs their project's tests to confirm correctness

## License

MIT
