# @bearly/bounded-queue

Coordination primitive — a bounded queue with an explicit drop policy and an always-on O(1) depth gauge.

Layer 3 of the silvery memory-observability stack. Sibling to `@bearly/tribe-client` and `@bearly/bg-recall`. Not part of the `alien-*` family — the queue is a coordination primitive, not a reactive data shape, so it lives in bearly alongside the other Claude Code coordination utilities.

## Quick start

```ts
import { createBoundedQueue } from "@bearly/bounded-queue"

const q = createBoundedQueue<string>({
  maxDepth: 256,
  dropPolicy: "drop-oldest",
  gaugeName: "tribe-injects",
})

q.enqueue("msg-1")
q.depth // 1
q.dropCount // 0
q.lastDropAt // null

q.drain() // ["msg-1"]; queue empty
```

## API

### `createBoundedQueue<T>(options)`

- `maxDepth` — positive integer. Capacity ceiling. Throws on `< 1` or non-integer.
- `dropPolicy` — what happens when `enqueue` would exceed `maxDepth`:
  - `"drop-oldest"` — evict the head; enqueue succeeds; `dropCount++`.
  - `"drop-newest"` — refuse the new item; queue unchanged; `dropCount++`.
  - `"block-until-drained"` — refuse the new item; `dropCount` unchanged. Caller is expected to retry after a `drain()`.
- `gaugeName` — non-empty string used by diagnostics that aggregate queue gauges across the process. Pick a stable short identifier per call site (`"tribe-injects"`, `"recall-channel"`).
- `now` — clock override, primarily for tests.

Returns a `BoundedQueue<T>` with:

- `enqueue(item) → "accepted" | "dropped-oldest" | "dropped-newest" | "blocked"`
- `drain() → T[]` — FIFO; resets depth, leaves `dropCount` / `lastDropAt` intact.
- `peek() → readonly T[]` — non-destructive copy in FIFO order.
- `resetGauge()` — clear `dropCount` / `lastDropAt`. Does NOT alter held items.
- `gaugeName`, `maxDepth`, `depth`, `dropCount`, `lastDropAt` — read-only gauge surface.

All gauge reads are O(1) and synchronous. No background polling, no reactive wrapping.

## When to use which drop policy

| Policy                | Use when                                                            | Trade-off                                                      |
| --------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------- |
| `drop-oldest`         | Latest data is most valuable (rendering, telemetry, log injection). | Loses history under sustained overload.                        |
| `drop-newest`         | History is canonical (audit logs, event sourcing).                  | New events silently disappear under sustained overload.        |
| `block-until-drained` | Caller has a clear drain signal (consumer-driven flow control).     | Caller must handle `"blocked"` explicitly — no implicit retry. |

## Why this lives in bearly (not `alien-*`)

The `alien-*` family is "signals for a specific shape of data" — value, list, async, tree — built on `alien-signals` peer dependency and reactive subscriptions. A bounded queue is a mutation-discipline primitive: backpressure, drop policy, depth gauge. The depth gauge is read directly (`q.depth`), not as a reactive `computed()`. Forcing the `alien-signals` peer dep on tribe + recall — neither of which consumes signals today — inverts the dependency direction for cosmetic family membership.

If a consumer wants a reactive depth gauge, they can wrap the read in their preferred reactive primitive:

```ts
import { signal } from "alien-signals"
const depthSig = signal(0)
// inside the consumer's enqueue path:
q.enqueue(item)
depthSig.set(q.depth)
```

Reactivity stays opt-in, not baked in.

## Discoverability

Reach for `@bearly/bounded-queue` when you want a **coordination queue with backpressure**. Reach for `alien-projections` / `alien-resources` / `alien-trees` when your data has a **specific reactive shape** that benefits from signal-driven derivation.

## License

MIT
