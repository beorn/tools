import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import {
  filterEditset,
  saveEditset,
  loadEditset,
} from "../../tools/lib/core/editset"
import type { Editset } from "../../tools/lib/core/types"

function createMockEditset(): Editset {
  return {
    id: "test-editset",
    operation: "rename",
    from: "repo",
    to: "repo",
    refs: [
      {
        refId: "R1",
        file: "src/a.ts",
        range: [1, 1, 1, 5],
        preview: "const repo = 1",
        checksum: "checksum-a",
        selected: true,
      },
      {
        refId: "R2",
        file: "src/b.ts",
        range: [2, 1, 2, 5],
        preview: "const repo = 2",
        checksum: "checksum-b",
        selected: true,
      },
      {
        refId: "R3",
        file: "src/a.ts",
        range: [3, 1, 3, 5],
        preview: "const repo = 3",
        checksum: "checksum-a",
        selected: true,
      },
    ],
    edits: [
      { file: "src/a.ts", offset: 6, length: 5, replacement: "repo" },
      { file: "src/b.ts", offset: 6, length: 5, replacement: "repo" },
      { file: "src/a.ts", offset: 26, length: 5, replacement: "repo" },
    ],
    createdAt: new Date().toISOString(),
  }
}

describe("filterEditset", () => {
  test("filters by include list", () => {
    const editset = createMockEditset()
    const filtered = filterEditset(editset, ["R1", "R3"])

    expect(filtered.refs.filter((r) => r.selected)).toHaveLength(2)
    expect(filtered.refs.find((r) => r.refId === "R1")?.selected).toBe(true)
    expect(filtered.refs.find((r) => r.refId === "R2")?.selected).toBe(false)
    expect(filtered.refs.find((r) => r.refId === "R3")?.selected).toBe(true)
  })

  test("filters by exclude list", () => {
    const editset = createMockEditset()
    const filtered = filterEditset(editset, undefined, ["R2"])

    expect(filtered.refs.find((r) => r.refId === "R1")?.selected).toBe(true)
    expect(filtered.refs.find((r) => r.refId === "R2")?.selected).toBe(false)
    expect(filtered.refs.find((r) => r.refId === "R3")?.selected).toBe(true)
  })

  test("regenerates edits for selected files only", () => {
    const editset = createMockEditset()
    // Exclude R1 and R3 (both in src/a.ts), keep only R2 (src/b.ts)
    const filtered = filterEditset(editset, ["R2"])

    // Only src/b.ts should have edits
    expect(filtered.edits.every((e) => e.file === "src/b.ts")).toBe(true)
  })

  test("preserves original refs when no filters", () => {
    const editset = createMockEditset()
    const filtered = filterEditset(editset)

    expect(filtered.refs).toEqual(editset.refs)
  })
})

describe("saveEditset / loadEditset", () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "editset-test-"))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test("roundtrips editset through JSON", () => {
    const editset = createMockEditset()
    const filePath = join(tempDir, "test-editset.json")

    saveEditset(editset, filePath)
    expect(existsSync(filePath)).toBe(true)

    const loaded = loadEditset(filePath)
    expect(loaded).toEqual(editset)
  })

  test("throws on missing file", () => {
    expect(() => loadEditset("/nonexistent/path.json")).toThrow(
      "Editset file not found"
    )
  })

  test("preserves all fields through save/load", () => {
    const editset: Editset = {
      id: "detailed-editset",
      operation: "rename",
      symbolKey: "src/foo.ts:1:1:repo",
      pattern: "repo",
      from: "repo",
      to: "repo",
      refs: [
        {
          refId: "ref1",
          file: "src/foo.ts",
          range: [1, 5, 1, 10],
          preview: "const repo = value",
          checksum: "abc123def456",
          selected: true,
        },
      ],
      edits: [
        {
          file: "src/foo.ts",
          offset: 6,
          length: 5,
          replacement: "repo",
        },
      ],
      createdAt: "2024-01-01T00:00:00.000Z",
    }

    const filePath = join(tempDir, "detailed.json")
    saveEditset(editset, filePath)
    const loaded = loadEditset(filePath)

    expect(loaded.id).toBe(editset.id)
    expect(loaded.symbolKey).toBe(editset.symbolKey)
    expect(loaded.pattern).toBe(editset.pattern)
    expect(loaded.refs[0]!.range).toEqual([1, 5, 1, 10])
  })
})
