# LLM Skill

Multi-LLM research with deep research, second opinions, and multi-model debate.

**Run from your project:**

```bash
bun vendor/beorn-tools/tools/llm.ts "question"
```

## When to Use

- Getting a second opinion from other AI models
- Deep research requiring web search capabilities
- Building consensus across multiple models
- Research tasks needing citations and sources

## Commands

```bash
# Standard question (~$0.02)
bun llm "What is the capital of France?"

# Deep research with web search (~$2-5)
bun llm --deep -y "Best practices for TUI testing in 2026"

# Second opinion from a different provider (~$0.02)
bun llm opinion "Is my caching approach reasonable?"

# Multi-model debate with synthesis (~$1-3)
bun llm debate -y "Monorepo vs polyrepo for our use case?"

# Quick/cheap model (~$0.01)
bun llm quick "What port does postgres use?"
```

## Context Flags

```bash
# Explicit context
bun llm --deep -y --context "relevant code or info" "topic"

# Context from file
bun llm --deep -y --context-file ./src/module.ts "Review this code"

# Include session history
bun llm --deep -y --with-history "topic"
```

## Output

By default, response is written to a file and JSON metadata is printed to stdout:

```json
{"file":"/tmp/llm-abc12345-1738800000000-x1y2.txt","chars":5432,"model":"GPT-5.2","tokens":1234,"cost":"$0.02","durationMs":3200}
```

Read the file with `Read` tool. Stale files (>7 days) are auto-cleaned on next run.

Use `--output -` for classic streaming to stdout (JSON summary goes to stderr).

## Agent Usage: Background & Async Patterns

### Quick queries (~$0.02) — run foreground

Fast enough to run synchronously. Stdout contains JSON with file path:

```bash
bun llm "question"
# stdout = JSON with "file" key — Read the file
```

### Deep research (~$2-5) — run in background, wait with TaskOutput

Deep research takes 2-15 minutes. **Never poll output files manually** (sleep + read loops waste turns). Use the Task tool with `run_in_background=true`, then `TaskOutput` with `block=true`:

```
# Step 1: Launch background task
Task(subagent_type="Bash", run_in_background=true,
     prompt='bun llm --deep -y "topic"')
→ Returns task_id

# Step 2: Do other work while it runs...

# Step 3: Block-wait for completion (up to 10 min)
TaskOutput(task_id=<id>, block=true, timeout=600000)
# stdout contains JSON with file path — Read it
```

**Anti-pattern** — do NOT do this:

```
# BAD: Manual polling wastes 5+ turns on sleep/read cycles
Bash("sleep 30 && wc -l /tmp/output")
Read("/tmp/output")
Bash("sleep 30 && wc -l /tmp/output")  # still not done...
```

### Debate (~$1-3) — run foreground or background

Similar to deep research timing-wise. Use the same `TaskOutput` pattern for background execution.

## Recovery

```bash
bun llm recover              # List incomplete responses
bun llm recover <id>         # Retrieve by ID from OpenAI
bun llm partials --clean     # Clean up old partial files
```

## Environment Variables

```bash
export OPENAI_API_KEY="sk-..."
export ANTHROPIC_API_KEY="sk-ant-..."
export GOOGLE_GENERATIVE_AI_API_KEY="..."
export XAI_API_KEY="..."
export PERPLEXITY_API_KEY="pplx-..."
```

## Trigger Phrases

- "ask another model"
- "get a second opinion"
- "research this topic"
- "what do other models think"
- "deep research"
- "multi-model query"
