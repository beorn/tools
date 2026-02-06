# beorn-tools

Generic Claude Code tools - reusable across projects.

**All generic Claude tools should live here**, not in project-specific repos.

## Tools

| Tool       | Description                                                   | Entry Point             |
| ---------- | ------------------------------------------------------------- | ----------------------- |
| `refactor` | Batch rename, replace, API migration (run `--help` for guide) | `bun tools/refactor.ts` |
| `llm`      | Multi-LLM research, consensus, deep research                  | `bun tools/llm.ts`      |
| `history`  | Claude Code session search with FTS5                          | `bun tools/history.ts`  |
| `recall`   | Session memory search + LLM synthesis                         | `bun tools/recall.ts`   |
| `tty`      | TTY testing MCP server (ttyd + Playwright)                    | MCP server              |
| `worktree` | Git worktree management with submodules                       | `bun tools/worktree.ts` |

### Refactor Tool Capabilities

- **migrate**: Full terminology migration (files + symbols + text)
- **rename.batch**: TypeScript symbol rename (catches destructuring, re-exports)
- **pattern.replace**: Text search/replace (comments, markdown, strings)
- **pattern.migrate**: LLM-powered API migration (complex pattern transformations)

Run `bun tools/refactor.ts --help` for detailed command reference and examples.

## Skills

See `skills/` for Claude Code skill definitions:

- `batch-refactor/` - Batch refactoring workflow
- `llm/` - Multi-LLM queries
- `tty/` - Terminal app testing

## Usage

Include as git submodule in `vendor/`:

```bash
git submodule add <repo-url> vendor/beorn-tools
```

Run tools:

```bash
bun vendor/beorn-tools/tools/llm.ts ask "question"
bun vendor/beorn-tools/tools/refactor.ts rename.batch --pattern foo --replace bar
```

## Development

```bash
cd vendor/beorn-tools
bun install
bun run typecheck
```
