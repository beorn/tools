import { existsSync, readFileSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"

export type CommandResult = {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export type BuildBeadContextOptions = {
  readonly cwd?: string
  readonly runCommand?: (cmd: string[], opts: { cwd: string }) => Promise<CommandResult>
}

type CodeRef = {
  readonly path: string
  readonly line: number
}

const MAX_BEAD_BODY_CHARS = 60_000
const MAX_COMMAND_OUTPUT_CHARS = 24_000
const CODE_CONTEXT_RADIUS = 5
const COMMAND_TIMEOUT_MS = 120_000

export async function buildBeadContext(
  bead: string | undefined,
  opts: BuildBeadContextOptions = {},
): Promise<string | undefined> {
  if (!bead) return undefined

  const cwd = opts.cwd ?? process.cwd()
  const runCommand = opts.runCommand ?? runCommandDefault
  const beadPath = await resolveBeadPath(bead, { cwd, runCommand })
  if (!beadPath) {
    return [`# /pro --bead context`, "", `Unable to resolve bead: ${bead}`].join("\n")
  }

  const beadBody = readFileSync(resolveDisplayPath(cwd, beadPath), "utf-8")
  const testPaths = extractExistingTestPaths(beadBody, cwd)
  const codeRefs = extractExistingCodeRefs(beadBody, cwd)
  const parts = [
    "# /pro --bead context",
    "",
    `Bead: ${bead}`,
    `Path: ${beadPath}`,
    "",
    "## Bead body",
    "",
    fenced("markdown", truncate(beadBody, MAX_BEAD_BODY_CHARS)),
  ]

  if (testPaths.length > 0) {
    parts.push("", "## Linked test output")
    for (const testPath of testPaths) {
      const result = await runCommand(["bun", "vitest", "run", testPath], { cwd })
      parts.push(
        "",
        `### ${testPath}`,
        "",
        `Command: bun vitest run ${testPath}`,
        `Exit: ${result.exitCode}`,
        "",
        fenced("text", truncate(joinOutput(result), MAX_COMMAND_OUTPUT_CHARS)),
      )
    }
  }

  if (codeRefs.length > 0) {
    parts.push("", "## Cited code at HEAD")
    for (const ref of codeRefs) {
      const snippet = readLineSnippet(resolve(cwd, ref.path), ref.line)
      const blame = await runCommand(["git", "blame", "-L", `${ref.line},${ref.line}`, "--", ref.path], { cwd })
      parts.push(
        "",
        `### ${ref.path}:${ref.line}`,
        "",
        fenced("text", snippet),
        "",
        "Blame:",
        "",
        fenced("text", truncate(joinOutput(blame), MAX_COMMAND_OUTPUT_CHARS)),
      )
    }
  }

  return parts.join("\n")
}

async function resolveBeadPath(
  bead: string,
  opts: { cwd: string; runCommand: (cmd: string[], opts: { cwd: string }) => Promise<CommandResult> },
): Promise<string | null> {
  const direct = existingDisplayPath(bead, opts.cwd, { allowExternal: true })
  if (direct) return direct

  const shown = await opts.runCommand(["km", "bd", "show", bead, "--json"], { cwd: opts.cwd })
  if (shown.exitCode !== 0 || !shown.stdout.trim()) return null
  try {
    const parsed = JSON.parse(shown.stdout) as { path?: unknown }
    if (typeof parsed.path !== "string") return null
    return existingDisplayPath(parsed.path, opts.cwd, { allowExternal: false })
  } catch {
    return null
  }
}

function extractExistingTestPaths(text: string, cwd: string): string[] {
  const paths = new Set<string>()
  const re = /(?:^|[\s([`'"])([A-Za-z0-9_@./-]+(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs|md))(?:$|[\s)\]`'",.])/gm
  for (const match of text.matchAll(re)) {
    const path = existingDisplayPath(match[1]!, cwd, { allowExternal: false })
    if (path) paths.add(path)
  }
  return [...paths]
}

function extractExistingCodeRefs(text: string, cwd: string): CodeRef[] {
  const refs = new Map<string, CodeRef>()
  const re =
    /(?:^|[\s([`'"])([A-Za-z0-9_@./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|md|json|yaml|yml|css|scss)):(\d+)(?::\d+)?(?:$|[\s)\]`'",.])/gm
  for (const match of text.matchAll(re)) {
    const path = existingDisplayPath(match[1]!, cwd, { allowExternal: false })
    const line = Number.parseInt(match[2]!, 10)
    if (!path || !Number.isFinite(line) || line < 1) continue
    refs.set(`${path}:${line}`, { path, line })
  }
  return [...refs.values()]
}

function existingDisplayPath(path: string, cwd: string, opts: { allowExternal: boolean }): string | null {
  const absolute = isAbsolute(path) ? path : resolve(cwd, path)
  if (!existsSync(absolute)) return null
  const rel = relative(cwd, absolute)
  if (rel.startsWith("..") || isAbsolute(rel)) return opts.allowExternal ? absolute : null
  return rel || "."
}

function resolveDisplayPath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path)
}

function readLineSnippet(file: string, line: number): string {
  const lines = readFileSync(file, "utf-8").split(/\r?\n/)
  const start = Math.max(1, line - CODE_CONTEXT_RADIUS)
  const end = Math.min(lines.length, line + CODE_CONTEXT_RADIUS)
  const width = String(end).length
  const out: string[] = []
  for (let n = start; n <= end; n++) {
    out.push(`${String(n).padStart(width, " ")}: ${lines[n - 1] ?? ""}`)
  }
  return out.join("\n")
}

async function runCommandDefault(cmd: string[], opts: { cwd: string }): Promise<CommandResult> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const timeout = setTimeout(() => {
    proc.kill("SIGTERM")
  }, COMMAND_TIMEOUT_MS)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).finally(() => clearTimeout(timeout))
  return { exitCode, stdout, stderr }
}

function joinOutput(result: CommandResult): string {
  return [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join("\n\n[stderr]\n")
}

function fenced(lang: string, body: string): string {
  return ["```" + lang, body, "```"].join("\n")
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]`
}
