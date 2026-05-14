#!/usr/bin/env bun
/**
 * Leaky fixture process for memwatch smoke tests.
 *
 * Allocates large Buffers in a loop, holding them in a module-level array so
 * they aren't GC'd. Catches SIGUSR2 and writes a marker file before exiting,
 * so the test can assert that memwatch actually delivered the signal.
 *
 * Args:
 *   --chunk-mb N      Size of each allocation (default 50)
 *   --max-chunks N    Stop allocating after N chunks (default 20)
 *   --interval-ms N   Wait between allocations (default 100)
 *   --marker-path P   Write 'SIGUSR2' to P on signal receipt (required)
 */

import { writeFileSync } from "node:fs"

function parseArgs(argv: string[]): {
  chunkMB: number
  maxChunks: number
  intervalMs: number
  markerPath: string
} {
  const opts = { chunkMB: 50, maxChunks: 20, intervalMs: 100, markerPath: "" }
  let i = 0
  while (i < argv.length) {
    const a = argv[i]!
    const next = (): string => {
      i++
      if (i >= argv.length) throw new Error(`${a} needs a value`)
      return argv[i]!
    }
    switch (a) {
      case "--chunk-mb":
        opts.chunkMB = Number.parseInt(next(), 10)
        break
      case "--max-chunks":
        opts.maxChunks = Number.parseInt(next(), 10)
        break
      case "--interval-ms":
        opts.intervalMs = Number.parseInt(next(), 10)
        break
      case "--marker-path":
        opts.markerPath = next()
        break
      default:
        throw new Error(`unknown arg: ${a}`)
    }
    i++
  }
  if (!opts.markerPath) throw new Error("--marker-path is required")
  return opts
}

const opts = parseArgs(process.argv.slice(2))

// Hold references so the JS engine can't free them.
const hold: Buffer[] = []

process.on("SIGUSR2", () => {
  try {
    writeFileSync(opts.markerPath, "SIGUSR2\n")
  } catch {
    /* best effort */
  }
  // Exit promptly; memwatch's panic semantics treat target death as cleanup.
  process.exit(0)
})

async function main(): Promise<void> {
  // Touch every page so RSS actually grows — `Buffer.alloc` zero-fills which
  // is enough on macOS, but write a single byte mid-buffer for paranoia.
  // Touch every 4KB page so RSS actually grows on macOS (which lazy-pages
  // anonymous allocations). Buffer.alloc() zero-fills, but zero pages are
  // copy-on-write mapped to a shared zero page and never count toward RSS.
  const PAGE = 4096
  for (let n = 0; n < opts.maxChunks; n++) {
    const buf = Buffer.alloc(opts.chunkMB * 1024 * 1024)
    for (let i = 0; i < buf.length; i += PAGE) {
      buf[i] = (n + 1) & 0xff
    }
    hold.push(buf)
    process.stderr.write(`leaky: chunk ${n + 1}/${opts.maxChunks} allocated (${opts.chunkMB} MB)\n`)
    await new Promise((r) => setTimeout(r, opts.intervalMs))
  }
  // Sit on the heap so memwatch has time to observe + trip even after the
  // loop finishes. Use a long setInterval as the keep-alive — `await new
  // Promise(() => {})` lets Bun exit because nothing keeps the event loop
  // alive.
  process.stderr.write(`leaky: allocations complete, holding\n`)
  const keepAlive = setInterval(() => {
    /* keep event loop alive */
  }, 60_000)
  // Reference to satisfy the unused-var rule and ensure it isn't GC'd.
  void keepAlive
  // Park forever.
  await new Promise<void>(() => undefined)
}

void main()
