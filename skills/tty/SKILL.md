# TTY Skill

Interactive terminal app testing - MCP server with ttyd + Playwright.

**Configure in your project's `.mcp.json`:**
```json
{
  "mcpServers": {
    "tty": {
      "command": "bun",
      "args": ["vendor/beorn-claude-tools/tools/playwright-tty-mcp.ts"]
    }
  }
}
```

## When to Use

- Testing TUI applications visually
- Capturing terminal screenshots
- Verifying terminal rendering
- Interactive debugging of terminal apps

## Tools

| Tool | Description |
|------|-------------|
| `mcp__tty__start` | Start ttyd server + connect Playwright browser |
| `mcp__tty__reset` | Restart TTY process, keep browser open (faster than stop+start) |
| `mcp__tty__stop` | Close browser + stop ttyd |
| `mcp__tty__press` | Press keyboard key(s) |
| `mcp__tty__type` | Type text into terminal |
| `mcp__tty__screenshot` | Capture screenshot (returns image or saves to file) |
| `mcp__tty__text` | Get terminal text content |
| `mcp__tty__wait` | Wait for text to appear or DOM stability |
| `mcp__tty__list` | List active sessions |

## Workflow

```
1. mcp__tty__start({ command: ["bun", "km", "view", "/path"] })
   -> { sessionId: "abc123", url: "http://127.0.0.1:7701" }

2. mcp__tty__wait({ sessionId: "abc123", for: "BOARD VIEW" })
   -> { success: true }

3. mcp__tty__press({ sessionId: "abc123", key: "j" })
   -> { success: true }

4. mcp__tty__screenshot({ sessionId: "abc123" })
   -> Returns PNG image

5. mcp__tty__stop({ sessionId: "abc123" })
   -> { success: true }
```

## Key Formats

Use Playwright key formats for `mcp__tty__press`:

| Key | Format |
|-----|--------|
| Enter | `Enter` |
| Escape | `Escape` |
| Arrow keys | `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight` |
| Tab | `Tab` |
| Backspace | `Backspace` |
| Single char | `j`, `k`, `q`, etc. |
| With modifier | `Control+c`, `Control+d`, `Shift+Tab`, `Alt+Enter` |

## Tool Parameters

### start

```typescript
{
  command: string[]              // Required: ["bun", "km", "view", "/path"]
  env?: Record<string, string>   // Optional: { DEBUG: "inkx:*" }
  viewport?: { width, height }   // Optional: { width: 1000, height: 700 }
  waitFor?: "content" | "stable" | string  // Optional: wait condition
}
```

### reset

```typescript
{
  sessionId: string              // Required
  command?: string[]             // Optional: new command
  env?: Record<string, string>   // Optional: new environment
}
```

### screenshot

```typescript
{
  sessionId: string              // Required
  outputPath?: string            // Optional: save to file instead of base64
}
```

### wait

```typescript
{
  sessionId: string              // Required
  for?: string                   // Wait for specific text
  stable?: number                // Wait for DOM stability (ms)
  timeout?: number               // Default: 30000ms
}
```

## Examples

### Basic Screenshot

```
mcp__tty__start({ command: ["bun", "km", "view", "/tmp/test"] })
mcp__tty__wait({ sessionId, for: "Ready" })
mcp__tty__screenshot({ sessionId })
mcp__tty__stop({ sessionId })
```

### Navigation Test

```
mcp__tty__start({ command: ["bun", "km", "view", "/path"] })
mcp__tty__wait({ sessionId, for: "BOARD VIEW" })

# Navigate down
mcp__tty__press({ sessionId, key: "j" })
mcp__tty__press({ sessionId, key: "j" })

# Check result
mcp__tty__text({ sessionId })
# -> { content: "... Item 3 selected ..." }

mcp__tty__stop({ sessionId })
```

### Multiple Sessions

```
# Start two sessions in parallel
mcp__tty__start({ command: ["app1"] })  -> session1
mcp__tty__start({ command: ["app2"] })  -> session2

# Interact with each
mcp__tty__press({ sessionId: session1, key: "q" })
mcp__tty__press({ sessionId: session2, key: "Enter" })

# Clean up
mcp__tty__stop({ sessionId: session1 })
mcp__tty__stop({ sessionId: session2 })
```

### Reset Without Restart

```
# Start session
mcp__tty__start({ command: ["bun", "km", "view", "/path1"] })

# Later, switch to different path (faster than stop+start)
mcp__tty__reset({ sessionId, command: ["bun", "km", "view", "/path2"] })
```

## Generating Playwright Test Files

For repeatable tests, generate a `.playwright-test.ts` file:

```typescript
// example.playwright-test.ts
import { test, expect } from "@playwright/test"
import { createTTY } from "@beorn/claude-tools/playwright-tty"

test("board view renders correctly", async ({ page }) => {
  await using ttyd = createTTY({
    command: ["bun", "km", "view", "/tmp/test"],
  })
  await ttyd.ready

  await page.goto(ttyd.url)
  await page.setViewportSize({ width: 1000, height: 700 })

  // Wait for content
  await expect(page.locator("body")).toContainText("BOARD VIEW")

  // Interact
  await page.keyboard.press("j")
  await page.keyboard.press("j")

  // Verify
  await expect(page.locator("body")).toContainText("Item 3")

  // Screenshot
  await expect(page).toHaveScreenshot("board-after-navigation.png")
})
```

Run with: `bunx playwright test example.playwright-test.ts`

## When to Use MCP vs Test Files

| Scenario | Use MCP | Use Test File |
|----------|---------|---------------|
| Ad-hoc debugging | Yes | |
| Quick screenshot | Yes | |
| Repeatable regression test | | Yes |
| Complex multi-step test | | Yes |
| CI integration | | Yes |

## First-Time Setup

On first `mcp__tty__start`, Chromium is automatically installed to a local cache:
- Location: `vendor/beorn-claude-tools/tools/.playwright-cache/`
- One-time installation, reused for all future sessions

## Trigger Phrases

- "test this terminal app"
- "take a TTY screenshot"
- "interact with the terminal"
- "check if the TUI renders correctly"
- "debug the terminal output"
- "capture what the terminal shows"
