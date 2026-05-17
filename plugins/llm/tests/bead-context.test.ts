import { describe, expect, test } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildBeadContext, type CommandResult } from "../src/lib/bead-context"

describe("buildBeadContext", () => {
  test("includes bead body, linked test output, cited code, and blame", async () => {
    const root = mkdtempSync(join(tmpdir(), "bearly-llm-bead-context-"))
    try {
      mkdirSync(join(root, "@km", "all"), { recursive: true })
      mkdirSync(join(root, "src"), { recursive: true })
      mkdirSync(join(root, "tests"), { recursive: true })

      const beadPath = join(root, "@km", "all", "demo.md")
      writeFileSync(
        beadPath,
        ["# [ ] Demo bead", "", "Phase 0 RED: `tests/demo.test.ts`.", "Current code claim: `src/demo.ts:2`."].join(
          "\n",
        ),
      )
      writeFileSync(join(root, "src", "demo.ts"), ["export const a = 1", "export const b = 2", ""].join("\n"))
      writeFileSync(join(root, "tests", "demo.test.ts"), "throw new Error('red')\n")

      const commands: string[][] = []
      const context = await buildBeadContext(beadPath, {
        cwd: root,
        runCommand: async (cmd): Promise<CommandResult> => {
          commands.push(cmd)
          if (cmd[0] === "bun") return { exitCode: 1, stdout: "RED frame col 1", stderr: "expected col 50" }
          if (cmd[0] === "git")
            return { exitCode: 0, stdout: "abc123 (agent 2026-05-12 12:00:00 +0000 2) export const b = 2", stderr: "" }
          return { exitCode: 0, stdout: "", stderr: "" }
        },
      })

      expect(context).toContain("# /pro --bead context")
      expect(context).toContain("# [ ] Demo bead")
      expect(context).toContain("tests/demo.test.ts")
      expect(context).toContain("RED frame col 1")
      expect(context).toContain("expected col 50")
      expect(context).toContain("src/demo.ts:2")
      expect(context).toContain("2: export const b = 2")
      expect(context).toContain("abc123")
      expect(commands).toContainEqual(["bun", "vitest", "run", "tests/demo.test.ts"])
      expect(commands).toContainEqual(["git", "blame", "-L", "2,2", "--", "src/demo.ts"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
