import { describe, test, expect, afterEach } from "vitest"
import {
  createTTY,
  type TtydServer,
} from "../../tools/lib/playwright-tty/ttyd-server.js"
import { createServer, type Server } from "net"

// Track resources for cleanup
const ttydServers: TtydServer[] = []
const portHolders: Server[] = []

afterEach(async () => {
  for (const s of ttydServers.splice(0)) await s.close()
  for (const h of portHolders.splice(0)) h.close()
})

/** Occupy a port so ttyd can't bind. Binds 0.0.0.0 to match ttyd's binding. */
function holdPort(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(port, "0.0.0.0", () => {
      portHolders.push(server)
      resolve(server)
    })
  })
}

/** Verify a port is free by briefly binding to it */
async function isPortFree(port: number): Promise<boolean> {
  const server = createServer()
  return new Promise((resolve) => {
    server.once("error", () => resolve(false))
    server.listen(port, "0.0.0.0", () => {
      server.close(() => resolve(true))
    })
  })
}

// Each describe block uses a distinct port range to avoid parallel test conflicts
describe("createTTY", () => {
  describe("startup", () => {
    test("starts on a free port", async () => {
      const tty = createTTY({
        command: ["echo", "hello"],
        portRange: [7750, 7760],
      })
      ttydServers.push(tty)
      await tty.ready

      expect(tty.port).toBeGreaterThanOrEqual(7750)
      expect(tty.port).toBeLessThanOrEqual(7760)
      expect(tty.url).toBe(`http://127.0.0.1:${tty.port}`)
    })

    test("rejects on empty command", async () => {
      const tty = createTTY({ command: [], portRange: [7800, 7810] })
      ttydServers.push(tty)
      await expect(tty.ready).rejects.toThrow("Empty command")
    })
  })

  describe("EADDRINUSE retry", () => {
    test("skips occupied port", async () => {
      await holdPort(7770)

      const tty = createTTY({
        command: ["echo", "hello"],
        portRange: [7770, 7780],
      })
      ttydServers.push(tty)
      await tty.ready

      expect(tty.port).toBeGreaterThan(7770)
    })

    test("skips multiple occupied ports", async () => {
      await holdPort(7780)
      await holdPort(7781)
      await holdPort(7782)

      const tty = createTTY({
        command: ["echo", "hello"],
        portRange: [7780, 7790],
      })
      ttydServers.push(tty)
      await tty.ready

      expect(tty.port).toBeGreaterThanOrEqual(7783)
    })

    test("fails when all ports in range occupied", async () => {
      await holdPort(7890)
      await holdPort(7891)
      await holdPort(7892)

      const tty = createTTY({
        command: ["echo", "hello"],
        portRange: [7890, 7892],
      })
      ttydServers.push(tty)

      await expect(tty.ready).rejects.toThrow(/EADDRINUSE|No free port/)
    })
  })

  describe("shutdown", () => {
    test("close frees the port", async () => {
      const tty = createTTY({
        command: ["sleep", "60"],
        portRange: [7810, 7820],
      })
      ttydServers.push(tty)
      await tty.ready

      const port = tty.port
      await tty.close()

      expect(await isPortFree(port)).toBe(true)
    })

    test("close is idempotent", async () => {
      const tty = createTTY({
        command: ["echo", "hello"],
        portRange: [7820, 7830],
      })
      ttydServers.push(tty)
      await tty.ready

      await tty.close()
      await tty.close() // Should not throw
    })

    test("AsyncDisposable frees port", async () => {
      let port = 0
      {
        await using tty = createTTY({
          command: ["sleep", "60"],
          portRange: [7830, 7840],
        })
        await tty.ready
        port = tty.port
        expect(port).toBeGreaterThanOrEqual(7830)
      }
      expect(await isPortFree(port)).toBe(true)
    })
  })
})
