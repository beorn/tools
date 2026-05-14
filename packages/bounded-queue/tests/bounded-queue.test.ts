import { describe, expect, test } from "vitest"
import { createBoundedQueue } from "../src/index.ts"

describe("createBoundedQueue", () => {
  test("validates maxDepth (must be positive integer)", () => {
    expect(() =>
      createBoundedQueue({ maxDepth: 0, dropPolicy: "drop-oldest", gaugeName: "g" }),
    ).toThrow(TypeError)
    expect(() =>
      createBoundedQueue({ maxDepth: -1, dropPolicy: "drop-oldest", gaugeName: "g" }),
    ).toThrow(TypeError)
    expect(() =>
      createBoundedQueue({ maxDepth: 1.5, dropPolicy: "drop-oldest", gaugeName: "g" }),
    ).toThrow(TypeError)
  })

  test("validates dropPolicy", () => {
    expect(() =>
      createBoundedQueue({
        maxDepth: 4,
        // @ts-expect-error — illegal policy
        dropPolicy: "explode",
        gaugeName: "g",
      }),
    ).toThrow(TypeError)
  })

  test("validates gaugeName (non-empty string)", () => {
    expect(() =>
      createBoundedQueue({ maxDepth: 4, dropPolicy: "drop-oldest", gaugeName: "" }),
    ).toThrow(TypeError)
    expect(() =>
      // @ts-expect-error — wrong type
      createBoundedQueue({ maxDepth: 4, dropPolicy: "drop-oldest", gaugeName: 42 }),
    ).toThrow(TypeError)
  })

  test("accepts items up to maxDepth without dropping", () => {
    const q = createBoundedQueue<string>({
      maxDepth: 3,
      dropPolicy: "drop-oldest",
      gaugeName: "g",
    })
    expect(q.enqueue("a")).toBe("accepted")
    expect(q.enqueue("b")).toBe("accepted")
    expect(q.enqueue("c")).toBe("accepted")
    expect(q.depth).toBe(3)
    expect(q.dropCount).toBe(0)
    expect(q.lastDropAt).toBeNull()
  })

  test("drop-oldest evicts the head when over capacity", () => {
    let clock = 1000
    const q = createBoundedQueue<string>({
      maxDepth: 3,
      dropPolicy: "drop-oldest",
      gaugeName: "g",
      now: () => clock,
    })
    q.enqueue("a")
    q.enqueue("b")
    q.enqueue("c")
    clock = 1234
    expect(q.enqueue("d")).toBe("dropped-oldest")
    expect(q.peek()).toEqual(["b", "c", "d"])
    expect(q.depth).toBe(3)
    expect(q.dropCount).toBe(1)
    expect(q.lastDropAt).toBe(1234)
  })

  test("drop-newest drops the incoming item and keeps the queue intact", () => {
    let clock = 2000
    const q = createBoundedQueue<string>({
      maxDepth: 3,
      dropPolicy: "drop-newest",
      gaugeName: "g",
      now: () => clock,
    })
    q.enqueue("a")
    q.enqueue("b")
    q.enqueue("c")
    clock = 2222
    expect(q.enqueue("d")).toBe("dropped-newest")
    expect(q.peek()).toEqual(["a", "b", "c"])
    expect(q.depth).toBe(3)
    expect(q.dropCount).toBe(1)
    expect(q.lastDropAt).toBe(2222)
  })

  test("block-until-drained returns 'blocked' when full but does NOT count as drop", () => {
    const q = createBoundedQueue<string>({
      maxDepth: 2,
      dropPolicy: "block-until-drained",
      gaugeName: "g",
    })
    q.enqueue("a")
    q.enqueue("b")
    expect(q.enqueue("c")).toBe("blocked")
    expect(q.peek()).toEqual(["a", "b"])
    expect(q.dropCount).toBe(0)
    expect(q.lastDropAt).toBeNull()
  })

  test("block-until-drained accepts again after drain frees capacity", () => {
    const q = createBoundedQueue<string>({
      maxDepth: 2,
      dropPolicy: "block-until-drained",
      gaugeName: "g",
    })
    q.enqueue("a")
    q.enqueue("b")
    expect(q.enqueue("c")).toBe("blocked")
    expect(q.drain()).toEqual(["a", "b"])
    expect(q.depth).toBe(0)
    expect(q.enqueue("c")).toBe("accepted")
    expect(q.peek()).toEqual(["c"])
  })

  test("drain returns items in FIFO order and resets depth", () => {
    const q = createBoundedQueue<number>({
      maxDepth: 5,
      dropPolicy: "drop-oldest",
      gaugeName: "g",
    })
    for (let i = 0; i < 5; i++) q.enqueue(i)
    expect(q.drain()).toEqual([0, 1, 2, 3, 4])
    expect(q.depth).toBe(0)
    expect(q.peek()).toEqual([])
  })

  test("drain does NOT reset dropCount / lastDropAt", () => {
    let clock = 5000
    const q = createBoundedQueue<number>({
      maxDepth: 2,
      dropPolicy: "drop-oldest",
      gaugeName: "g",
      now: () => clock,
    })
    q.enqueue(1)
    q.enqueue(2)
    clock = 5100
    q.enqueue(3) // drops 1
    expect(q.dropCount).toBe(1)
    expect(q.lastDropAt).toBe(5100)
    q.drain()
    expect(q.dropCount).toBe(1)
    expect(q.lastDropAt).toBe(5100)
  })

  test("resetGauge clears counters but leaves held items intact", () => {
    let clock = 10_000
    const q = createBoundedQueue<number>({
      maxDepth: 2,
      dropPolicy: "drop-oldest",
      gaugeName: "g",
      now: () => clock,
    })
    q.enqueue(1)
    q.enqueue(2)
    clock = 10_100
    q.enqueue(3)
    expect(q.dropCount).toBe(1)
    q.resetGauge()
    expect(q.dropCount).toBe(0)
    expect(q.lastDropAt).toBeNull()
    expect(q.depth).toBe(2)
    expect(q.peek()).toEqual([2, 3])
  })

  test("cumulative dropCount across many overflows (300 enqueues, maxDepth 256)", () => {
    const q = createBoundedQueue<number>({
      maxDepth: 256,
      dropPolicy: "drop-oldest",
      gaugeName: "tribe-injects",
    })
    for (let i = 0; i < 300; i++) q.enqueue(i)
    expect(q.depth).toBe(256)
    expect(q.dropCount).toBe(300 - 256)
    expect(q.peek()[0]).toBe(300 - 256) // first surviving item
    expect(q.peek()[255]).toBe(299) // last enqueued item
  })

  test("gaugeName + maxDepth are exposed as read-only props", () => {
    const q = createBoundedQueue<number>({
      maxDepth: 8,
      dropPolicy: "drop-newest",
      gaugeName: "recall-channel",
    })
    expect(q.gaugeName).toBe("recall-channel")
    expect(q.maxDepth).toBe(8)
  })
})
