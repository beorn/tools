/**
 * recallTools() — protocol-agnostic ToolDef array for the lore (memory + recall)
 * RPC surface (tribe.ask / brief / plan / session_register / session_heartbeat
 * / sessions_list / workspace_state / session_state / inject_delta / status /
 * hello).
 *
 * The lore handlers expose a clean `dispatch(conn, method, params)` shape from
 * day one. This wrapper exposes each method as a registry tool so the same
 * surface (MCP server, raw JSON-RPC, future protocols) reaches them through
 * the registry rather than the special-case `recallHandlers.dispatch` path
 * tribe-daemon's handleRequest had before.
 */

import type { Tool, ToolContext } from "@bearly/tribe-client"
import { TRIBE_METHODS } from "../../../../plugins/tribe/recall/lib/rpc.ts"
import type { RecallConnState, RecallHandlers } from "../recall-handlers.ts"

export interface RecallToolExtra {
  /** Per-connection lore state (sessionId / claudePid). */
  conn: RecallConnState
}

const RECALL_METHOD_NAMES = Object.values(TRIBE_METHODS) as readonly string[]

export function recallTools(lore: RecallHandlers): Tool[] {
  return RECALL_METHOD_NAMES.map((name) => ({
    name,
    handler: async (args, ctx: ToolContext) => {
      const extra = ctx.extra as RecallToolExtra | undefined
      const conn: RecallConnState = extra?.conn ?? { sessionId: null, claudePid: null }
      return lore.dispatch(conn, name, args)
    },
  }))
}
