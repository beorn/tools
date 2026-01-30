/**
 * file-ops.test.ts - Tests for batch file rename operations
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, afterEach, spyOn } from "bun:test"
import fs from "fs"
import path from "path"

// Silence console.error from library logging (tests use spies when they need output)
let errorSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  errorSpy = spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  errorSpy.mockRestore()
})
import {
  applyReplacement,
  findFilesToRename,
  checkFileConflicts,
  createFileRenameProposal,
  verifyFileEditset,
  applyFileRenames,
} from "../../tools/lib/core/file-ops"

// Test fixture directory
const FIXTURE_DIR = path.join(import.meta.dir, "../fixtures/file-ops-test")

function setupFixtures() {
  // Clean up and recreate fixture directory
  if (fs.existsSync(FIXTURE_DIR)) {
    fs.rmSync(FIXTURE_DIR, { recursive: true })
  }
  fs.mkdirSync(FIXTURE_DIR, { recursive: true })

  // Create test files
  fs.writeFileSync(path.join(FIXTURE_DIR, "widget.ts"), 'export const widget = "test"')
  fs.writeFileSync(path.join(FIXTURE_DIR, "widget-loader.ts"), 'import { widget } from "./widget"')
  fs.writeFileSync(path.join(FIXTURE_DIR, "WidgetConfig.ts"), "export interface WidgetConfig {}")
  fs.mkdirSync(path.join(FIXTURE_DIR, "testing"), { recursive: true })
  fs.writeFileSync(path.join(FIXTURE_DIR, "testing/fake-widget.ts"), "export class FakeWidget {}")

  // Create a file that would conflict (gadget.ts already exists)
  fs.writeFileSync(path.join(FIXTURE_DIR, "gadget.ts"), 'export const gadget = "existing"')
}

function cleanupFixtures() {
  if (fs.existsSync(FIXTURE_DIR)) {
    fs.rmSync(FIXTURE_DIR, { recursive: true })
  }
}

// Pure function tests - no fixtures needed
describe("applyReplacement", () => {
  test("replaces lowercase", () => {
    expect(applyReplacement("widget-loader.ts", "widget", "gadget")).toBe("gadget-loader.ts")
  })

  test("preserves PascalCase", () => {
    expect(applyReplacement("WidgetConfig.ts", "widget", "gadget")).toBe("GadgetConfig.ts")
  })

  test("preserves UPPERCASE", () => {
    expect(applyReplacement("WIDGET_ROOT.ts", "widget", "gadget")).toBe("GADGET_ROOT.ts")
  })

  test("handles multiple occurrences", () => {
    expect(applyReplacement("widget-widget.ts", "widget", "gadget")).toBe("gadget-gadget.ts")
  })

  test("handles mixed case in same file", () => {
    expect(applyReplacement("WidgetLoader-widget.ts", "widget", "gadget")).toBe("GadgetLoader-gadget.ts")
  })
})

// Read-only tests share fixtures (setup once)
describe("read-only file operations", () => {
  beforeAll(setupFixtures)
  afterAll(cleanupFixtures)

  describe("findFilesToRename", () => {
    test("finds files matching pattern", async () => {
      const ops = await findFilesToRename("widget", "gadget", "**/*.ts", FIXTURE_DIR)

      expect(ops.length).toBe(4)
      const paths = ops.map((op) => op.oldPath)
      expect(paths).toContain("widget.ts")
      expect(paths).toContain("widget-loader.ts")
      expect(paths).toContain("WidgetConfig.ts")
      expect(paths).toContain("testing/fake-widget.ts")
    })

    test("computes correct new paths", async () => {
      const ops = await findFilesToRename("widget", "gadget", "**/*.ts", FIXTURE_DIR)

      const widgetOp = ops.find((op) => op.oldPath === "widget.ts")
      expect(widgetOp?.newPath).toBe("gadget.ts")

      const loaderOp = ops.find((op) => op.oldPath === "widget-loader.ts")
      expect(loaderOp?.newPath).toBe("gadget-loader.ts")

      const configOp = ops.find((op) => op.oldPath === "WidgetConfig.ts")
      expect(configOp?.newPath).toBe("GadgetConfig.ts")
    })

    test("respects glob filter", async () => {
      const ops = await findFilesToRename("widget", "gadget", "*.ts", FIXTURE_DIR)

      // Should only find files in root, not in subdirectories
      expect(ops.length).toBe(3)
      const paths = ops.map((op) => op.oldPath)
      expect(paths).not.toContain("testing/fake-widget.ts")
    })
  })

  describe("checkFileConflicts", () => {
    test("detects target exists conflict", async () => {
      const ops = await findFilesToRename("widget", "gadget", "**/*.ts", FIXTURE_DIR)
      const report = checkFileConflicts(ops, FIXTURE_DIR)

      // widget.ts -> gadget.ts should conflict because gadget.ts exists
      expect(report.conflicts.length).toBeGreaterThan(0)
      const widgetConflict = report.conflicts.find((c) => c.oldPath === "widget.ts")
      expect(widgetConflict).toBeDefined()
      expect(widgetConflict?.reason).toBe("target_exists")
    })

    test("identifies safe renames", async () => {
      const ops = await findFilesToRename("widget", "gadget", "**/*.ts", FIXTURE_DIR)
      const report = checkFileConflicts(ops, FIXTURE_DIR)

      // widget-loader.ts -> gadget-loader.ts should be safe
      const loaderOp = report.safe.find((op) => op.oldPath === "widget-loader.ts")
      expect(loaderOp).toBeDefined()
    })
  })

  describe("createFileRenameProposal", () => {
    test("creates editset with file ops", async () => {
      const editset = await createFileRenameProposal("widget", "gadget", "**/*.ts", FIXTURE_DIR)

      expect(editset.operation).toBe("file-rename")
      expect(editset.pattern).toBe("widget")
      expect(editset.replacement).toBe("gadget")
      // Should exclude conflicting widget.ts -> gadget.ts
      expect(editset.fileOps.length).toBe(3)
    })

    test("includes checksums", async () => {
      const editset = await createFileRenameProposal("widget", "gadget", "**/*.ts", FIXTURE_DIR)

      for (const op of editset.fileOps) {
        expect(op.checksum).toBeDefined()
        expect(op.checksum.length).toBe(16) // SHA256 truncated to 16 chars
      }
    })
  })

  describe("verifyFileEditset", () => {
    test("valid when files unchanged", async () => {
      const editset = await createFileRenameProposal("widget", "gadget", "**/*.ts", FIXTURE_DIR)
      const result = verifyFileEditset(editset, FIXTURE_DIR)

      expect(result.valid).toBe(true)
      expect(result.drifted.length).toBe(0)
    })
  })
})

