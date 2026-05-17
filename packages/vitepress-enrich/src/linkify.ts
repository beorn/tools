/**
 * Build-time content linkification — wraps known entity names in HTML links.
 * Used by VitePress route generators ([id].paths.ts) to linkify descriptions
 * before passing to Vue templates via v-html.
 *
 * Unlike the glossary markdown-it plugin (which processes markdown at parse time),
 * this works on plain strings at build time.
 */
import type { GlossaryEntity } from "./types.ts"
import { compileEntities, replaceInHtml } from "./entity-engine.ts"

/**
 * Create a linkifier function from glossary entities.
 * Returns a function that replaces entity mentions in plain text/HTML strings.
 *
 * Usage:
 * ```typescript
 * import { createLinkifier } from "@bearly/vitepress-enrich/linkify"
 *
 * const linkify = createLinkifier([
 *   { term: "SelectList", href: "/api/select-list", tooltip: "Interactive list" },
 * ])
 *
 * const enriched = linkify("Use SelectList for keyboard navigation")
 * // → 'Use <a href="/api/select-list" class="hover-link" data-tooltip="Interactive list">SelectList</a> for keyboard navigation'
 * ```
 */
export function createLinkifier(entities: GlossaryEntity[]): (text: string) => string {
  const compiled = compileEntities(entities)

  return function linkifyContent(text: string): string {
    if (!text) return text
    return replaceInHtml(text, compiled, new Set())
  }
}
