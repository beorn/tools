#!/usr/bin/env bun
// Guards `bun run build` against producing a drifted server.mjs.
//
// The committed plugins/tribe/server.mjs is a *published artifact* of the
// standalone @bearly/tribe package. It MUST be bundled against the published
// `loggily` npm package, not against a local source checkout.
//
// When bearly is checked out as a submodule inside the km monorepo, km's
// root package.json `overrides` maps `loggily` to a local workspace copy —
// so `node_modules/loggily` becomes a symlink pointing *outside* the bearly
// repo, to raw `src/*.ts`. Building there produces a server.mjs whose source-
// path comments and bundled shape differ from a clean CI rebuild, which the
// built-artifacts workflow then rejects as stale.
//
// Fix: only build from a standalone bearly checkout (`bun install
// --frozen-lockfile` with no km override). This script fails loudly otherwise.

import { realpathSync } from "node:fs"
import { dirname, resolve } from "node:path"

// bearly repo root = two levels up from plugins/tribe/scripts/
const repoRoot = resolve(import.meta.dir, "../../..")

let loggilyEntry: string
try {
  loggilyEntry = realpathSync(Bun.resolveSync("loggily", repoRoot))
} catch (err) {
  console.error("check-build-env: could not resolve `loggily` —")
  console.error("  run `bun install --frozen-lockfile` from the bearly repo root first.")
  console.error(`  (${err})`)
  process.exit(1)
}

const realRepoRoot = realpathSync(repoRoot)
if (!loggilyEntry.startsWith(realRepoRoot + "/")) {
  console.error("check-build-env: `loggily` resolves OUTSIDE the bearly repo:")
  console.error(`  ${loggilyEntry}`)
  console.error("")
  console.error("This happens when bearly is built inside the km monorepo, whose")
  console.error("`overrides` map `loggily` to a local workspace copy. The resulting")
  console.error("server.mjs drifts from a clean CI rebuild and fails built-artifacts.")
  console.error("")
  console.error("Build from a STANDALONE bearly checkout instead:")
  console.error("  git clone https://github.com/beorn/bearly && cd bearly")
  console.error("  bun install --frozen-lockfile")
  console.error("  cd plugins/tribe && bun run build")
  process.exit(1)
}

// loggily must be the published dist build, not raw src — the npm package
// ships dist/*.mjs; a src/ checkout means an override leaked through.
const loggilyDir = dirname(loggilyEntry)
if (loggilyEntry.includes("/src/") || !loggilyEntry.includes("/dist/")) {
  console.error("check-build-env: `loggily` resolves to a source checkout, not the")
  console.error(`  published dist build: ${loggilyEntry}`)
  console.error("  Build from a standalone bearly checkout (see above).")
  process.exit(1)
}

void loggilyDir
console.error(`check-build-env: ok — loggily resolves to published package (${loggilyEntry})`)
