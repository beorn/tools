/**
 * `@bearly/bounded-queue` — bounded queue with explicit drop policy and
 * always-on O(1) depth gauge.
 *
 * Layer 3 of the silvery memory-observability stack
 * (`@km/silvery/memory-observability-stack`). Coordination primitive, not
 * a reactive data shape — that's why this lives in bearly (alongside
 * `@bearly/tribe-client`, `@bearly/bg-recall`) and not in the `alien-*`
 * family. See `vendor/silvery/docs/lessons/cmux-pty-buffer-firehose.md`
 * (in km root) for the motivating incident and the broader observability
 * picture.
 *
 * Usage:
 *
 * ```ts
 * import { createBoundedQueue } from "@bearly/bounded-queue"
 *
 * const q = createBoundedQueue<string>({
 *   maxDepth: 256,
 *   dropPolicy: "drop-oldest",
 *   gaugeName: "tribe-injects",
 * })
 *
 * q.enqueue("msg-1")
 * q.depth         // 1
 * q.dropCount     // 0
 * q.drain()       // ["msg-1"]; queue empty, depth 0
 *
 * // After overflow:
 * for (let i = 0; i < 300; i++) q.enqueue(`msg-${i}`)
 * q.dropCount     // 44 (300 enqueued − 256 maxDepth, drop-oldest evicts)
 * q.lastDropAt    // epoch ms of most recent eviction
 * ```
 *
 * Design rules (followed throughout):
 *
 * - **Always-on gauge.** `depth`, `dropCount`, `lastDropAt` are plain
 *   numbers updated on every mutation. No reactive wrapping, no background
 *   polling.
 * - **Caller picks `maxDepth`.** No default — the right depth depends on
 *   the consumer's throughput. Forcing the caller to pick keeps capacity
 *   intentional.
 * - **Drop policy is explicit.** No "default sensible behavior" — the
 *   caller chooses `drop-oldest`, `drop-newest`, or `block-until-drained`.
 * - **Zero dependencies.** This is the cheapest possible coordination
 *   primitive; adding deps would invert the dependency direction.
 */

/** Drop policy applied when `enqueue` would exceed `maxDepth`. */
export type DropPolicy =
  | "drop-oldest"
  | "drop-newest"
  | "block-until-drained"

export interface BoundedQueueOptions {
  /** Maximum number of items held before `dropPolicy` fires. Must be ≥ 1. */
  maxDepth: number
  /** What to do when `enqueue` would exceed `maxDepth`. */
  dropPolicy: DropPolicy
  /**
   * Stable, human-readable name for this queue's gauge. Used by
   * diagnostics that aggregate gauges across the process (e.g. a future
   * `SILVERY_STRICT=queue_depth` slug). Pick a unique short string per
   * call site: `"tribe-injects"`, `"recall-channel"`, etc.
   */
  gaugeName: string
  /**
   * Optional clock override — primarily for tests. Defaults to `Date.now`.
   */
  now?: () => number
}

/**
 * Read-only depth gauge surface. Reading these properties is O(1); they
 * are updated synchronously inside `enqueue` / `drain`.
 */
export interface BoundedQueueGauge {
  /** Stable name supplied at construction. */
  readonly gaugeName: string
  /** Current item count in the queue. */
  readonly depth: number
  /**
   * Maximum item count permitted by `maxDepth`. Useful for normalized
   * utilization (`depth / maxDepth`).
   */
  readonly maxDepth: number
  /** Cumulative count of items dropped since construction. */
  readonly dropCount: number
  /**
   * Epoch ms of the most recent drop, or `null` if no drop has occurred.
   * Combined with `dropCount`, lets a watchdog detect "drops happening
   * now" vs "drops happened earlier and stopped."
   */
  readonly lastDropAt: number | null
}

/**
 * Result of an `enqueue` call.
 *
 * - `"accepted"` — the item is now in the queue.
 * - `"dropped-oldest"` — the item is in the queue; the oldest pre-existing
 *   item was evicted to make room.
 * - `"dropped-newest"` — the item itself was dropped; the queue is
 *   unchanged.
 * - `"blocked"` — the caller asked for `block-until-drained` and the queue
 *   is full. The item is NOT enqueued; the caller decides what to do next
 *   (await some external drain signal, retry, give up).
 */
export type EnqueueResult =
  | "accepted"
  | "dropped-oldest"
  | "dropped-newest"
  | "blocked"

export interface BoundedQueue<T> extends BoundedQueueGauge {
  /**
   * Enqueue an item, applying `dropPolicy` if the queue is full. Returns
   * the outcome so callers that care can branch on it.
   */
  enqueue(item: T): EnqueueResult
  /**
   * Drain all currently-held items in FIFO order and return them. Resets
   * `depth` to 0. Does NOT reset `dropCount` / `lastDropAt`.
   */
  drain(): T[]
  /**
   * Peek without removing. Returns a shallow copy in FIFO order.
   */
  peek(): readonly T[]
  /**
   * Reset gauge counters (`dropCount`, `lastDropAt`) — primarily for test
   * harnesses that want fresh state without recreating the queue. Does
   * NOT alter held items.
   */
  resetGauge(): void
}

/**
 * Factory for a bounded queue.
 *
 * Throws `TypeError` if `maxDepth < 1` or if `dropPolicy` is not one of
 * the documented values — these are programmer errors, surfaced eagerly.
 */
export function createBoundedQueue<T>(options: BoundedQueueOptions): BoundedQueue<T> {
  const { maxDepth, dropPolicy, gaugeName } = options
  if (!Number.isInteger(maxDepth) || maxDepth < 1) {
    throw new TypeError(`createBoundedQueue: maxDepth must be a positive integer, got ${String(maxDepth)}`)
  }
  if (
    dropPolicy !== "drop-oldest" &&
    dropPolicy !== "drop-newest" &&
    dropPolicy !== "block-until-drained"
  ) {
    throw new TypeError(
      `createBoundedQueue: dropPolicy must be "drop-oldest" | "drop-newest" | "block-until-drained", got ${String(dropPolicy)}`,
    )
  }
  if (typeof gaugeName !== "string" || gaugeName.length === 0) {
    throw new TypeError(`createBoundedQueue: gaugeName must be a non-empty string`)
  }

  const now = options.now ?? Date.now

  const items: T[] = []
  let dropCount = 0
  let lastDropAt: number | null = null

  function recordDrop(): void {
    dropCount++
    lastDropAt = now()
  }

  function enqueue(item: T): EnqueueResult {
    if (items.length < maxDepth) {
      items.push(item)
      return "accepted"
    }
    switch (dropPolicy) {
      case "drop-oldest":
        items.shift()
        items.push(item)
        recordDrop()
        return "dropped-oldest"
      case "drop-newest":
        recordDrop()
        return "dropped-newest"
      case "block-until-drained":
        return "blocked"
    }
  }

  function drain(): T[] {
    const out = items.slice()
    items.length = 0
    return out
  }

  function peek(): readonly T[] {
    return items.slice()
  }

  function resetGauge(): void {
    dropCount = 0
    lastDropAt = null
  }

  return {
    gaugeName,
    maxDepth,
    get depth() {
      return items.length
    },
    get dropCount() {
      return dropCount
    },
    get lastDropAt() {
      return lastDropAt
    },
    enqueue,
    drain,
    peek,
    resetGauge,
  }
}
