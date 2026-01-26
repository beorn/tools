# Batch Refactoring Plugin for Claude Code

Intelligent batch refactoring with confidence-based auto-apply. Claude automatically uses this skill when you ask to rename or refactor across multiple files.

## Installation

```bash
# Add the beorn-claude-tools marketplace (one-time)
claude plugin marketplace add github:beorn/beorn-claude-tools

# Install the plugin
claude plugin install batch@beorn-claude-tools
```

## Usage

Just ask naturally - Claude will use the batch refactoring skill automatically:

```
"rename createVault to createRepo across the codebase"
"change all vault mentions to repo in packages/"
"refactor oldFunction to newFunction everywhere"
"update terminology from X to Y"
```

No slash command needed - the skill triggers on natural language.

## How It Works

1. **SEARCH**: Find all matches using ast-grep (code) or ripgrep (text)
2. **ANALYZE**: Claude reviews each match and scores confidence
3. **AUTO-APPLY**: HIGH confidence changes applied automatically
4. **REVIEW**: MEDIUM confidence matches presented for user approval
5. **SKIP**: LOW confidence matches skipped with explanation
6. **VERIFY**: Run your project's test/lint commands

### Confidence Scoring

| Confidence | Context | Action |
|------------|---------|--------|
| **HIGH** | Function call, import, type reference, variable declaration | Auto-apply |
| **MEDIUM** | String literal, comment, documentation | Ask user |
| **LOW** | Partial match (substring), archive/vendor dirs | Skip |

**Examples:**
- `oldFunc()` call → HIGH (clear code usage)
- `"oldFunc"` in error message → MEDIUM (might be intentional)
- `oldFunc` in `myOldFuncHelper` → LOW (different identifier)

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
- **Comments and documentation** - Full support

## Example Session

```
User: rename vaultRoot to repoRoot in packages/km-storage/

Claude: I'll use batch refactoring to rename vaultRoot to repoRoot.

Found 47 matches across 12 files.

Confidence breakdown:
- HIGH (auto-apply): 38 matches
- MEDIUM (needs review): 7 matches
- LOW (skip): 2 matches

[Applies 38 HIGH confidence changes]
[Asks about 7 MEDIUM confidence changes]

Applied 43 changes (38 auto + 5 user-approved)
Skipped 4 (2 low-confidence + 2 user-rejected)

Running verification: bun fix && bun run test:fast
Verification: PASSED
```

## Plugin Structure

```
batch/
├── .claude-plugin/
│   └── plugin.json
├── skills/
│   └── batch-refactor/
│       └── SKILL.md      # Model-invoked skill
└── README.md
```

This plugin uses a **skill** (model-invoked) rather than a command (user-invoked), so Claude automatically uses it when the task matches.

## License

MIT
