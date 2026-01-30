/**
 * Wikilink Parser
 *
 * Supports common wikilink formats used by Obsidian, Foam, Logseq, Dendron, etc.
 *
 * Formats:
 * - [[note]] - basic wikilink
 * - [[note|alias]] - wikilink with display text
 * - [[note#heading]] - wikilink with heading reference
 * - [[note#heading|alias]] - with heading and alias
 * - [[folder/note]] - with path
 * - ![[embed]] - embed (Obsidian)
 * - [text](path.md) - standard markdown link
 */

export interface WikiLink {
  type: "wikilink" | "embed" | "markdown"
  target: string // The file being linked to (without extension usually)
  heading?: string // Optional heading reference
  alias?: string // Display text (for [[target|alias]] or [alias](target))
  raw: string // Original matched text
  start: number // Byte offset in file
  end: number // Byte offset end
}

// Pattern for [[link]] and ![[embed]] - handles nested brackets carefully
const WIKILINK_PATTERN = /(!?)\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g

// Pattern for [text](path.md) - only matches .md files
const MARKDOWN_LINK_PATTERN = /\[([^\]]+)\]\(([^)]+\.md(?:#[^)]*)?)\)/g

/**
 * Parse all wikilinks from markdown content
 */
export function parseWikiLinks(content: string): WikiLink[] {
  const links: WikiLink[] = []

  // Find wikilinks [[...]] and embeds ![[...]]
  for (const match of content.matchAll(WIKILINK_PATTERN)) {
    const [raw, embed, target, heading, alias] = match
    links.push({
      type: embed === "!" ? "embed" : "wikilink",
      target: target!.trim(),
      heading: heading?.trim(),
      alias: alias?.trim(),
      raw,
      start: match.index!,
      end: match.index! + raw.length,
    })
  }

  // Find markdown links [text](path.md)
  for (const match of content.matchAll(MARKDOWN_LINK_PATTERN)) {
    const [raw, alias, pathWithHeading] = match
    const [path, heading] = pathWithHeading!.split("#")
    links.push({
      type: "markdown",
      target: path!.replace(/\.md$/, ""), // Normalize to name without extension
      heading: heading?.trim(),
      alias: alias!.trim(),
      raw,
      start: match.index!,
      end: match.index! + raw.length,
    })
  }

  // Sort by position
  return links.sort((a, b) => a.start - b.start)
}

/**
 * Check if a wikilink targets a specific file
 *
 * @param link - The parsed wikilink
 * @param targetName - The file name to match (without extension)
 * @param targetPath - Optional full path for path-aware matching
 */
export function linkMatchesTarget(
  link: WikiLink,
  targetName: string,
  targetPath?: string
): boolean {
  const linkTarget = link.target.toLowerCase()
  const name = targetName.toLowerCase()

  // Direct name match
  if (linkTarget === name) return true

  // Path match (folder/note matches note.md in folder/)
  if (targetPath) {
    const normalizedPath = targetPath.toLowerCase().replace(/\.md$/, "")
    if (linkTarget === normalizedPath) return true

    // Check if link is a suffix of the path (e.g., "note" matches "folder/note")
    if (normalizedPath.endsWith("/" + linkTarget)) return true
  }

  return false
}

/**
 * Generate replacement text for a renamed file
 *
 * Preserves:
 * - Link type (wikilink, embed, markdown)
 * - Heading references
 * - Aliases/display text
 */
export function generateReplacement(link: WikiLink, newName: string): string {
  switch (link.type) {
    case "embed": {
      if (link.heading && link.alias) {
        return `![[${newName}#${link.heading}|${link.alias}]]`
      } else if (link.heading) {
        return `![[${newName}#${link.heading}]]`
      } else if (link.alias) {
        return `![[${newName}|${link.alias}]]`
      }
      return `![[${newName}]]`
    }
    case "wikilink": {
      if (link.heading && link.alias) {
        return `[[${newName}#${link.heading}|${link.alias}]]`
      } else if (link.heading) {
        return `[[${newName}#${link.heading}]]`
      } else if (link.alias) {
        return `[[${newName}|${link.alias}]]`
      }
      return `[[${newName}]]`
    }
    case "markdown": {
      const ext = newName.endsWith(".md") ? "" : ".md"
      const path = link.heading ? `${newName}${ext}#${link.heading}` : `${newName}${ext}`
      return `[${link.alias}](${path})`
    }
  }
}
