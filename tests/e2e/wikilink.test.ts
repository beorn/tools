/**
 * E2E integration test for wikilink backend CLI commands.
 *
 * Tests the complete workflow:
 * 1. wikilink.find - Find all links to a target file
 * 2. wikilink.rename - Create editset for file rename
 * 3. file.apply - Apply the editset
 * 4. wikilink.broken - Detect broken links
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { spawnSync } from "child_process"
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { execSync } from "child_process"

// Helper to run refactor CLI
function runRefactor(args: string[], workDir: string, pluginRoot: string): { stdout: string; stderr: string; exitCode: number } {
  const refactorScript = join(pluginRoot, "tools/refactor.ts")
  const result = spawnSync("bun", [refactorScript, ...args], {
    cwd: workDir,
    encoding: "utf-8",
    env: { ...process.env, FORCE_COLOR: "0" },
  })
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    exitCode: result.status ?? 1,
  }
}

describe("E2E: Wikilink Backend", () => {
  let tempDir: string
  let pluginRoot: string

  beforeAll(() => {
    // Check if ripgrep is installed
    try {
      execSync("which rg", { stdio: "pipe" })
    } catch {
      console.log("Skipping E2E wikilink tests: ripgrep (rg) not installed")
      return
    }

    // Find plugin root (go up from tests/e2e/ to plugin root)
    pluginRoot = join(import.meta.dir, "../..")

    // Create temp directory with test vault
    tempDir = mkdtempSync(join(tmpdir(), "wikilink-e2e-"))

    // Create a sample markdown vault
    writeFileSync(
      join(tempDir, "index.md"),
      `# Index

Welcome to the vault.

See [[project-alpha]] for details.
Also check [[project-alpha#overview]] for the overview.
And [[project-alpha|the alpha project]] is important.
`,
    )

    writeFileSync(
      join(tempDir, "notes.md"),
      `# Notes

Related to [[project-alpha]].
Embed: ![[project-alpha]]
Link: [project alpha](project-alpha.md)
With heading: [overview](project-alpha.md#overview)
`,
    )

    writeFileSync(
      join(tempDir, "project-alpha.md"),
      `# Project Alpha

## Overview

This is the project overview.

## Details

Some details here.
`,
    )

    writeFileSync(
      join(tempDir, "unrelated.md"),
      `# Unrelated

No links to project-alpha here.
`,
    )
  })

  afterAll(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  describe("wikilink.find", () => {
    test("finds all links to target file", () => {
      try {
        execSync("which rg", { stdio: "pipe" })
      } catch {
        return // Skip if rg not installed
      }

      const result = runRefactor(["wikilink.find", "--target", "project-alpha.md"], tempDir, pluginRoot)

      expect(result.exitCode).toBe(0)

      const output = JSON.parse(result.stdout)
      expect(output.target).toBe("project-alpha.md")
      expect(output.count).toBeGreaterThanOrEqual(6) // At least 6 links across index.md and notes.md
      expect(output.links.length).toBe(output.count)

      // Check that links are from the right files
      const files = new Set(output.links.map((link: { file: string }) => link.file))
      expect(files.size).toBeGreaterThanOrEqual(2) // index.md and notes.md
    })

    test("respects glob filter", () => {
      try {
        execSync("which rg", { stdio: "pipe" })
      } catch {
        return
      }

      const result = runRefactor(
        ["wikilink.find", "--target", "project-alpha.md", "--glob", "index.md"],
        tempDir,
        pluginRoot,
      )

      expect(result.exitCode).toBe(0)

      const output = JSON.parse(result.stdout)
      expect(output.count).toBeGreaterThanOrEqual(3) // Links in index.md only

      // All links should be from index.md
      const allFromIndex = output.links.every((link: { file: string }) => link.file.endsWith("index.md"))
      expect(allFromIndex).toBe(true)
    })
  })

  describe("wikilink.rename", () => {
    test("creates valid editset for file rename", () => {
      try {
        execSync("which rg", { stdio: "pipe" })
      } catch {
        return
      }

      const editsetPath = join(tempDir, "rename-editset.json")
      const result = runRefactor(
        ["wikilink.rename", "--old", "project-alpha.md", "--new", "project-beta.md", "--output", editsetPath],
        tempDir,
        pluginRoot,
      )

      expect(result.exitCode).toBe(0)

      const output = JSON.parse(result.stdout)
      expect(output.editsetPath).toBe(editsetPath)
      expect(output.oldPath).toBe("project-alpha.md")
      expect(output.newPath).toBe("project-beta.md")
      expect(output.linkCount).toBeGreaterThanOrEqual(6)
      expect(output.fileCount).toBeGreaterThanOrEqual(2)

      // Verify editset file exists and has correct structure
      expect(existsSync(editsetPath)).toBe(true)

      const editset = JSON.parse(readFileSync(editsetPath, "utf-8"))
      expect(editset.operation).toBe("file-rename")
      expect(editset.fileOps.length).toBe(1)
      expect(editset.fileOps[0].type).toBe("rename")
      expect(editset.fileOps[0].oldPath).toContain("project-alpha.md")
      expect(editset.fileOps[0].newPath).toContain("project-beta.md")
      expect(editset.importEdits.length).toBeGreaterThanOrEqual(6)

      // Check that edits contain the new name
      for (const edit of editset.importEdits) {
        expect(edit.replacement).toContain("project-beta")
      }
    })
  })

  describe("wikilink.broken", () => {
    test("detects broken links", () => {
      try {
        execSync("which rg", { stdio: "pipe" })
      } catch {
        return
      }

      // Create a file with broken links
      writeFileSync(
        join(tempDir, "broken-links.md"),
        `# Broken

Link to [[non-existent-file]].
Another broken: [[missing-note]].
Good link: [[project-alpha]].
`,
      )

      const result = runRefactor(["wikilink.broken"], tempDir, pluginRoot)

      expect(result.exitCode).toBe(0)

      const output = JSON.parse(result.stdout)
      expect(output.count).toBeGreaterThanOrEqual(2) // At least 2 broken links

      // Check that broken links are detected
      const brokenTargets = output.brokenLinks.map((link: { preview: string }) => link.preview)
      expect(brokenTargets.some((p: string) => p.includes("non-existent-file"))).toBe(true)
      expect(brokenTargets.some((p: string) => p.includes("missing-note"))).toBe(true)
    })
  })

  describe("full rename workflow", () => {
    test("end-to-end: find, rename, verify editset", () => {
      try {
        execSync("which rg", { stdio: "pipe" })
      } catch {
        return
      }

      // 1. Find links
      const findResult = runRefactor(["wikilink.find", "--target", "project-alpha.md"], tempDir, pluginRoot)
      expect(findResult.exitCode).toBe(0)
      const findOutput = JSON.parse(findResult.stdout)
      const originalLinkCount = findOutput.count
      expect(originalLinkCount).toBeGreaterThanOrEqual(6)

      // 2. Create rename editset
      const editsetPath = join(tempDir, "full-rename-editset.json")
      const renameResult = runRefactor(
        ["wikilink.rename", "--old", "project-alpha.md", "--new", "project-gamma.md", "--output", editsetPath],
        tempDir,
        pluginRoot,
      )
      expect(renameResult.exitCode).toBe(0)

      // 3. Verify the editset structure
      const editset = JSON.parse(readFileSync(editsetPath, "utf-8"))
      expect(editset.operation).toBe("file-rename")
      expect(editset.fileOps.length).toBe(1)
      expect(editset.fileOps[0].type).toBe("rename")
      expect(editset.importEdits.length).toBe(originalLinkCount)

      // 4. Apply the editset (dry-run to verify it would work)
      const dryRunResult = runRefactor(["file.apply", editsetPath, "--dry-run"], tempDir, pluginRoot)
      expect(dryRunResult.exitCode).toBe(0)
      const dryRunOutput = JSON.parse(dryRunResult.stdout)
      expect(dryRunOutput.dryRun).toBe(true)
      expect(dryRunOutput.applied).toBe(0) // Nothing applied in dry-run

      // Note: We don't apply for real in this test to avoid modifying the shared tempDir
      // which would affect other tests. The dry-run verification is sufficient to show
      // that the editset is valid and would work.
    })
  })

  describe("edge cases", () => {
    test("handles links with special characters", () => {
      try {
        execSync("which rg", { stdio: "pipe" })
      } catch {
        return
      }

      writeFileSync(
        join(tempDir, "special-chars.md"),
        `# Special Characters

Link to [[project-alpha]] (parentheses).
Link to [[project-alpha]] [brackets].
Link to [[project-alpha]] {braces}.
`,
      )

      const result = runRefactor(["wikilink.find", "--target", "project-alpha.md"], tempDir, pluginRoot)
      expect(result.exitCode).toBe(0)

      const output = JSON.parse(result.stdout)
      // Should find links even with special chars around them
      expect(output.count).toBeGreaterThanOrEqual(3)
    })

    test("handles empty vault", () => {
      try {
        execSync("which rg", { stdio: "pipe" })
      } catch {
        return
      }

      const emptyDir = mkdtempSync(join(tmpdir(), "wikilink-empty-"))

      try {
        const result = runRefactor(["wikilink.find", "--target", "nonexistent.md"], emptyDir, pluginRoot)
        expect(result.exitCode).toBe(0)

        const output = JSON.parse(result.stdout)
        expect(output.count).toBe(0)
        expect(output.links.length).toBe(0)
      } finally {
        rmSync(emptyDir, { recursive: true, force: true })
      }
    })
  })
})
