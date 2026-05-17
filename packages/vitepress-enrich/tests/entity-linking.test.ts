import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createLinkifier, loadTerminfoEntities } from "../src/index.ts"

function createContentDir(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "terminfo-entities-"))
  mkdirSync(dir, { recursive: true })
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`, "utf-8")
  }
  return dir
}

describe("createLinkifier", () => {
  it("links dotted terms while skipping protected HTML regions and repeated entities", () => {
    const linkify = createLinkifier([
      { term: "xterm.js", href: "/terminals/xterm-js" },
      { term: "SGR", href: "/sgr" },
      { term: "Bold (SGR 1)", href: "/sgr/1-bold" },
      { term: "SGR 1", href: "/sgr/1-bold" },
    ])

    const html = linkify(
      'xterm.js supports SGR, Bold (SGR 1), and SGR 1. <code>xterm.js SGR</code> <a href="/already">SGR</a> <h2>SGR</h2> SGR again.',
    )

    expect(html).toContain('<a href="/terminals/xterm-js" class="hover-link">xterm.js</a>')
    expect(html).toContain('<a href="/sgr" class="hover-link">SGR</a>')
    expect(html).toContain('<a href="/sgr/1-bold" class="hover-link">Bold (SGR 1)</a>')
    expect(html).toContain("<code>xterm.js SGR</code>")
    expect(html).toContain('<a href="/already">SGR</a>')
    expect(html).toContain("<h2>SGR</h2>")
    expect(html).toContain("</a>, and SGR 1.")
    expect(html.match(/href="\/sgr"/g)).toHaveLength(1)
    expect(html.match(/href="\/sgr\/1-bold"/g)).toHaveLength(1)
  })
})

describe("loadTerminfoEntities", () => {
  it("builds page entities from terminfo.dev content data", () => {
    const contentDir = createContentDir({
      "glossary.json": {
        SGR: {
          expansion: "Select Graphic Rendition",
          description: "Escape sequences for text styling.",
          link: "/sgr",
        },
        terminfo: {
          expansion: "Terminal Information Database",
          description: "The site itself.",
          link: "/about",
        },
      },
      "features.json": {
        "sgr.bold": {
          name: "Bold (SGR 1)",
          slug: "1-bold",
          body: "SGR 1 activates bold text.",
        },
      },
      "terminals.json": {
        xtermjs: {
          label: "xterm.js",
          slug: "xterm-js",
          description: "The web terminal emulator.",
        },
      },
      "frameworks.json": {
        ink: {
          label: "Ink",
          description: "React for CLIs.",
        },
      },
      "standards.json": {
        "ecma-48": {
          label: "ECMA-48",
          description: "The CSI grammar.",
        },
      },
      "categories.json": {
        sgr: {
          label: "SGR (Text Styling)",
          description: "Text styling category.",
        },
      },
      "baselines.json": {
        core: {
          label: "Core TUI",
          tagline: "The minimum useful baseline.",
        },
      },
    })

    const entities = loadTerminfoEntities(contentDir, { tooltipOnlyHrefs: ["/about"] })

    expect(entities).toContainEqual(
      expect.objectContaining({ term: "SGR", href: "/sgr", tooltip: expect.stringContaining("Select Graphic") }),
    )
    expect(entities).toContainEqual(
      expect.objectContaining({ term: "terminfo", href: undefined, tooltip: expect.stringContaining("Database") }),
    )
    expect(entities).toContainEqual(
      expect.objectContaining({ term: "Bold (SGR 1)", href: "/sgr/1-bold", tooltip: "SGR 1 activates bold text." }),
    )
    expect(entities).toContainEqual(expect.objectContaining({ term: "xterm.js", href: "/terminals/xterm-js" }))
    expect(entities).toContainEqual(expect.objectContaining({ term: "Ink", href: "/framework/ink" }))
    expect(entities).toContainEqual(expect.objectContaining({ term: "ECMA-48", href: "/ecma-48" }))
    expect(entities).toContainEqual(expect.objectContaining({ term: "SGR (Text Styling)", href: "/sgr" }))
    expect(entities).toContainEqual(expect.objectContaining({ term: "Core TUI", href: "/baseline/core" }))
  })
})
