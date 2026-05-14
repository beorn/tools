#!/usr/bin/env bun
/**
 * memwatch — External RSS watchdog for a target process and its parent.
 *
 * Heap-only profilers cannot see bytes that have already left the process via
 * stdout. When a TUI bun process runs under a pty parent (cmux, tmux pane,
 * Ghostty, claude-code), a leaky write loop or a runaway error-handler will
 * inflate the *parent*'s scrollback buffer — and the bun process's own
 * `process.memoryUsage()` will look healthy throughout. macOS then OOM-kills
 * whatever has the largest resident set, which is often the pty parent, not
 * the script that caused the growth.
 *
 * memwatch fills that gap as an EXTERNAL safety net. It samples the target
 * pid + its parent pid every 10 seconds and trips a panic-dump pipeline
 * before the OOM popup arrives.
 *
 * Motivating incident (2026-05-13 ~21:25 PT): silvercode under cmux pumped
 * multi-GB through stdout; macOS OOM popup blamed cmux, not silvercode, and
 * the bun heap looked fine the whole time.
 *
 * Usage:
 *   bun tools/memwatch.ts <pid>
 *     [--threshold-rss-mb 4096]
 *     [--threshold-parent-rss-mb 8192]
 *     [--snapshot-dir /tmp]
 *     [--allow-kill-parent]
 *     [--interval-sec 10]
 *
 * Opt-in by invocation only. No auto-attach. Send SIGINT to memwatch to stop.
 *
 * Panic sequence on threshold trip:
 *   1. Log a banner line and a snapshot summary file (last 100 samples)
 *   2. Send SIGUSR2 to the target (silvery L1 will eventually catch this; for
 *      now, targets without a handler will exit, which is acceptable cleanup)
 *   3. If --allow-kill-parent and the parent threshold tripped, send SIGINT
 *      to the parent to free the pty buffer (destructive — opt-in)
 *   4. Suppress repeat panics for 60s, keep sampling
 *
 * macOS-first; Linux compat is incidental (the `ps -o ...` output shape is
 * close enough on both platforms).
 *
 * Layer 4 of the silvery memory-observability stack. Independent of L1-L3.
 */

import { mkdirSync, writeFileSync, statSync, renameSync, existsSync, appendFileSync } from "node:fs"
import { resolve } from "node:path"

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface MemwatchOptions {
  targetPid: number
  thresholdRssMB: number
  thresholdParentRssMB: number
  snapshotDir: string
  allowKillParent: boolean
  intervalSec: number
  /** Path to the rotating log (defaults to /tmp/memwatch-<pid>.log). */
  logPath: string
  /** Rotate when log file exceeds this size in bytes (default 10MB). */
  maxLogBytes: number
  /** Seconds to suppress repeat panics after a trip (default 60). */
  panicCooldownSec: number
  /** Override `ps` binary (testing hook). */
  psBin: string
  /** Suppress stderr writes (panic banner, sample errors). Test-only. */
  silent: boolean
}

const DEFAULTS = {
  thresholdRssMB: 4096,
  thresholdParentRssMB: 8192,
  snapshotDir: "/tmp",
  allowKillParent: false,
  intervalSec: 10,
  maxLogBytes: 10 * 1024 * 1024,
  panicCooldownSec: 60,
  psBin: "ps",
} as const

const USAGE = `memwatch — external RSS watchdog for a target pid + its parent

Usage: memwatch <pid> [options]

Options:
  --threshold-rss-mb N         Trip when target RSS > N MB (default ${DEFAULTS.thresholdRssMB})
  --threshold-parent-rss-mb N  Trip when parent RSS > N MB (default ${DEFAULTS.thresholdParentRssMB})
  --snapshot-dir DIR           Write snapshot files here (default ${DEFAULTS.snapshotDir})
  --allow-kill-parent          On parent-threshold trip, also send SIGINT to parent (default off)
  --interval-sec N             Sample interval in seconds (default ${DEFAULTS.intervalSec})
  --log-path PATH              Rotating log file (default /tmp/memwatch-<pid>.log)
  --max-log-bytes N            Rotate when log file exceeds N bytes (default ${DEFAULTS.maxLogBytes})
  --panic-cooldown-sec N       Suppress repeat panics for N seconds after a trip (default ${DEFAULTS.panicCooldownSec})
  -h, --help                   Show this help

Signals to target on panic:
  SIGUSR2 → target (always; silvery may catch + dump)
  SIGINT  → parent (only with --allow-kill-parent; destructive)
`

