import { describe, test, expect } from "bun:test"
import {
  SymbolInfo,
  Reference,
  Edit,
  Editset,
  SymbolMatch,
} from "../../tools/lib/core/types"

describe("Zod schemas", () => {
  describe("SymbolInfo", () => {
    test("validates correct symbol info", () => {
      const valid = {
        symbolKey: "src/foo.ts:1:1:foo",
        name: "foo",
        kind: "variable",
        file: "src/foo.ts",
        line: 1,
        column: 1,
      }
      expect(() => SymbolInfo.parse(valid)).not.toThrow()
    })

    test("rejects invalid kind", () => {
      const invalid = {
        symbolKey: "src/foo.ts:1:1:foo",
        name: "foo",
        kind: "invalid",
        file: "src/foo.ts",
        line: 1,
        column: 1,
      }
      expect(() => SymbolInfo.parse(invalid)).toThrow()
    })

    test("accepts all valid kinds", () => {
      const kinds = [
        "variable",
        "function",
        "type",
        "interface",
        "property",
        "class",
        "method",
        "parameter",
      ]
      for (const kind of kinds) {
        const valid = {
          symbolKey: "src/foo.ts:1:1:foo",
          name: "foo",
          kind,
          file: "src/foo.ts",
          line: 1,
          column: 1,
        }
        expect(() => SymbolInfo.parse(valid)).not.toThrow()
      }
    })
  })

  describe("Reference", () => {
    test("validates with tuple range", () => {
      const valid = {
        refId: "abc12345",
        file: "src/foo.ts",
        range: [1, 1, 1, 10] as [number, number, number, number],
        preview: "const foo = 1",
        checksum: "abc123456789",
        selected: true,
      }
      expect(() => Reference.parse(valid)).not.toThrow()
    })

    test("rejects wrong range length", () => {
      const invalid = {
        refId: "abc12345",
        file: "src/foo.ts",
        range: [1, 1, 1], // missing 4th element
        preview: "const foo = 1",
        checksum: "abc123456789",
        selected: true,
      }
      expect(() => Reference.parse(invalid)).toThrow()
    })
  })

  describe("Edit", () => {
    test("validates correct edit", () => {
      const valid = {
        file: "src/foo.ts",
        offset: 100,
        length: 5,
        replacement: "newName",
      }
      expect(() => Edit.parse(valid)).not.toThrow()
    })
  })

  describe("Editset", () => {
    test("validates complete structure", () => {
      const valid = {
        id: "rename-repo-to-repo-1706000000",
        operation: "rename",
        from: "repo",
        to: "repo",
        refs: [
          {
            refId: "abc12345",
            file: "src/foo.ts",
            range: [1, 1, 1, 10] as [number, number, number, number],
            preview: "const repo = 1",
            checksum: "abc123456789",
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
        createdAt: new Date().toISOString(),
      }
      expect(() => Editset.parse(valid)).not.toThrow()
    })

    test("accepts optional symbolKey and pattern", () => {
      const withSymbolKey = {
        id: "rename-1",
        operation: "rename",
        symbolKey: "src/foo.ts:1:1:repo",
        from: "repo",
        to: "repo",
        refs: [],
        edits: [],
        createdAt: new Date().toISOString(),
      }
      expect(() => Editset.parse(withSymbolKey)).not.toThrow()

      const withPattern = {
        id: "rename-1",
        operation: "rename",
        pattern: "repo",
        from: "repo",
        to: "repo",
        refs: [],
        edits: [],
        createdAt: new Date().toISOString(),
      }
      expect(() => Editset.parse(withPattern)).not.toThrow()
    })
  })

  describe("SymbolMatch", () => {
    test("validates symbol match", () => {
      const valid = {
        symbolKey: "src/foo.ts:1:1:repo",
        name: "repo",
        kind: "variable",
        file: "src/foo.ts",
        line: 1,
        refCount: 5,
      }
      expect(() => SymbolMatch.parse(valid)).not.toThrow()
    })
  })
})