// Destructive tests need fresh fixtures each time
describe("verifyFileEditset mutations", () => {
  beforeEach(setupFixtures)
  afterEach(cleanupFixtures)

  test("detects file changes", async () => {
    const editset = await createFileRenameProposal("widget", "gadget", "**/*.ts", FIXTURE_DIR)

    // Modify a file after creating the editset
    fs.writeFileSync(path.join(FIXTURE_DIR, "widget-loader.ts"), "// modified content")

    const result = verifyFileEditset(editset, FIXTURE_DIR)
    expect(result.valid).toBe(false)
    expect(result.drifted.some((d) => d.includes("widget-loader.ts"))).toBe(true)
  })
})

describe("applyFileRenames", () => {
  beforeEach(setupFixtures)
  afterEach(cleanupFixtures)

  test("dry run does not rename files", async () => {
    // Spy on console.log since dry run logs what it would do
    const logSpy = spyOn(console, "log").mockImplementation(() => {})

    const editset = await createFileRenameProposal("widget", "gadget", "**/*.ts", FIXTURE_DIR)
    const result = applyFileRenames(editset, true, FIXTURE_DIR)

    expect(result.applied).toBe(3)
    expect(result.skipped).toBe(0)
    expect(logSpy).toHaveBeenCalled()

    // Files should still have old names
    expect(fs.existsSync(path.join(FIXTURE_DIR, "widget-loader.ts"))).toBe(true)
    expect(fs.existsSync(path.join(FIXTURE_DIR, "gadget-loader.ts"))).toBe(false)

    logSpy.mockRestore()
  })

  test("applies renames", async () => {
    const editset = await createFileRenameProposal("widget", "gadget", "**/*.ts", FIXTURE_DIR)
    const result = applyFileRenames(editset, false, FIXTURE_DIR)

    expect(result.applied).toBe(3)
    expect(result.errors.length).toBe(0)

    // Files should have new names
    expect(fs.existsSync(path.join(FIXTURE_DIR, "widget-loader.ts"))).toBe(false)
    expect(fs.existsSync(path.join(FIXTURE_DIR, "gadget-loader.ts"))).toBe(true)
    expect(fs.existsSync(path.join(FIXTURE_DIR, "GadgetConfig.ts"))).toBe(true)
    expect(fs.existsSync(path.join(FIXTURE_DIR, "testing/fake-gadget.ts"))).toBe(true)
  })

  test("skips drifted files", async () => {
    const editset = await createFileRenameProposal("widget", "gadget", "**/*.ts", FIXTURE_DIR)

    // Modify a file
    fs.writeFileSync(path.join(FIXTURE_DIR, "widget-loader.ts"), "// modified")

    const result = applyFileRenames(editset, false, FIXTURE_DIR)

    expect(result.skipped).toBe(1)
    expect(result.errors.some((e) => e.includes("widget-loader.ts"))).toBe(true)

    // Modified file should not be renamed
    expect(fs.existsSync(path.join(FIXTURE_DIR, "widget-loader.ts"))).toBe(true)
  })
})
