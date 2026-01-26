import { z } from "zod"

// Symbol found at a location
export const SymbolInfo = z.object({
  symbolKey: z.string(), // stable ID: "file:line:col:name"
  name: z.string(),
  kind: z.enum(["variable", "function", "type", "interface", "property", "class", "method", "parameter"]),
  file: z.string(),
  line: z.number(),
  column: z.number(),
})
export type SymbolInfo = z.infer<typeof SymbolInfo>

// A reference to a symbol
export const Reference = z.object({
  refId: z.string(), // stable ID: hash(file + range)
  file: z.string(),
  range: z.tuple([z.number(), z.number(), z.number(), z.number()]), // [startLine, startCol, endLine, endCol]
  preview: z.string(), // context line
  checksum: z.string(), // file checksum at proposal time
  selected: z.boolean().default(true),
})
export type Reference = z.infer<typeof Reference>

// A single edit operation
export const Edit = z.object({
  file: z.string(),
  offset: z.number(), // byte offset
  length: z.number(), // bytes to replace
  replacement: z.string(),
})
export type Edit = z.infer<typeof Edit>

// Complete editset (rename proposal)
export const Editset = z.object({
  id: z.string(), // "rename-widget-to-gadget-1706000000"
  operation: z.literal("rename"),
  symbolKey: z.string().optional(), // for single-symbol renames
  pattern: z.string().optional(), // for batch renames
  from: z.string(),
  to: z.string(),
  refs: z.array(Reference),
  edits: z.array(Edit),
  createdAt: z.string(),
})
export type Editset = z.infer<typeof Editset>

// Symbol discovery result (for batch operations)
export const SymbolMatch = z.object({
  symbolKey: z.string(),
  name: z.string(),
  kind: z.string(),
  file: z.string(),
  line: z.number(),
  refCount: z.number(),
})
export type SymbolMatch = z.infer<typeof SymbolMatch>

// Command outputs
export const SymbolAtOutput = SymbolInfo
export type SymbolAtOutput = SymbolInfo

export const RefsListOutput = z.array(Reference.omit({ selected: true }))
export type RefsListOutput = z.infer<typeof RefsListOutput>

export const ProposeOutput = z.object({
  editsetPath: z.string(),
  refCount: z.number(),
  fileCount: z.number(),
  symbolCount: z.number().optional(), // for batch renames
})
export type ProposeOutput = z.infer<typeof ProposeOutput>

export const ApplyOutput = z.object({
  applied: z.number(),
  skipped: z.number(),
  driftDetected: z.array(
    z.object({
      file: z.string(),
      reason: z.string(),
    })
  ),
})
export type ApplyOutput = z.infer<typeof ApplyOutput>

export const SymbolsFindOutput = z.array(SymbolMatch)
export type SymbolsFindOutput = z.infer<typeof SymbolsFindOutput>

// Conflict detection for batch renames
export const Conflict = z.object({
  from: z.string(), // original name
  to: z.string(), // proposed new name
  existingSymbol: z.string(), // symbolKey of conflicting existing symbol
  suggestion: z.string(), // suggested resolution
})
export type Conflict = z.infer<typeof Conflict>

export const SafeRename = z.object({
  from: z.string(),
  to: z.string(),
})
export type SafeRename = z.infer<typeof SafeRename>

export const ConflictReport = z.object({
  conflicts: z.array(Conflict),
  safe: z.array(SafeRename),
})
export type ConflictReport = z.infer<typeof ConflictReport>
