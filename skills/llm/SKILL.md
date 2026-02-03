# LLM Skill

Multi-LLM research with tiered thinking levels, deep research, and consensus.

**Run from your project:**
```bash
bun vendor/beorn-claude-tools/tools/llm.ts <command>
```

## When to Use

- Getting a second opinion from other AI models
- Deep research requiring web search capabilities
- Comparing perspectives across different models
- Building consensus on technical decisions
- Research tasks needing citations and sources

## Thinking Levels

| Level | Name | What It Does | Est. Cost |
|-------|------|--------------|-----------|
| 1 | quick | Single fast model (GPT-4o-mini, Gemini Flash) | ~$0.01 |
| 2 | standard | Single strong model (GPT-4o, Claude Sonnet) | ~$0.10 |
| 3 | research | Single deep research model (O3 Deep Research, Perplexity Pro) | ~$2-5 |
| 4 | consensus | Multiple models + synthesis | ~$1-3 |
| 5 | deep | All deep research models + consolidation | ~$15-30 |

## Commands

### ask - Standard Query

```bash
# Quick question (level 1)
bun llm.ts ask --quick "What is the capital of France?"

# Standard query (level 2)
bun llm.ts ask "Explain the difference between REST and GraphQL"

# With specific model
bun llm.ts ask --model gpt-4o "What are the pros and cons of TypeScript?"

# JSON output
bun llm.ts ask --json "What is Bun?"
```

### --deep - Deep Research

```bash
# Deep research (level 3)
bun llm.ts --deep "Best practices for TUI testing in 2025"

# With specific model
bun llm.ts --deep --model perplexity-sonar-pro "State of WebAssembly in 2025"
```

### consensus - Multi-Model Agreement

```bash
# Standard consensus (level 4)
bun llm.ts consensus "Should I use Redis or SQLite for local caching?"

# With specific models
bun llm.ts consensus --models gpt-4o,claude-sonnet-4,gemini-2.5-pro "Best state management for React?"

# Without synthesis (just raw responses)
bun llm.ts consensus --no-synthesis "What's the best way to handle errors in Go?"
```

### deep (level 5) - Full Deep Consensus

```bash
# All deep research models + synthesis (level 5)
bun llm.ts --deep "Comprehensive analysis of AI coding assistants in 2025"
```

### models - List Available Models

```bash
# All models
bun llm.ts models

# Only available (with API keys)
bun llm.ts models --available

# By provider
bun llm.ts models --provider openai
```

### compare - Side-by-Side

```bash
# Compare specific models
bun llm.ts compare --models gpt-4o,claude-sonnet-4,gemini-2.5-pro "What is the best JS framework?"
```

## Environment Variables

Set API keys for providers you want to use:

```bash
export OPENAI_API_KEY="sk-..."
export ANTHROPIC_API_KEY="sk-ant-..."
export GOOGLE_GENERATIVE_AI_API_KEY="..."
export XAI_API_KEY="..."
export PERPLEXITY_API_KEY="pplx-..."
```

## Available Models

### OpenAI
- `gpt-4o-mini` - Fast, cheap (level 1)
- `gpt-4o` - Strong general purpose (level 2)
- `gpt-4.5-preview` - Latest preview
- `o3-mini` - Reasoning model
- `o3-deep-research-2025-06-26` - Deep research with web search
- `o4-mini-deep-research-2025-06-26` - Smaller deep research

### Anthropic
- `claude-3-5-haiku-latest` - Fast (level 1)
- `claude-sonnet-4-20250514` - Balanced (level 2)
- `claude-opus-4-20250514` - Most capable

### Google
- `gemini-2.0-flash` - Fast (level 1)
- `gemini-2.5-pro-preview-06-05` - Pro tier
- `gemini-2.5-flash-preview-05-20` - Fast with capabilities

### xAI (Grok)
- `grok-3` - Standard
- `grok-3-fast` - Fast variant

### Perplexity
- `sonar` - Fast search (level 1)
- `sonar-pro` - Pro search with citations
- `sonar-deep-research` - Full deep research

## Output Formats

### Streaming (default)
Tokens stream to stdout as they arrive. Progress info goes to stderr.

### JSON (`--json`)
Full structured response including:
- Model info
- Content
- Usage stats (tokens, cost estimate)
- Duration
- Errors (if any)

## Examples

### Get a second opinion
```bash
# Ask another model about a design decision
bun llm.ts ask "Is it better to use React Context or Zustand for global state?"
```

### Research a topic
```bash
# Deep research with citations
bun llm.ts --deep "How do modern TUI frameworks handle accessibility?"
```

### Build consensus
```bash
# Get multiple perspectives on architecture
bun llm.ts consensus "Monorepo vs polyrepo for a team of 10 developers?"
```

### Compare implementations
```bash
# See how different models approach the same problem
bun llm.ts compare --models gpt-4o,claude-sonnet-4 "Write a function to debounce API calls in TypeScript"
```

## Trigger Phrases

- "ask another model"
- "get a second opinion"
- "research this topic"
- "what do other models think"
- "compare model responses"
- "build consensus on"
- "deep research"
- "multi-model query"
