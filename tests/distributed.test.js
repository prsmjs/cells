import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { createGraph } from "../src/index.js"
import { createClient } from "redis"

const REDIS = { host: "127.0.0.1", port: 6379 }

let cleanupGraphs = []

async function flushRedis() {
  const client = createClient(REDIS)
  client.on("error", () => {})
  await client.connect()
  await client.flushDb()
  await client.quit()
}

async function makeGraph(opts = {}) {
  const g = createGraph({ redis: REDIS, prefix: opts.prefix ?? "test:", ...opts })
  cleanupGraphs.push(g)
  return g
}

describe("distributed mode", () => {
  beforeEach(async () => {
    cleanupGraphs = []
    await flushRedis()
  })

  afterEach(async () => {
    for (const g of cleanupGraphs) {
      await g.destroy().catch(() => {})
    }
  })

  describe("cross-instance value sync", () => {
    it("set on instance A is visible on instance B", async () => {
      const gA = await makeGraph()
      const gB = await makeGraph()

      gA.cell("price", 0)
      gB.cell("price", 0)

      await gA.ready()
      await gB.ready()

      gA.set("price", 100)
      await delay(100)

      expect(gB.value("price")).toBe(100)
    })

    it("both instances converge on rapid updates", async () => {
      const gA = await makeGraph()
      const gB = await makeGraph()

      gA.cell("counter", 0)
      gB.cell("counter", 0)

      await gA.ready()
      await gB.ready()

      gA.set("counter", 1)
      gA.set("counter", 2)
      gA.set("counter", 3)

      await delay(200)

      expect(gB.value("counter")).toBe(3)
    })

    it("restores values from Redis on ready", async () => {
      const gA = await makeGraph()
      gA.cell("data", null)
      await gA.ready()
      gA.set("data", { hello: "world" })
      await delay(50)
      await gA.destroy()

      const gB = await makeGraph()
      gB.cell("data", null)
      await gB.ready()

      expect(gB.value("data")).toEqual({ hello: "world" })
    })
  })

  describe("exactly-once computation", () => {
    it("only one instance computes a derived cell", async () => {
      let computeCountA = 0
      let computeCountB = 0

      const gA = await makeGraph()
      const gB = await makeGraph()

      gA.cell("input", 0)
      gA.cell("derived", ["input"], (v) => {
        computeCountA++
        return v * 10
      })

      gB.cell("input", 0)
      gB.cell("derived", ["input"], (v) => {
        computeCountB++
        return v * 10
      })

      await gA.ready()
      await gB.ready()
      await delay(100)

      computeCountA = 0
      computeCountB = 0

      gA.set("input", 5)
      await delay(300)

      const totalComputes = computeCountA + computeCountB
      expect(totalComputes).toBe(1)

      const derivedA = gA.value("derived")
      const derivedB = gB.value("derived")
      expect(derivedA).toBe(50)
      expect(derivedB).toBe(50)
    })

    it("async computation runs on exactly one instance", async () => {
      let computeCountA = 0
      let computeCountB = 0

      const gA = await makeGraph()
      const gB = await makeGraph()

      gA.cell("input", 0)
      gA.cell("expensive", ["input"], async (v) => {
        computeCountA++
        await delay(50)
        return `result:${v}`
      })

      gB.cell("input", 0)
      gB.cell("expensive", ["input"], async (v) => {
        computeCountB++
        await delay(50)
        return `result:${v}`
      })

      await gA.ready()
      await gB.ready()
      await delay(100)

      computeCountA = 0
      computeCountB = 0

      gA.set("input", 42)
      await delay(500)

      expect(computeCountA + computeCountB).toBe(1)
      expect(gA.value("expensive")).toBe("result:42")
      expect(gB.value("expensive")).toBe("result:42")
    })
  })

  describe("listeners fire on all instances", () => {
    it("g.on fires on both instances when value changes", async () => {
      const valuesA = []
      const valuesB = []

      const gA = await makeGraph()
      const gB = await makeGraph()

      gA.cell("score", 0)
      gB.cell("score", 0)

      gA.on("score", (v) => valuesA.push(v))
      gB.on("score", (v) => valuesB.push(v))

      await gA.ready()
      await gB.ready()

      gA.set("score", 100)
      await delay(200)

      expect(valuesA).toContain(100)
      expect(valuesB).toContain(100)
    })

    it("computed value listeners fire on non-computing instance", async () => {
      const resultsB = []

      const gA = await makeGraph()
      const gB = await makeGraph()

      gA.cell("x", 0)
      gA.cell("doubled", ["x"], (x) => x * 2)

      gB.cell("x", 0)
      gB.cell("doubled", ["x"], (x) => x * 2)

      gB.on("doubled", (v) => resultsB.push(v))

      await gA.ready()
      await gB.ready()
      await delay(50)

      gA.set("x", 7)
      await delay(300)

      expect(resultsB).toContain(14)
    })
  })

  describe("poll lock coordination", () => {
    it("only one instance polls per tick", async () => {
      let pollCountA = 0
      let pollCountB = 0
      let pollValue = 0

      const gA = await makeGraph()
      const gB = await makeGraph()

      gA.cell("polled", 0)
      gB.cell("polled", 0)

      await gA.ready()
      await gB.ready()

      gA.poll("polled", () => { pollCountA++; return ++pollValue }, 200)
      gB.poll("polled", () => { pollCountB++; return ++pollValue }, 200)

      await delay(250)

      const totalPolls = pollCountA + pollCountB
      expect(totalPolls).toBeGreaterThanOrEqual(1)
      expect(totalPolls).toBeLessThanOrEqual(2)

      gA.stop("polled")
      gB.stop("polled")
    })
  })

  describe("multi-level propagation across instances", () => {
    it("chain of computed cells works across instances", async () => {
      const gA = await makeGraph()
      const gB = await makeGraph()

      gA.cell("base", 1)
      gA.cell("step1", ["base"], (b) => b + 10)
      gA.cell("step2", ["step1"], (s) => s * 2)

      gB.cell("base", 1)
      gB.cell("step1", ["base"], (b) => b + 10)
      gB.cell("step2", ["step1"], (s) => s * 2)

      await gA.ready()
      await gB.ready()
      await delay(50)

      gA.set("base", 5)
      await delay(500)

      expect(gA.value("step2")).toBe(30)
      expect(gB.value("step2")).toBe(30)
    })
  })

  describe("snapshot sync", () => {
    it("both instances have the same snapshot", async () => {
      const gA = await makeGraph()
      const gB = await makeGraph()

      gA.cell("a", 0)
      gA.cell("b", 0)
      gA.cell("sum", ["a", "b"], (a, b) => a + b)

      gB.cell("a", 0)
      gB.cell("b", 0)
      gB.cell("sum", ["a", "b"], (a, b) => a + b)

      await gA.ready()
      await gB.ready()
      await delay(50)

      gA.set("a", 10)
      gA.set("b", 20)
      await delay(300)

      const snapA = gA.snapshot()
      const snapB = gB.snapshot()

      expect(snapA.a).toBe(10)
      expect(snapA.b).toBe(20)
      expect(snapA.sum).toBe(30)
      expect(snapB.a).toBe(10)
      expect(snapB.b).toBe(20)
      expect(snapB.sum).toBe(30)
    })
  })
})

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
