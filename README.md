# claude-tools

Claude Code plugins that make Claude faster and safer at large-scale code changes.

## Plugins

### [batch](plugins/batch/) — Batch Refactoring

**10-50x faster** than stock Claude for renames and terminology migrations.

| Scenario | Stock Claude | With Batch Plugin |
|----------|--------------|-------------------|
| Rename function (47 refs, 12 files) | ~50 tool calls, 2-3 min | 3 tool calls, <10 sec |
| Terminology migration (200+ refs) | Often gives up or misses refs | Finds all refs, applies atomically |

**Why it's faster:**
- Stock Claude: read file → edit → write → repeat for each reference
- Batch: find all refs in one AST pass → generate editset → apply all at once

**Why it's safer:**
- **Checksums**: Won't apply edits to files that changed since proposal
- **Type-aware**: ts-morph follows TypeScript references, not text matches
- **Conflict detection**: Catches `vault → repo` conflicts before you break the build
- **Dry-run**: Preview all changes before applying

**What it handles:**
- Symbol renames across entire codebase
- Terminology migrations (vault→repo, oldAPI→newAPI)
- Case preservation (vault→repo, Vault→Repo, VAULT→REPO)
- Destructuring patterns, arrow function params, nested scopes

```
"rename createWidget to createGadget everywhere"
```

Claude automatically uses the skill — no slash command needed.

## Installation

```bash
# Add marketplace (one-time)
claude plugin marketplace add github:beorn/claude-tools

# Install plugins
claude plugin install batch@beorn/claude-tools
```

## License

MIT
