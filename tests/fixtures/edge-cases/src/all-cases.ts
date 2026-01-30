/**
 * Comprehensive test fixture for all edge cases discovered during batch refactoring.
 * Each section tests a specific bug that was discovered.
 *
 * Run `bun tools/refactor.ts symbols.find --pattern widget` from plugins/batch/
 * to verify all symbols are found correctly.
 */

// =============================================================================
// Bug 1: Local Variables Inside Functions
// Problem: getVariableDeclarations() only returns top-level, misses function-local
// Fix: Use forEachDescendant() to find all VariableDeclaration nodes
// =============================================================================

// Top-level (baseline - always found)
export const topLevelWidget = "widget"

export function processWidget() {
  // Bug 1: Must find these local variables
  const widgetRoot = "/path/to/widget"
  const widgetPath = widgetRoot + "/data"

  function nested() {
    // Bug 1: Must find nested function locals too
    const widgetDir = widgetRoot
    return widgetDir
  }

  return { widgetPath, nested }
}

// =============================================================================
// Bug 2: Destructuring Patterns
// Problem: varDecl.getName() returns entire pattern "{ widgetDir, widgetName }"
// Fix: Check isIdentifier, extract BindingElements for patterns
// =============================================================================

interface WidgetConfig {
  widgetDir: string
  widgetName: string
}

const config: WidgetConfig = { widgetDir: "/path", widgetName: "test" }

// Bug 2: Object destructuring - must find individual identifiers
const { widgetDir, widgetName } = config

// Bug 2: Array destructuring
const widgetItems = ["item1", "item2"]
const [firstWidgetItem, secondWidgetItem] = widgetItems

// Bug 2: Nested/renamed destructuring - only rename the binding, not property
const { widgetDir: renamedWidgetDir } = config

// Usage after destructuring (refs should be found)
console.log(widgetDir, widgetName, firstWidgetItem, renamedWidgetDir)

// =============================================================================
// Bug 3: Parameter Destructuring
// Problem: Parameters use ParameterDeclaration, not VariableDeclaration
// Fix: Handle both node types with same binding extraction logic
// =============================================================================

interface Context {
  widgetPath: string
  widgetRoot: string
}

// Bug 3: Arrow function with destructured parameter
export const processContext = ({ widgetPath, widgetRoot }: Context) => {
  // widgetPath usage inside must be renamed too
  console.log(widgetPath)
  return widgetRoot
}

// Bug 3: Regular function with destructured parameter
export function handleContext({ widgetPath }: Context) {
  return widgetPath
}

// Bug 3: Async arrow function
export const asyncProcess = async ({ widgetPath }: Context) => {
  await Promise.resolve(widgetPath)
}

// Bug 3: Callback with destructured params
const items = [{ widgetPath: "/a" }, { widgetPath: "/b" }]
items.forEach(({ widgetPath }) => {
  console.log(widgetPath)
})

// =============================================================================
// Bug 4: Partial Migration State (Conflict Detection)
// Problem: Both old (widget*) and new (gadget*) names exist - conflict explosion
// Note: This tests conflict DETECTION, not renaming
// =============================================================================

// Old names (would be renamed)
const widgetStorage = "/old/path"
const widgetDatabase = "/old/db"

// New names ALREADY EXIST (conflict detection should flag these)
const gadgetStorage = "/new/path" // Conflict with widgetStorage → gadgetStorage
const gadgetDatabase = "/new/db" // Conflict with widgetDatabase → gadgetDatabase

// Function that uses both old and new
function migrate() {
  // Renaming widgetStorage → gadgetStorage would shadow/conflict
  console.log(widgetStorage, gadgetStorage)
  console.log(widgetDatabase, gadgetDatabase)
}

// Local scope conflict
function localConflict() {
  const widgetLocal = "old"
  const gadgetLocal = "new" // Local conflict
  return { widgetLocal, gadgetLocal }
}

// =============================================================================
// Additional Edge Cases
// =============================================================================

// Type alias with widget
export type WidgetState = {
  isWidgetOpen: boolean
  widgetId: string
}

// Interface property
export interface WidgetManager {
  openWidget(path: string): void
  closeWidget(): void
}

// Class with widget members
export class WidgetService {
  private widgetPath: string

  constructor(widgetPath: string) {
    this.widgetPath = widgetPath
  }

  getWidgetPath(): string {
    return this.widgetPath
  }
}

// Export to prevent unused warnings
export {
  widgetDir,
  widgetName,
  firstWidgetItem,
  secondWidgetItem,
  renamedWidgetDir,
  widgetStorage,
  widgetDatabase,
  gadgetStorage,
  gadgetDatabase,
  migrate,
  localConflict,
}