export function parseArgs(argv: string[]): MemwatchOptions {
  let targetPid: number | undefined
  const opts: Omit<MemwatchOptions, "targetPid" | "logPath"> = {
    thresholdRssMB: DEFAULTS.thresholdRssMB,
    thresholdParentRssMB: DEFAULTS.thresholdParentRssMB,
    snapshotDir: DEFAULTS.snapshotDir,
    allowKillParent: DEFAULTS.allowKillParent,
    intervalSec: DEFAULTS.intervalSec,
    maxLogBytes: DEFAULTS.maxLogBytes,
    panicCooldownSec: DEFAULTS.panicCooldownSec,
    psBin: DEFAULTS.psBin,
    silent: false,
  }
  let logPath: string | undefined

  let i = 0
  while (i < argv.length) {
    const a = argv[i]
    if (a === undefined) break
    const next = (): string => {
      i++
      const v = argv[i]
      if (v === undefined) throw new Error(`${a} needs a value`)
      return v
    }
    switch (a) {
      case "-h":
      case "--help":
        console.log(USAGE)
        process.exit(0)
      // eslint-disable-next-line no-fallthrough
      case "--threshold-rss-mb":
        opts.thresholdRssMB = parseIntStrict(next(), a)
        break
      case "--threshold-parent-rss-mb":
        opts.thresholdParentRssMB = parseIntStrict(next(), a)
        break
      case "--snapshot-dir":
        opts.snapshotDir = next()
        break
      case "--allow-kill-parent":
        opts.allowKillParent = true
        break
      case "--interval-sec":
        opts.intervalSec = parseIntStrict(next(), a)
        break
      case "--log-path":
        logPath = next()
        break
      case "--max-log-bytes":
        opts.maxLogBytes = parseIntStrict(next(), a)
        break
      case "--panic-cooldown-sec":
        opts.panicCooldownSec = parseIntStrict(next(), a)
        break
      case "--ps-bin":
        opts.psBin = next()
        break
      default:
        if (a.startsWith("-")) throw new Error(`unknown option: ${a}`)
        if (targetPid !== undefined) throw new Error(`unexpected positional argument: ${a}`)
        targetPid = parseIntStrict(a, "<pid>")
        break
    }
    i++
  }

  if (targetPid === undefined) {
    throw new Error("missing required <pid> argument (use --help)")
  }
  if (opts.intervalSec <= 0) throw new Error("--interval-sec must be > 0")
  if (opts.thresholdRssMB <= 0) throw new Error("--threshold-rss-mb must be > 0")
  if (opts.thresholdParentRssMB <= 0) throw new Error("--threshold-parent-rss-mb must be > 0")

  return {
    ...opts,
    targetPid,
    logPath: logPath ?? `/tmp/memwatch-${targetPid}.log`,
  }
}

