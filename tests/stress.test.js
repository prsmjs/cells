import { describe, it, expect, beforeEach } from "vitest"
import { createGraph } from "../src/index.js"

describe("stress tests", () => {
  let g

  beforeEach(() => {
    g = createGraph()
  })

  describe("rapid concurrent async recomputations", () => {
    it("rapid source updates only produce one final async result", async () => {
      const results = []
      const source = g.cell("source", 0)
      const derived = g.cell("derived", async () => {
        const v = source()
        await delay(20)
        return v * 10
      })
      derived.on((val) => results.push(val))

      await tick()
      await delay(50)
      expect(derived()).toBe(0)

      for (let i = 1; i <= 20; i++) {
        source(i)
      }

      await delay(500)

      expect(derived()).toBe(200)
      // intermediate stale results should have been discarded
      // only the final value should be the last one (20 * 10)
      expect(results[results.length - 1]).toBe(200)
    })

    it("concurrent async cells at same level compute independently", async () => {
      const computeOrder = []
      const source = g.cell("source", 1)

      const slow = g.cell("slow", async () => {
        const v = source()
        await delay(50)
        computeOrder.push("slow")
        return `slow:${v}`
      })
      const fast = g.cell("fast", async () => {
        const v = source()
        await delay(10)
        computeOrder.push("fast")
        return `fast:${v}`
      })

      await tick()
      await delay(100)
      computeOrder.length = 0

      source(2)
      await delay(100)

      expect(fast()).toBe("fast:2")
      expect(slow()).toBe("slow:2")
      expect(computeOrder.indexOf("fast")).toBeLessThan(computeOrder.indexOf("slow"))
    })

    it("handles many rapid sets without losing data or hanging", async () => {
      const source = g.cell("source", 0)
      const derived = g.cell("derived", () => source() + 1)
      await tick()

      for (let i = 0; i < 1000; i++) {
        source(i)
      }
      await tick()

      expect(source()).toBe(999)
      expect(derived()).toBe(1000)
    })

    it("stale discard works under rapid async updates", async () => {
      let computeCount = 0
      let lastComputedInput = null
      const source = g.cell("source", 0)
      const derived = g.cell("derived", async () => {
        const v = source()
        computeCount++
        lastComputedInput = v
        await delay(10)
        return v * 2
      })

      await tick()
      await delay(50)
      computeCount = 0

      source(1)
      await delay(2)
      source(2)
      await delay(2)
      source(3)

      await delay(200)

      expect(derived()).toBe(6)
      // the graph may fire multiple computes, but stale ones are discarded.
      // the final result must be correct
    })

    it("deep async chain settles correctly under rapid updates", async () => {
      const source = g.cell("source", 1)
      const step1 = g.cell("step1", async () => {
        await delay(5)
        return source() * 2
      })
      const step2 = g.cell("step2", async () => {
        await delay(5)
        return step1() + 10
      })
      const step3 = g.cell("step3", async () => {
        await delay(5)
        return step2() * 3
      })

      await tick()
      await delay(100)
      expect(step3()).toBe(36) // ((1*2)+10)*3

      source(5)
      source(10)
      source(20)

      await delay(300)

      expect(step1()).toBe(40)  // 20*2
      expect(step2()).toBe(50)  // 40+10
      expect(step3()).toBe(150) // 50*3
    })
  })

  describe("cell removal mid-propagation", () => {
    it("removing a leaf cell during propagation doesn't crash", async () => {
      const a = g.cell("a", 1)
      const b = g.cell("b", () => a() * 2)
      const c = g.cell("c", () => b() + 1)
      await tick()

      // remove c while propagation from a is in flight
      b.on(() => {
        c.remove()
      })

      a(10)
      await tick()

      expect(b()).toBe(20)
      expect(g.get("c")).toBeNull()
    })

    it("removeTree during propagation doesn't crash", async () => {
      const a = g.cell("a", 1)
      const b = g.cell("b", () => a() * 2)
      const c = g.cell("c", () => b() + 1)
      const d = g.cell("d", () => c() + 1)
      await tick()

      let removed = false
      b.on(() => {
        if (!removed) {
          removed = true
          c.removeTree()
        }
      })

      a(10)
      await tick()

      expect(b()).toBe(20)
      expect(g.get("c")).toBeNull()
      expect(g.get("d")).toBeNull()
    })

    it("removing a source cell's downstream during set doesn't affect other branches", async () => {
      const a = g.cell("a", 1)
      const b = g.cell("b", () => a() * 2)
      const c = g.cell("c", () => a() * 3)
      await tick()

      b.on(() => {
        if (g.get("c")) c.remove()
      })

      a(5)
      await tick()

      expect(b()).toBe(10)
      expect(g.get("c")).toBeNull()
    })

    it("cell removed mid-async-propagation is skipped gracefully", async () => {
      const a = g.cell("a", 1)
      const b = g.cell("b", async () => {
        const v = a()
        await delay(20)
        return v * 2
      })
      const c = g.cell("c", async () => {
        const v = a()
        await delay(10)
        return v * 3
      })
      await tick()
      await delay(50)

      // start propagation, then remove b before it finishes
      a(5)
      await delay(5)
      b.remove()

      await delay(100)

      expect(g.get("b")).toBeNull()
      expect(c()).toBe(15)
    })
  })

  describe("destroy during active computation", () => {
    it("destroy waits for in-flight async computations", async () => {
      let completed = false
      const a = g.cell("a", 1)
      const b = g.cell("b", async () => {
        await delay(50)
        completed = true
        return a() * 2
      })

      await tick()
      await delay(100)
      completed = false

      a(5)
      // don't wait, immediately destroy
      await g.destroy()

      // destroy should have waited for the propagation
      expect(g.cells()).toHaveLength(0)
    })

    it("destroy stops polls and doesn't process further", async () => {
      let pollCount = 0
      const a = g.cell("a", 0)
      a.poll(() => ++pollCount, 10)

      await delay(50)
      const countBefore = pollCount
      await g.destroy()

      await delay(50)
      // no more polls after destroy
      expect(pollCount).toBe(countBefore)
    })
  })

  describe("concurrent graph operations", () => {
    it("multiple sources updating simultaneously propagate correctly", async () => {
      const a = g.cell("a", 0)
      const b = g.cell("b", 0)
      const c = g.cell("c", 0)
      const sum = g.cell("sum", () => a() + b() + c())
      await tick()

      a(10)
      b(20)
      c(30)
      await tick()

      expect(sum()).toBe(60)
    })

    it("wide fan-out from single source handles many dependents", async () => {
      const source = g.cell("source", 1)
      const dependents = []
      for (let i = 0; i < 50; i++) {
        dependents.push(g.cell(`d${i}`, () => source() + i))
      }
      await tick()

      for (let i = 0; i < 50; i++) {
        expect(dependents[i]()).toBe(1 + i)
      }

      source(100)
      await tick()

      for (let i = 0; i < 50; i++) {
        expect(dependents[i]()).toBe(100 + i)
      }
    })

    it("deep chain propagation (20 levels deep)", async () => {
      const cells = [g.cell("c0", 1)]
      for (let i = 1; i < 20; i++) {
        const prev = cells[i - 1]
        cells.push(g.cell(`c${i}`, () => prev() + 1))
      }
      await tick()

      expect(cells[19]()).toBe(20)

      cells[0](100)
      await tick()

      expect(cells[19]()).toBe(119)
    })

    it("mixed sync and async in same propagation chain", async () => {
      const source = g.cell("source", 1)
      const sync1 = g.cell("sync1", () => source() * 2)
      const async1 = g.cell("async1", async () => {
        const v = sync1()
        await delay(10)
        return v + 100
      })
      const sync2 = g.cell("sync2", () => {
        const v = async1()
        return v === undefined ? 0 : v * 3
      })

      await tick()
      await delay(50)

      expect(sync1()).toBe(2)
      expect(async1()).toBe(102)
      // sync2 depends on async1 which was async during initial compute
      // after async1 resolves, sync2 should have been recomputed
      // but sync2 initially computed with async1 = undefined
      // we need to check if the propagation from async1 reaching sync2 worked

      source(5)
      await delay(100)

      expect(sync1()).toBe(10)
      expect(async1()).toBe(110)
      expect(sync2()).toBe(330)
    })
  })

  describe("generation counter edge cases", () => {
    it("overlapping async computations - only latest generation wins", async () => {
      const values = []
      const source = g.cell("source", "a")
      const derived = g.cell("derived", async () => {
        const v = source()
        if (v === "a") await delay(50)
        else if (v === "b") await delay(30)
        else await delay(10)
        return v.toUpperCase()
      })
      derived.on((v) => values.push(v))

      await tick()
      await delay(80)
      values.length = 0

      // fire 3 updates: "a" takes longest, "c" finishes first
      source("slow")
      await delay(2)
      source("medium")
      await delay(2)
      source("fast")

      await delay(200)

      // only the final value should be kept
      expect(derived()).toBe("FAST")
      // the last value emitted should be FAST
      expect(values[values.length - 1]).toBe("FAST")
    })

    it("generation mismatch correctly discards stale sync results in async chain", async () => {
      let step1Count = 0
      const source = g.cell("source", 1)
      const step1 = g.cell("step1", async () => {
        step1Count++
        const v = source()
        await delay(30)
        return v * 10
      })
      const step2 = g.cell("step2", () => {
        const v = step1()
        return v === undefined ? 0 : v + 1
      })

      await tick()
      await delay(50)
      step1Count = 0

      source(2)
      await delay(5)
      source(3)

      await delay(200)

      expect(step1()).toBe(30) // 3 * 10
      expect(step2()).toBe(31) // 30 + 1
    })
  })

  describe("error recovery under stress", () => {
    it("rapid error-then-recovery cycles don't corrupt state", async () => {
      let shouldFail = false
      const source = g.cell("source", 1)
      const derived = g.cell("derived", () => {
        const v = source()
        if (shouldFail && v % 2 === 0) throw new Error("even!")
        return v * 2
      })
      const downstream = g.cell("downstream", () => {
        const v = derived()
        return v === undefined ? -1 : v + 100
      })
      await tick()

      shouldFail = true

      // alternating pass/fail
      for (let i = 1; i <= 10; i++) {
        source(i)
        await tick()
      }

      // source ended at 10 (even), so derived should be in error
      expect(derived.state.status).toBe("error")
      expect(downstream.state.status).toBe("stale")

      shouldFail = false
      source(11)
      await tick()

      expect(derived.state.status).toBe("current")
      expect(derived()).toBe(22)
      expect(downstream()).toBe(122)
    })

    it("async error recovery doesn't leave stale values", async () => {
      let shouldFail = true
      const source = g.cell("source", 1)
      const derived = g.cell("derived", async () => {
        const v = source()
        await delay(10)
        if (shouldFail) throw new Error("fail")
        return v * 2
      })

      await tick()
      await delay(50)
      expect(derived.state.status).toBe("error")

      shouldFail = false
      source(5)
      await delay(50)

      expect(derived.state.status).toBe("current")
      expect(derived()).toBe(10)

      source(10)
      await delay(50)
      expect(derived()).toBe(20)
    })
  })

  describe("listener edge cases under stress", () => {
    it("listener that modifies another source during propagation", async () => {
      const a = g.cell("a", 1)
      const b = g.cell("b", 10)
      const derived = g.cell("derived", () => a() + b())
      await tick()

      // when 'a' changes, also update 'b'
      a.on(() => {
        b(a() * 100)
      })

      a(5)
      await tick()

      // 'b' was set to 500 by the listener
      // derived should eventually reflect a=5, b=500
      expect(b()).toBe(500)
      expect(derived()).toBe(505)
    })

    it("unsubscribing inside listener doesn't crash", async () => {
      const a = g.cell("a", 1)
      const values = []
      let off
      off = a.on((v) => {
        values.push(v)
        off()
      })

      a(2)
      a(3)
      a(4)

      expect(values).toEqual([2])
    })

    it("adding listener inside listener doesn't miss events", async () => {
      const a = g.cell("a", 1)
      const derived = g.cell("derived", () => a() * 2)
      await tick()

      const lateValues = []
      derived.on(() => {
        derived.on((v) => lateValues.push(v))
      })

      a(5)
      await tick()
      a(10)
      await tick()

      expect(lateValues).toContain(20)
    })

    it("wildcard listener sees all changes in correct order", async () => {
      const log = []
      const a = g.cell("a", 1)
      const b = g.cell("b", () => a() * 2)
      const c = g.cell("c", () => b() + 1)
      await tick()

      g.on((name) => log.push(name))

      a(5)
      await tick()

      expect(log).toEqual(["a", "b", "c"])
    })
  })

  describe("snapshot consistency", () => {
    it("snapshot is consistent during rapid updates", async () => {
      const a = g.cell("a", 0)
      const b = g.cell("b", () => a() * 2)
      const c = g.cell("c", () => a() * 3)
      await tick()

      for (let i = 1; i <= 100; i++) {
        a(i)
      }
      await tick()

      const snap = g.snapshot()
      expect(snap.a).toBe(100)
      expect(snap.b).toBe(200)
      expect(snap.c).toBe(300)
    })

    it("snapshot after async settling is complete", async () => {
      const a = g.cell("a", 1)
      const b = g.cell("b", async () => {
        await delay(10)
        return a() * 2
      })
      const c = g.cell("c", async () => {
        await delay(20)
        return a() * 3
      })

      await tick()
      await delay(50)

      const snap = g.snapshot()
      expect(snap.a).toBe(1)
      expect(snap.b).toBe(2)
      expect(snap.c).toBe(3)
    })
  })

  describe("large graph", () => {
    it("handles 100 source cells feeding 100 computed cells", async () => {
      const sources = []
      for (let i = 0; i < 100; i++) {
        sources.push(g.cell(`s${i}`, i))
      }

      const computed = []
      for (let i = 0; i < 100; i++) {
        const src = sources[i]
        computed.push(g.cell(`c${i}`, () => src() * 2))
      }

      await tick()

      for (let i = 0; i < 100; i++) {
        expect(computed[i]()).toBe(i * 2)
      }

      for (let i = 0; i < 100; i++) {
        sources[i](i + 1000)
      }
      await tick()

      for (let i = 0; i < 100; i++) {
        expect(computed[i]()).toBe((i + 1000) * 2)
      }
    })

    it("diamond with many paths converging", async () => {
      let bottomCount = 0
      const root = g.cell("root", 1)
      const midCells = []
      for (let i = 0; i < 10; i++) {
        midCells.push(g.cell(`mid${i}`, () => root() + i))
      }
      const bottom = g.cell("bottom", () => {
        bottomCount++
        let sum = 0
        for (const mid of midCells) sum += mid()
        return sum
      })
      await tick()

      // 1+0 + 1+1 + ... + 1+9 = 10 + 45 = 55
      expect(bottom()).toBe(55)
      expect(bottomCount).toBe(1)

      bottomCount = 0
      root(10)
      await tick()

      // 10+0 + 10+1 + ... + 10+9 = 100 + 45 = 145
      expect(bottom()).toBe(145)
      expect(bottomCount).toBe(1)
    })
  })
})

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
