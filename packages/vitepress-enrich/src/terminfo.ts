import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { GlossaryEntity } from "./types.ts"

export interface TerminfoEntitiesOptions {
  /** Hrefs that should render as tooltip-only hints instead of navigation. */
  tooltipOnlyHrefs?: Iterable<string>
}

interface GlossaryEntry {
  expansion?: string
  description?: string
  link?: string
}

interface FeatureEntry {
  name?: string
  slug?: string
  body?: string
  probe?: string
}

interface TerminalEntry {
  label?: string
  slug?: string
  description?: string
}

interface FrameworkEntry {
  label?: string
  description?: string
}

interface StandardEntry {
  label?: string
  description?: string
}

interface CategoryEntry {
  label?: string
  description?: string
}

interface BaselineEntry {
  label?: string
  tagline?: string
  description?: string
}

function readContentJson<T>(contentDir: string, name: string): Record<string, T> {
  try {
    return JSON.parse(readFileSync(join(contentDir, name), "utf-8")) as Record<string, T>
  } catch {
    return {}
  }
}

function cleanText(value: unknown): string {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function summarize(value: unknown, fallback: string): string {
  const text = cleanText(value) || cleanText(fallback)
  if (text.length <= 180) return text
  return `${text.slice(0, 177).trimEnd()}...`
}

function featureHref(id: string, entry: FeatureEntry): string {
  const category = id.split(".")[0] || id
  const slug = entry.slug ?? id.replaceAll(".", "-")
  return `/${category}/${slug}`
}

function parentheticalAliases(term: string): string[] {
  return [...term.matchAll(/\(([^()]+)\)/g)].map((match) => match[1]!.trim()).filter((alias) => alias.length >= 3)
}

function pushEntity(
  entities: GlossaryEntity[],
  term: string | undefined,
  href: string | undefined,
  tooltip: string,
  tooltipOnlyHrefs: Set<string>,
  minLength: number,
): void {
  const cleaned = term?.trim()
  if (!cleaned || cleaned.length < minLength) return
  entities.push({
    term: cleaned,
    href: href && !tooltipOnlyHrefs.has(href) ? href : undefined,
    tooltip,
  })
}

/**
 * Load terminfo.dev page entities from content/*.json.
 *
 * The order is intentional: curated glossary aliases win ambiguous names,
 * feature aliases come before broad categories, and the remaining page
 * families preserve terminfo.dev's existing link-precedence behavior.
 */
export function loadTerminfoEntities(contentDir: string, options: TerminfoEntitiesOptions = {}): GlossaryEntity[] {
  const entities: GlossaryEntity[] = []
  const tooltipOnlyHrefs = new Set(options.tooltipOnlyHrefs ?? [])

  const glossary = readContentJson<GlossaryEntry>(contentDir, "glossary.json")
  for (const [term, entry] of Object.entries(glossary)) {
    if (!entry.link) continue
    const tooltip = entry.expansion
      ? `${entry.expansion}: ${cleanText(entry.description)}`
      : summarize(entry.description, term)
    pushEntity(entities, term, entry.link, tooltip, tooltipOnlyHrefs, 0)
  }

  const features = readContentJson<FeatureEntry>(contentDir, "features.json")
  for (const [id, entry] of Object.entries(features)) {
    if (!entry.name) continue
    const href = featureHref(id, entry)
    const tooltip = summarize(entry.body ?? entry.probe, entry.name)
    pushEntity(entities, entry.name, href, tooltip, tooltipOnlyHrefs, 3)
    for (const alias of parentheticalAliases(entry.name)) {
      pushEntity(entities, alias, href, tooltip, tooltipOnlyHrefs, 3)
    }
  }

  const terminals = readContentJson<TerminalEntry>(contentDir, "terminals.json")
  for (const entry of Object.values(terminals)) {
    pushEntity(
      entities,
      entry.label,
      entry.slug ? `/terminals/${entry.slug}` : undefined,
      summarize(entry.description, `${entry.label} terminal emulator`),
      tooltipOnlyHrefs,
      3,
    )
  }

  const frameworks = readContentJson<FrameworkEntry>(contentDir, "frameworks.json")
  for (const [id, entry] of Object.entries(frameworks)) {
    pushEntity(
      entities,
      entry.label,
      `/framework/${id}`,
      summarize(entry.description, `${entry.label} TUI framework`),
      tooltipOnlyHrefs,
      3,
    )
  }

  const standards = readContentJson<StandardEntry>(contentDir, "standards.json")
  for (const [id, entry] of Object.entries(standards)) {
    pushEntity(entities, entry.label, `/${id}`, summarize(entry.description, entry.label ?? id), tooltipOnlyHrefs, 3)
  }

  const categories = readContentJson<CategoryEntry>(contentDir, "categories.json")
  for (const [id, entry] of Object.entries(categories)) {
    pushEntity(entities, entry.label, `/${id}`, summarize(entry.description, entry.label ?? id), tooltipOnlyHrefs, 4)
  }

  const baselines = readContentJson<BaselineEntry>(contentDir, "baselines.json")
  for (const [id, entry] of Object.entries(baselines)) {
    pushEntity(
      entities,
      entry.label,
      `/baseline/${id}`,
      summarize(entry.tagline ?? entry.description, `${entry.label} baseline`),
      tooltipOnlyHrefs,
      4,
    )
  }

  return entities
}