function parseIntStrict(s: string, label: string): number {
  const n = Number.parseInt(s, 10)
  if (!Number.isFinite(n) || String(n) !== s.trim()) {
    throw new Error(`${label}: expected integer, got ${JSON.stringify(s)}`)
  }
  return n
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

export interface ProcessSample {
  /** Wall-clock unix ms. */
  ts: number
  /** Resident set size in MB. */
  rssMB: number
  /** Virtual size in MB. */
  vszMB: number
  /** CPU percent as reported by `ps`. */
  cpuPct: number
  /** Parent pid (from ps `ppid`). */
  ppid: number
  /** Process command name (truncated `comm`). */
  name: string
}

export interface FullSample {
  ts: number
  target: ProcessSample | null
  parent: ProcessSample | null
  parentPid: number | null
  childCount: number
}

/**
 * Run `ps` for one pid and return parsed metrics, or null if the pid is gone.
 *
 * On macOS `rss` and `vsz` are reported in 1024-byte units (KB). Linux `ps`
 * matches. We convert both to MB and floor — the watcher is only interested
 * in MB-scale thresholds, so sub-MB precision is noise.
 */
export async function sampleOne(pid: number, psBin = "ps"): Promise<ProcessSample | null> {
  // Format: pid ppid rss vsz %cpu comm
  // -o ...= suppresses the header, giving us a pure data line.
  const proc = Bun.spawn([psBin, "-p", String(pid), "-o", "pid=,ppid=,rss=,vsz=,%cpu=,comm="], {
    stdout: "pipe",
    stderr: "ignore",
  })
  const out = (await new Response(proc.stdout).text()).trim()
  await proc.exited
  if (!out) return null

  // The comm field may contain spaces (e.g. `/usr/local/bin/node --foo`), so
  // we split off the first 5 numeric columns and concatenate the rest.
  // Whitespace-separated tokens; macOS pads with spaces.
  const parts = out.split(/\s+/)
  if (parts.length < 6) return null
  const [pidStr, ppidStr, rssStr, vszStr, cpuStr, ...nameParts] = parts as [
    string,
    string,
    string,
    string,
    string,
    ...string[],
  ]
  const rssKB = Number.parseInt(rssStr, 10)
  const vszKB = Number.parseInt(vszStr, 10)
  const ppid = Number.parseInt(ppidStr, 10)
  const cpu = Number.parseFloat(cpuStr)
  const parsedPid = Number.parseInt(pidStr, 10)
  if (!Number.isFinite(rssKB) || !Number.isFinite(ppid) || parsedPid !== pid) return null

  return {
    ts: Date.now(),
    rssMB: Math.round(rssKB / 1024),
    vszMB: Number.isFinite(vszKB) ? Math.round(vszKB / 1024) : 0,
    cpuPct: Number.isFinite(cpu) ? cpu : 0,
    ppid,
    name: nameParts.join(" ").trim(),
  }
}

/**
 * Count child processes of `ppid` using `ps -A -o ppid=,pid=`. Returns 0 on
 * failure (best-effort; this is a debug metric, not a trip input).
 */
export async function countChildren(ppid: number, psBin = "ps"): Promise<number> {
  const proc = Bun.spawn([psBin, "-A", "-o", "ppid=,pid="], { stdout: "pipe", stderr: "ignore" })
  const out = (await new Response(proc.stdout).text()).trim()
  await proc.exited
  if (!out) return 0
  let count = 0
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)/)
    if (m?.[1] === undefined) continue
    if (Number.parseInt(m[1], 10) === ppid) count++
  }
  return count
}

/** Sample target + parent in one go. */
export async function sampleAll(targetPid: number, psBin = "ps"): Promise<FullSample> {
  const target = await sampleOne(targetPid, psBin)
  const parentPid = target?.ppid ?? null
  const parent = parentPid !== null && parentPid > 1 ? await sampleOne(parentPid, psBin) : null
  const childCount = await countChildren(targetPid, psBin)
  return {
    ts: Date.now(),
    target,
    parent,
    parentPid,
    childCount,
  }
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/**
 * Append one line to the log, rotating to `<path>.1` when it exceeds
 * maxBytes. The rotation is a single `rename` — readers tailing the previous
 * inode keep working; new writes land in a fresh file.
 */
export function logLine(line: string, logPath: string, maxBytes: number): void {
  try {
    if (existsSync(logPath)) {
      const size = statSync(logPath).size
      if (size > maxBytes) {
        try {
          renameSync(logPath, `${logPath}.1`)
        } catch {
          /* if rename fails (cross-device, perms), just keep appending */
        }
      }
    }
    appendFileSync(logPath, line.endsWith("\n") ? line : `${line}\n`)
  } catch (err) {
    // Logging must never throw; surface to stderr instead.
    process.stderr.write(`memwatch: log write failed: ${String(err)}\n`)
  }
}

export function formatSampleLine(pid: number, s: FullSample): string {
  // Format: ISO8601 <pid> target=rss/vsz/cpu/name children=N parent=ppid/rss/name
  const iso = new Date(s.ts).toISOString()
  const t = s.target
  const p = s.parent
  const targetStr = t
    ? `target_rss_mb=${t.rssMB} target_vsz_mb=${t.vszMB} target_cpu=${t.cpuPct.toFixed(1)} target_name=${quote(t.name)}`
    : "target=gone"
  const parentStr = p
    ? `parent_pid=${s.parentPid} parent_rss_mb=${p.rssMB} parent_name=${quote(p.name)}`
    : `parent=${s.parentPid ?? "none"}`
  return `${iso} ${pid} ${targetStr} children=${s.childCount} ${parentStr}`
}

function quote(s: string): string {
  // Quote names that contain whitespace; everything else passes through so
  // the log stays grep-friendly.
  if (/\s/.test(s)) return JSON.stringify(s)
  return s
}

// ---------------------------------------------------------------------------
// Panic pipeline
// ---------------------------------------------------------------------------

export type TripReason = "target" | "parent"

export interface PanicAction {
  reason: TripReason
  rssMB: number
  thresholdMB: number
  targetPid: number
  parentPid: number | null
  /** True if SIGUSR2 was delivered successfully. */
  sigusr2Sent: boolean
  /** True if SIGINT was delivered to the parent (only with --allow-kill-parent). */
  sigintParentSent: boolean
  /** Path to the snapshot summary file written. */
  snapshotPath: string
}

/** Best-effort kill — returns whether the signal was delivered without error. */
export function trySignal(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal)
    return true
  } catch {
    return false
  }
}

