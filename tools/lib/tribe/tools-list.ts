/**
 * Tribe MCP tools list — tool definitions for ListToolsRequest.
 *
 * Public coordination surface:
 *   tribe.send, tribe.fetch, tribe.members, tribe.filter, tribe.join.
 * Admin/diagnostic verbs remain separate.
 */

export const TOOLS_LIST = [
  {
    name: "send",
    description: 'Send a message to one tribe member, or to everyone with to: "*".',
    inputSchema: {
      type: "object" as const,
      properties: {
        to: { type: "string", description: 'Recipient session name, or "*" for broadcast' },
        message: { type: "string", description: "Message content" },
        type: {
          type: "string",
          description: "Message type",
          enum: ["assign", "status", "query", "response", "notify", "request", "verdict"],
          default: "notify",
        },
        bead: { type: "string", description: "Associated bead ID (optional)" },
        ref: { type: "string", description: "Reference to a previous message ID (optional)" },
      },
      required: ["to", "message"],
    },
  },
  {
    name: "fetch",
    description:
      "Read tribe messages. Default drains this session's pending queue and advances its cursor. ids/with/from/to reads are snapshots. since scans the journal and advances only with advance:true.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Fetch specific message IDs without advancing the cursor.",
        },
        topics: {
          type: "array",
          items: { type: "string" },
          description: "Optional topic globs, e.g. ['github:*', 'git:commit'].",
        },
        since: {
          type: "number",
          description: "Scan rows with rowid > since. Default mode uses the session cursor.",
        },
        with: { type: "string", description: "Bilateral history with this session name." },
        from: { type: "string", description: "One-sided history from this sender." },
        to: { type: "string", description: "One-sided history to this recipient." },
        limit: { type: "number", description: "Max rows to return (default 50, max 500)." },
        advance: {
          type: "boolean",
          description: "Advance the session cursor after a since/default scan. Default: true only for default drain.",
        },
      },
    },
  },
  {
    name: "members",
    description: "List active tribe sessions with their roles and domains",
    inputSchema: {
      type: "object" as const,
      properties: {
        all: { type: "boolean", description: "Include dead sessions (default: false)" },
      },
    },
  },
  {
    name: "rename",
    description: "Rename this session in the tribe",
    inputSchema: {
      type: "object" as const,
      properties: {
        new_name: { type: "string", description: "New session name" },
      },
      required: ["new_name"],
    },
  },
  {
    name: "health",
    description: "Diagnostic: check for silent members, stale beads, unread messages",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "join",
    description: "Re-announce this session's name, role, and domains after compaction or rejoin.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Session name" },
        role: {
          type: "string",
          description: "Session role. 'chief' = coordinator, 'member' = default worker, 'watch' = read-only observer.",
          enum: ["chief", "member", "watch"],
        },
        domains: {
          type: "array",
          items: { type: "string" },
          description: "Domain expertise areas, e.g. ['silvery', 'flexily'].",
        },
        delivery: {
          type: "string",
          description:
            "How this session consumes messages. 'push' sends channel notifications. 'pull' queues rows for tribe.fetch. Sender is transport-blind.",
          enum: ["push", "pull"],
        },
      },
      required: ["name", "role"],
    },
  },
  {
    name: "reload",
    description:
      "Hot-reload the tribe MCP server — re-exec with latest code from disk. Use after tribe code is updated to pick up fixes without restarting the Claude Code session.",
    inputSchema: {
      type: "object" as const,
      properties: {
        reason: { type: "string", description: "Why the reload is needed (logged to events)" },
      },
    },
  },
  {
    name: "retro",
    description:
      "Generate a retrospective report analyzing tribe message history, coordination health, and per-member activity",
    inputSchema: {
      type: "object" as const,
      properties: {
        since: {
          type: "string",
          description: 'Duration to look back (e.g. "2h", "30m", "1d"). Default: entire session.',
        },
        format: {
          type: "string",
          description: "Output format",
          enum: ["markdown", "json"],
          default: "markdown",
        },
      },
    },
  },
  {
    name: "chief",
    description: "Show the current chief — derived from connection order, or explicitly claimed via tribe.claim-chief.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "debug",
    description:
      "Dump daemon internals for troubleshooting — clients, chief derivation, chief claim, per-session cursors.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "claim-chief",
    description:
      "Claim the chief role explicitly. Idempotent. Overrides the default connection-order derivation until released.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "release-chief",
    description:
      "Release an explicit chief claim, letting the role fall back to connection-order derivation. Idempotent.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "filter",
    description:
      "Per-session filter for incoming channel events. mode controls focus level; mute stores topic globs to silence until the optional timestamp. Empty args clears the filter.",
    inputSchema: {
      type: "object" as const,
      properties: {
        mode: {
          type: "string",
          enum: ["focus", "normal", "ambient"],
          description: "Persistent filter mode. Defaults to 'normal' when args are empty.",
        },
        mute: {
          type: "array",
          items: { type: "string" },
          description: "Optional topic globs to silence, e.g. ['github:*'].",
        },
        until: {
          type: "number",
          description: "Optional unix-ms timestamp at which mute expires. Absent = persistent.",
        },
      },
      required: [],
    },
  },
]
