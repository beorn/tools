/**
 * Round-trip test for `bun worktree reset <name>`.
 *
 * Scenario:
 *   1. Build a superproject repo.
 *   2. Create a worktree via createWorktree().
 *   3. Make uncommitted modifications in the worktree.
 *   4. Add a local commit ahead of origin/main in the worktree.
 *   5. Call resetWorktree(name, { force: true }).
 *   6. Verify the worktree dir exists, status is clean, branch tip matches origin/main.
 *
 * Marked .slow because it shells out to git and does real filesystem work.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest"
import { $ } from "bun"
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

import { createWorktree, removeWorktree, resetWorktree } from "../tools/worktree.ts"

let sandbox: string
let consoleLogSpy: ReturnType<typeof vi.spyOn>
let consoleErrorSpy: ReturnType<typeof vi.spyOn>

async function initRepo(path: string): Promise<void> {
  mkdirSync(path, { recursive: true })
  await $`cd ${path} && git init -q -b main && git config user.email t@t && git config user.name t`.quiet()
}

async function commitAll(path: string, message: string): Promise<void> {
  await $`cd ${path} && git add -A && git commit -qm ${message}`.quiet()
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "wt-reset-"))
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {})
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  consoleLogSpy.mockRestore()
  consoleErrorSpy.mockRestore()
  if (sandbox && existsSync(sandbox)) {
    rmSync(sandbox, { recursive: true, force: true })
  }
})

describe("worktree reset round-trip", () => {
  test("reset --force discards uncommitted + ahead commits, leaves a clean slot at origin/main", async () => {
    const mainRepo = join(sandbox, "main")

    // Build the upstream repo and push origin/main
    await initRepo(mainRepo)
    writeFileSync(join(mainRepo, "README.md"), "main\n")
    await commitAll(mainRepo, "main-init")
    // Set up a fake remote so the worktree can have an origin/main to compare against.
    const upstreamRepo = join(sandbox, "origin.git")
    await $`git init --bare -q -b main ${upstreamRepo}`.quiet()
    await $`cd ${mainRepo} && git remote add origin ${upstreamRepo} && git push -q origin main`.quiet()

    const worktreeName = "wt-test"
    const worktreePath = join(sandbox, "main-wt-test")
    const origCwd = process.cwd()
    try {
      process.chdir(mainRepo)

      // Create the worktree
      await createWorktree(worktreeName, undefined, { install: false, direnv: false, hooks: false })
      expect(existsSync(worktreePath)).toBe(true)

      // Pollute the worktree: uncommitted file + a local-only commit
      writeFileSync(join(worktreePath, "uncommitted.txt"), "dirt\n")
      writeFileSync(join(worktreePath, "ahead.txt"), "ahead\n")
      await $`cd ${worktreePath} && git add ahead.txt && git commit -qm "local-only commit"`.quiet()
      writeFileSync(join(worktreePath, "uncommitted.txt"), "dirt-after-commit\n")

      // Sanity-check pollution
      const dirtyBefore = await $`cd ${worktreePath} && git status --short`.text()
      expect(dirtyBefore.length).toBeGreaterThan(0)
      const aheadBefore = parseInt(
        (await $`cd ${worktreePath} && git rev-list --count origin/main..HEAD`.text()).trim(),
        10,
      )
      expect(aheadBefore).toBe(1)

      // Reset
      await resetWorktree(worktreeName, { force: true, install: false, direnv: false, hooks: false })

      // Worktree still exists
      expect(existsSync(worktreePath)).toBe(true)

      // Worktree is clean
      const dirtyAfter = await $`cd ${worktreePath} && git status --short`.text()
      expect(dirtyAfter.trim()).toBe("")

      // Worktree HEAD is at origin/main (zero commits ahead)
      const aheadAfter = parseInt(
        (await $`cd ${worktreePath} && git rev-list --count origin/main..HEAD`.text()).trim(),
        10,
      )
      expect(aheadAfter).toBe(0)

      // Uncommitted file is gone
      expect(existsSync(join(worktreePath, "uncommitted.txt"))).toBe(false)
      // Ahead-commit file is gone
      expect(existsSync(join(worktreePath, "ahead.txt"))).toBe(false)
    } finally {
      process.chdir(origCwd)
    }
  }, 60_000)

  test("reset without --force refuses when worktree has uncommitted changes", async () => {
    const mainRepo = join(sandbox, "main")

    await initRepo(mainRepo)
    writeFileSync(join(mainRepo, "README.md"), "main\n")
    await commitAll(mainRepo, "main-init")
    const upstreamRepo = join(sandbox, "origin.git")
    await $`git init --bare -q -b main ${upstreamRepo}`.quiet()
    await $`cd ${mainRepo} && git remote add origin ${upstreamRepo} && git push -q origin main`.quiet()

    const worktreeName = "wt-refuse"
    const worktreePath = join(sandbox, "main-wt-refuse")
    const origCwd = process.cwd()
    try {
      process.chdir(mainRepo)

      await createWorktree(worktreeName, undefined, { install: false, direnv: false, hooks: false })
      writeFileSync(join(worktreePath, "uncommitted.txt"), "dirt\n")

      // Without --force, should refuse and throw (or exit) — capture by expecting it to throw.
      // Since the tool calls process.exit, we catch the SystemExit via try/catch on a Promise rejection,
      // OR by checking that the file still exists after the call.
      // For testability, resetWorktree should THROW instead of process.exit when refusing.
      await expect(
        resetWorktree(worktreeName, { force: false, install: false, direnv: false, hooks: false }),
      ).rejects.toThrow(/uncommitted|dirty/i)

      // Uncommitted file still there — refusal preserved state
      expect(existsSync(join(worktreePath, "uncommitted.txt"))).toBe(true)
    } finally {
      process.chdir(origCwd)
    }
  }, 30_000)

  test("reset --save-ahead-as <slug> saves ahead commits to wip/<slug> before discarding", async () => {
    const mainRepo = join(sandbox, "main")

    await initRepo(mainRepo)
    writeFileSync(join(mainRepo, "README.md"), "main\n")
    await commitAll(mainRepo, "main-init")
    const upstreamRepo = join(sandbox, "origin.git")
    await $`git init --bare -q -b main ${upstreamRepo}`.quiet()
    await $`cd ${mainRepo} && git remote add origin ${upstreamRepo} && git push -q origin main`.quiet()

    const worktreeName = "wt-save"
    const worktreePath = join(sandbox, "main-wt-save")
    const origCwd = process.cwd()
    try {
      process.chdir(mainRepo)

      await createWorktree(worktreeName, undefined, { install: false, direnv: false, hooks: false })

      // Add 2 ahead commits in the worktree
      writeFileSync(join(worktreePath, "ahead1.txt"), "first\n")
      await $`cd ${worktreePath} && git add ahead1.txt && git commit -qm "ahead-commit-1"`.quiet()
      writeFileSync(join(worktreePath, "ahead2.txt"), "second\n")
      await $`cd ${worktreePath} && git add ahead2.txt && git commit -qm "ahead-commit-2"`.quiet()

      const aheadTipSha = (await $`cd ${worktreePath} && git rev-parse HEAD`.text()).trim()
      expect(aheadTipSha.length).toBe(40)

      // Reset with save-ahead — should preserve the 2 commits on wip/<slug>
      await resetWorktree(worktreeName, {
        force: true,
        saveAheadAs: "demo",
        install: false,
        direnv: false,
        hooks: false,
      })

      // Save branch exists in main repo and points at the pre-reset tip
      const saveBranchSha = (await $`cd ${mainRepo} && git rev-parse refs/heads/wip/demo`.text()).trim()
      expect(saveBranchSha).toBe(aheadTipSha)

      // Save branch contains both ahead commits
      const saveLog = await $`cd ${mainRepo} && git log refs/heads/wip/demo --format='%s' -3`.text()
      expect(saveLog).toContain("ahead-commit-1")
      expect(saveLog).toContain("ahead-commit-2")

      // Worktree is fresh (0 ahead of origin/main, ahead files gone)
      const aheadAfter = parseInt(
        (await $`cd ${worktreePath} && git rev-list --count origin/main..HEAD`.text()).trim(),
        10,
      )
      expect(aheadAfter).toBe(0)
      expect(existsSync(join(worktreePath, "ahead1.txt"))).toBe(false)
      expect(existsSync(join(worktreePath, "ahead2.txt"))).toBe(false)
    } finally {
      process.chdir(origCwd)
    }
  }, 60_000)

  test("reset --save-ahead-as on a clean worktree is a no-op for the save branch", async () => {
    const mainRepo = join(sandbox, "main")

    await initRepo(mainRepo)
    writeFileSync(join(mainRepo, "README.md"), "main\n")
    await commitAll(mainRepo, "main-init")
    const upstreamRepo = join(sandbox, "origin.git")
    await $`git init --bare -q -b main ${upstreamRepo}`.quiet()
    await $`cd ${mainRepo} && git remote add origin ${upstreamRepo} && git push -q origin main`.quiet()

    const worktreeName = "wt-clean-save"
    const origCwd = process.cwd()
    try {
      process.chdir(mainRepo)

      await createWorktree(worktreeName, undefined, { install: false, direnv: false, hooks: false })

      // No ahead commits, no dirt. Reset with --save-ahead-as should NOT create wip/clean.
      await resetWorktree(worktreeName, {
        force: true,
        saveAheadAs: "clean",
        install: false,
        direnv: false,
        hooks: false,
      })

      // Save branch should NOT exist — nothing was ahead, so nothing to save
      const exists = await $`cd ${mainRepo} && git show-ref --verify refs/heads/wip/clean`.nothrow().quiet()
      expect(exists.exitCode).not.toBe(0)
    } finally {
      process.chdir(origCwd)
    }
  }, 30_000)
})