/** Write the snapshot summary (last N samples) to a file in snapshotDir. */
export function writeSnapshot(snapshotDir: string, targetPid: number, ts: number, samples: FullSample[]): string {
  mkdirSync(snapshotDir, { recursive: true })
  const stamp = new Date(ts).toISOString().replace(/[:.]/g, "-")
  const path = resolve(snapshotDir, `memwatch-${targetPid}-${stamp}.summary.txt`)
  const lines = [
    `# memwatch panic snapshot`,
    `# target_pid=${targetPid}`,
    `# generated_at=${new Date(ts).toISOString()}`,
    `# sample_count=${samples.length}`,
    "",
    ...samples.map((s) => formatSampleLine(targetPid, s)),
  ]
  writeFileSync(path, lines.join("\n") + "\n")
  return path
}

/**
 * Run the panic pipeline. Returns the action record for callers (tests) to
 * assert against.
 */
export function panic(
  reason: TripReason,
  rssMB: number,
  thresholdMB: number,
  opts: Pick<MemwatchOptions, "targetPid" | "snapshotDir" | "allowKillParent" | "logPath" | "maxLogBytes"> & {
    silent?: boolean
  },
  parentPid: number | null,
  recentSamples: FullSample[],
): PanicAction {
  const ts = Date.now()
  const banner = `${new Date(ts).toISOString()} ${opts.targetPid} PANIC: ${reason} RSS = ${rssMB}MB exceeds threshold ${thresholdMB}MB`
  logLine(banner, opts.logPath, opts.maxLogBytes)
  if (!opts.silent) process.stderr.write(`${banner}\n`)

  const snapshotPath = writeSnapshot(opts.snapshotDir, opts.targetPid, ts, recentSamples)
  logLine(`${new Date().toISOString()} ${opts.targetPid} snapshot=${snapshotPath}`, opts.logPath, opts.maxLogBytes)

  const sigusr2Sent = trySignal(opts.targetPid, "SIGUSR2")
  logLine(
    `${new Date().toISOString()} ${opts.targetPid} signal=SIGUSR2 delivered=${sigusr2Sent}`,
    opts.logPath,
    opts.maxLogBytes,
  )

  let sigintParentSent = false
  if (reason === "parent" && opts.allowKillParent && parentPid !== null && parentPid > 1) {
    sigintParentSent = trySignal(parentPid, "SIGINT")
    logLine(
      `${new Date().toISOString()} ${opts.targetPid} parent=${parentPid} signal=SIGINT delivered=${sigintParentSent}`,
      opts.logPath,
      opts.maxLogBytes,
    )
  }

  return {
    reason,
    rssMB,
    thresholdMB,
    targetPid: opts.targetPid,
    parentPid,
    sigusr2Sent,
    sigintParentSent,
    snapshotPath,
  }
}

// ---------------------------------------------------------------------------
// Sample-loop runner
// ---------------------------------------------------------------------------

export interface RunHandle {
  /** Stop the loop. Resolves when the in-flight sample completes. */
  stop(): Promise<void>
  /** Resolves when the loop exits naturally (target dies). */
  done: Promise<void>
}

