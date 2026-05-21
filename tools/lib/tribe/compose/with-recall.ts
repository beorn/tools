/**
 * withRecall — initialise the recall (memory + history) handlers.
 *
 * Recall was a separate "lore" daemon until April 2026; absorbed into
 * tribe-daemon as in-process handlers. Each recall handler runs synchronously
 * on the same event loop. The recall DB is opened here and closed via the
 * root scope.
 */

import { createRecallHandlers, type RecallHandlers } from "../recall-handlers.ts"
import type { BaseTribe } from "./base.ts"
import type { WithConfig } from "./with-config.ts"

export interface WithRecall {
  /** null when --no-recall is set (or TRIBE_NO_RECALL in env). */
  readonly recall: RecallHandlers | null
}

export function withRecall<T extends BaseTribe & WithConfig>(): (t: T) => T & WithRecall {
  return (t) => {
    if (!t.config.recallEnabled) return { ...t, recall: null }

    const recall = createRecallHandlers({
      dbPath: t.config.recallDbPath,
      socketPath: t.config.socketPath,
      daemonVersion: t.daemonVersion,
      focusPollMs: t.config.focusPollMs,
      summaryPollMs: t.config.summaryPollMs,
      summarizerMode: t.config.summarizerMode,
      // Pass the scope's signal so recall aborts on shutdown.
      signal: t.scope.signal,
    })

    // Belt-and-braces: register an explicit close on the scope too. close() is
    // idempotent (gated by an internal `closed` flag) so the signal-driven
    // path and this defer-driven path are safe to coexist.
    t.scope.defer(() => recall.close())

    return { ...t, recall }
  }
}
