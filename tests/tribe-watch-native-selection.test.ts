import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const WATCH_SOURCE = resolve(import.meta.dirname, "../tools/tribe-watch.tsx")

describe("tribe watch native terminal selection", () => {
  it("opts out of Silvery mouse tracking so regular text selection/copy works", () => {
    const source = readFileSync(WATCH_SOURCE, "utf8")

    expect(source).toMatch(/render\(<App[\s\S]*,\s*term,\s*\{[\s\S]*mouse:\s*false/)
  })
})