/**
 * Start the watcher loop. Exposed for tests + integration; the CLI calls this
 * with `process.argv` parsed by parseArgs.
 *
 * Loop semantics:
 *   - Sample every `intervalSec` seconds.
 *   - On target gone: log and exit cleanly.
 *   - On threshold trip (target or parent): fire panic pipeline, suppress
 *     repeat panics for `panicCooldownSec`.
 *   - Last 100 samples kept in a ring buffer for snapshot files.
 */
export function start(opts: MemwatchOptions): RunHandle {
  let stopping = false
  let stopResolve: () => void = () => {}
  const stopped = new Promise<void>((resolve) => {
    stopResolve = resolve
  })
  let doneResolve: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    doneResolve = resolve
  })

  const ring: FullSample[] = []
  const RING_CAP = 100
  let cooldownUntil = 0

  logLine(
    `${new Date().toISOString()} ${opts.targetPid} memwatch start target=${opts.targetPid} threshold_target_mb=${opts.thresholdRssMB} threshold_parent_mb=${opts.thresholdParentRssMB} interval_sec=${opts.intervalSec} allow_kill_parent=${opts.allowKillParent}`,
    opts.logPath,
    opts.maxLogBytes,
  )

  const tick = async (): Promise<void> => {
    if (stopping) return
    let sample: FullSample
    try {
      sample = await sampleAll(opts.targetPid, opts.psBin)
    } catch (err) {
      logLine(
        `${new Date().toISOString()} ${opts.targetPid} sample_error=${String(err)}`,
        opts.logPath,
        opts.maxLogBytes,
      )
      return
    }

    if (!sample.target) {
      logLine(`${new Date().toISOString()} ${opts.targetPid} target_gone exiting`, opts.logPath, opts.maxLogBytes)
      stopping = true
      stopResolve()
      doneResolve()
      return
    }

    ring.push(sample)
    if (ring.length > RING_CAP) ring.shift()
    logLine(formatSampleLine(opts.targetPid, sample), opts.logPath, opts.maxLogBytes)

    const now = sample.ts
    if (now < cooldownUntil) return

    // Target trip wins if both — caller cares more about the host process.
    if (sample.target.rssMB > opts.thresholdRssMB) {
      panic("target", sample.target.rssMB, opts.thresholdRssMB, opts, sample.parentPid, [...ring])
      cooldownUntil = now + opts.panicCooldownSec * 1000
      return
    }
    if (sample.parent && sample.parent.rssMB > opts.thresholdParentRssMB) {
      panic("parent", sample.parent.rssMB, opts.thresholdParentRssMB, opts, sample.parentPid, [...ring])
      cooldownUntil = now + opts.panicCooldownSec * 1000
    }
  }

  // Fire immediately, then on interval. We schedule via setTimeout chains
  // instead of setInterval so a slow sample never stacks ticks.
  const schedule = async (): Promise<void> => {
    while (!stopping) {
      await tick()
      if (stopping) break
      await new Promise<void>((resolve) => {
        setTimeout(resolve, opts.intervalSec * 1000)
      })
    }
    doneResolve()
  }

  void schedule()

  return {
    async stop() {
      if (stopping) return stopped
      stopping = true
      stopResolve()
      // Wait for the in-flight tick to finish + the schedule loop to exit.
      await done
    },
    done,
  }
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let opts: MemwatchOptions
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`memwatch: ${err instanceof Error ? err.message : String(err)}\n`)
    process.stderr.write(`\n${USAGE}`)
    process.exit(2)
  }

  // Verify the target exists before starting the watcher — fail fast on typos.
  const initial = await sampleOne(opts.targetPid, opts.psBin)
  if (!initial) {
    process.stderr.write(`memwatch: target pid ${opts.targetPid} not running\n`)
    process.exit(1)
  }
  process.stderr.write(
    `memwatch: watching pid ${opts.targetPid} (${initial.name}), parent=${initial.ppid}, log=${opts.logPath}\n`,
  )

  const handle = start(opts)

  const shutdown = (signal: string): void => {
    process.stderr.write(`memwatch: received ${signal}, stopping\n`)
    void handle.stop().then(() => process.exit(0))
  }
  process.on("SIGINT", () => shutdown("SIGINT"))
  process.on("SIGTERM", () => shutdown("SIGTERM"))

  await handle.done
  process.exit(0)
}

// Bun + Node ESM compat: only run main when invoked directly.
const isMain = import.meta.main === true || import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  void main()
}
