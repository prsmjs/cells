import { describe, it, expect, beforeEach, vi } from "vitest"
import { createGraph } from "../src/index.js"

describe("local mode", () => {
  let g

  beforeEach(() => {
    g = createGraph()
  })

  describe("source cells", () => {
    it("defines a source cell with initial value", () => {
      const price = g.cell("price", 100)
      expect(price()).toBe(100)
      expect(price.state.status).toBe("current")
      expect(price.state.error).toBeNull()
    })

    it("defines a source cell with object value", () => {
      const config = g.cell("config", { theme: "dark" })
      expect(config()).toEqual({ theme: "dark" })
    })

    it("defines a source cell with null value", () => {
      const empty = g.cell("empty", null)
      expect(empty()).toBeNull()
      expect(empty.state.status).toBe("current")
    })

    it("throws on duplicate cell name", () => {
      g.cell("a", 1)
      expect(() => g.cell("a", 2)).toThrow("cell already exists: a")
    })

    it("updates via accessor write", () => {
      const price = g.cell("price", 100)
      price(200)
      expect(price()).toBe(200)
    })

    it("updates via g.set", () => {
      g.cell("price", 100)
      g.set("price", 200)
      expect(g.value("price")).toBe(200)
    })

    it("throws when setting nonexistent cell", () => {
      expect(() => g.set("nope", 1)).toThrow("cell not found: nope")
    })

    it("throws when setting computed cell", () => {
      const a = g.cell("a", 1)
      const b = g.cell("b", () => a() * 2)
      expect(() => b(5)).toThrow("cannot set computed cell: b")
    })

    it("accessor has correct name property", () => {
      const price = g.cell("price", 100)
      expect(price.name).toBe("price")
    })
  })

  describe("computed cells (sync)", () => {
    it("computes from a single dependency", async () => {
      const price = g.cell("price", 100)
      const doubled = g.cell("doubled", () => price() * 2)
      await tick()
      expect(doubled()).toBe(200)
    })

    it("computes from multiple dependencies", async () => {
      const price = g.cell("price", 100)
      const tax = g.cell("tax", 0.08)
      const total = g.cell("total", () => price() * (1 + tax()))
      await tick()
      expect(total()).toBe(108)
    })

    it("propagates through a chain", async () => {
      const a = g.cell("a", 1)
      const b = g.cell("b", () => a() + 1)
      const c = g.cell("c", () => b() + 1)
      await tick()
      expect(c()).toBe(3)
    })

    it("recomputes on source change", async () => {
      const a = g.cell("a", 1)
      const b = g.cell("b", () => a() * 10)
      await tick()
      expect(b()).toBe(10)

      a(5)
      await tick()
      expect(b()).toBe(50)
    })

    it("handles diamond dependencies (computes only once)", async () => {
      let callCount = 0
      const root = g.cell("root", 1)
      const left = g.cell("left", () => root() + 1)
      const right = g.cell("right", () => root() + 2)
      const bottom = g.cell("bottom", () => {
        callCount++
        return left() + right()
      })
      await tick()
      expect(bottom()).toBe(5)
      expect(callCount).toBe(1)

      callCount = 0
      root(10)
      await tick()
      expect(bottom()).toBe(23)
      expect(callCount).toBe(1)
    })

    it("does not propagate when value unchanged", async () => {
      let callCount = 0
      const a = g.cell("a", 1)
      const b = g.cell("b", () => Math.min(a(), 5))
      const c = g.cell("c", () => {
        callCount++
        return b() * 2
      })
      await tick()
      expect(callCount).toBe(1)
      expect(c()).toBe(2)

      a(3)
      await tick()
      expect(b()).toBe(3)
      expect(callCount).toBe(2)

      callCount = 0
      a(4)
      await tick()
      a(4)
      await tick()
      expect(callCount).toBe(1)
    })
  })

  describe("computed cells (async)", () => {
    it("resolves async computations", async () => {
      const input = g.cell("input", "hello")
      const upper = g.cell("upper", async () => {
        await delay(10)
        return input().toUpperCase()
      })
      await tick()
      await delay(50)
      expect(upper()).toBe("HELLO")
    })

    it("tracks dependencies across await boundaries", async () => {
      const a = g.cell("a", 10)
      const b = g.cell("b", 20)
      const result = g.cell("result", async () => {
        const aVal = a()
        await delay(10)
        const bVal = b()
        return aVal + bVal
      })
      await tick()
      await delay(50)
      expect(result()).toBe(30)

      b(100)
      await tick()
      await delay(50)
      expect(result()).toBe(110)
    })

    it("discards stale async results", async () => {
      let resolvers = []
      const input = g.cell("input", 1)
      const slow = g.cell("slow", () => {
        const val = input()
        return new Promise((resolve) => {
          resolvers.push(() => resolve(val * 10))
        })
      })

      await tick()
      expect(resolvers).toHaveLength(1)
      expect(slow.state.status).toBe("pending")

      input(2)
      await tick()

      resolvers[0]()
      await tick()
      expect(slow()).not.toBe(10)

      resolvers[1]()
      await tick()
      await delay(10)
      expect(slow()).toBe(20)
    })
  })

  describe("auto-tracking", () => {
    it("discovers dependencies automatically", async () => {
      const a = g.cell("a", 1)
      const b = g.cell("b", 2)
      g.cell("sum", () => a() + b())
      await tick()

      const info = g.cells().find(c => c.name === "sum")
      expect(info.deps).toContain("a")
      expect(info.deps).toContain("b")
    })

    it("handles conditional dependencies", async () => {
      const flag = g.cell("flag", true)
      const a = g.cell("a", 10)
      const b = g.cell("b", 20)
      const result = g.cell("result", () => flag() ? a() : b())
      await tick()
      expect(result()).toBe(10)

      flag(false)
      await tick()
      expect(result()).toBe(20)

      a(999)
      await tick()
      expect(result()).toBe(20)
    })

    it("re-tracks deps on each computation", async () => {
      const flag = g.cell("flag", true)
      const a = g.cell("a", 10)
      const b = g.cell("b", 20)
      const result = g.cell("result", () => flag() ? a() : b())
      await tick()

      let info = g.cells().find(c => c.name === "result")
      expect(info.deps).toContain("flag")
      expect(info.deps).toContain("a")
      expect(info.deps).not.toContain("b")

      flag(false)
      await tick()

      info = g.cells().find(c => c.name === "result")
      expect(info.deps).toContain("flag")
      expect(info.deps).toContain("b")
      expect(info.deps).not.toContain("a")
    })

    it("tracks deps across await in async cells", async () => {
      const a = g.cell("a", 1)
      const b = g.cell("b", 2)
      const result = g.cell("result", async () => {
        const x = a()
        await delay(5)
        const y = b()
        return x + y
      })
      await tick()
      await delay(50)
      expect(result()).toBe(3)

      const info = g.cells().find(c => c.name === "result")
      expect(info.deps).toContain("a")
      expect(info.deps).toContain("b")
    })

    it("isolates tracking between concurrent async cells", async () => {
      const a = g.cell("a", 1)
      const b = g.cell("b", 2)
      const c = g.cell("c", 3)

      const x = g.cell("x", async () => {
        await delay(10)
        return a() + b()
      })
      const y = g.cell("y", async () => {
        await delay(10)
        return b() + c()
      })

      await tick()
      await delay(50)

      const xInfo = g.cells().find(ci => ci.name === "x")
      const yInfo = g.cells().find(ci => ci.name === "y")
      expect(xInfo.deps).toContain("a")
      expect(xInfo.deps).toContain("b")
      expect(xInfo.deps).not.toContain("c")
      expect(yInfo.deps).toContain("b")
      expect(yInfo.deps).toContain("c")
      expect(yInfo.deps).not.toContain("a")
    })
  })

  describe("error handling", () => {
    it("captures errors in computed cells", async () => {
      const a = g.cell("a", 1)
      const b = g.cell("b", () => {
        a()
        throw new Error("boom")
      })
      await tick()
      expect(b.state.status).toBe("error")
      expect(b.state.error.message).toBe("boom")
    })

    it("retains last good value on error", async () => {
      let shouldFail = false
      const a = g.cell("a", 1)
      const b = g.cell("b", () => {
        const v = a()
        if (shouldFail) throw new Error("fail")
        return v * 2
      })
      await tick()
      expect(b()).toBe(2)

      shouldFail = true
      a(5)
      await tick()
      expect(b.state.status).toBe("error")
      expect(b.state.value).toBe(2)
    })

    it("marks downstream cells as stale on error", async () => {
      let shouldFail = false
      const a = g.cell("a", 1)
      const b = g.cell("b", () => {
        const v = a()
        if (shouldFail) throw new Error("fail")
        return v * 2
      })
      const c = g.cell("c", () => b() + 1)
      await delay(10)
      expect(c()).toBe(3)

      shouldFail = true
      a(5)
      await delay(10)
      expect(b.state.status).toBe("error")
      expect(c.state.status).toBe("stale")
      expect(c.state.value).toBe(3)
    })

    it("recovers when error clears", async () => {
      let shouldFail = true
      const a = g.cell("a", 1)
      const b = g.cell("b", () => {
        const v = a()
        if (shouldFail) throw new Error("fail")
        return v * 2
      })
      const c = g.cell("c", () => b() + 10)
      await tick()
      expect(b.state.status).toBe("error")

      shouldFail = false
      a(5)
      await tick()
      expect(b.state.status).toBe("current")
      expect(b()).toBe(10)
      expect(c()).toBe(20)
    })

    it("recovers downstream even when value is unchanged", async () => {
      let shouldFail = false
      const a = g.cell("a", 1)
      const b = g.cell("b", () => {
        a()
        if (shouldFail) throw new Error("fail")
        return 42
      })
      const c = g.cell("c", () => b() + 1)
      await tick()
      expect(b()).toBe(42)
      expect(c()).toBe(43)

      shouldFail = true
      a(2)
      await tick()
      expect(b.state.status).toBe("error")
      expect(c.state.status).toBe("stale")

      shouldFail = false
      a(3)
      await tick()
      expect(b.state.status).toBe("current")
      expect(b()).toBe(42)
      expect(c.state.status).toBe("current")
      expect(c()).toBe(43)
    })

    it("fires onError listeners", async () => {
      const errors = []
      const a = g.cell("a", 1)
      const b = g.cell("b", () => {
        a()
        throw new Error("oops")
      })
      b.onError((err) => errors.push(err.message))
      await delay(20)
      expect(errors).toEqual(["oops"])
    })
  })

  describe("listeners", () => {
    it("fires on value change via accessor.on", async () => {
      const values = []
      const a = g.cell("a", 1)
      const b = g.cell("b", () => a() * 2)
      b.on((val) => values.push(val))
      await tick()
      expect(values).toEqual([2])

      a(5)
      await tick()
      expect(values).toEqual([2, 10])
    })

    it("unsubscribes correctly", async () => {
      const values = []
      const a = g.cell("a", 1)
      const b = g.cell("b", () => a() * 2)
      const off = b.on((val) => values.push(val))
      await tick()
      expect(values).toEqual([2])

      off()
      a(5)
      await tick()
      expect(values).toEqual([2])
    })

    it("fires wildcard listener on any change", async () => {
      const changes = []
      const a = g.cell("a", 1)
      const b = g.cell("b", () => a() * 2)
      g.on((name, val) => changes.push({ name, val }))
      await tick()
      expect(changes).toEqual([{ name: "b", val: 2 }])

      a(5)
      await tick()
      expect(changes).toContainEqual({ name: "a", val: 5 })
      expect(changes).toContainEqual({ name: "b", val: 10 })
    })

    it("provides state as second argument", async () => {
      let receivedState = null
      const a = g.cell("a", 1)
      const b = g.cell("b", () => a() * 2)
      b.on((val, state) => { receivedState = state })
      await tick()
      expect(receivedState.value).toBe(2)
      expect(receivedState.status).toBe("current")
      expect(receivedState.computeTime).toBeTypeOf("number")
    })

    it("listener errors don't break propagation", async () => {
      const a = g.cell("a", 1)
      const b = g.cell("b", () => a() * 2)
      const c = g.cell("c", () => b() + 1)
      b.on(() => { throw new Error("listener fail") })
      const cValues = []
      c.on((val) => cValues.push(val))
      await tick()
      expect(cValues).toEqual([3])
    })

    it("fires source cell listeners on set", () => {
      const values = []
      const a = g.cell("a", 1)
      a.on((val) => values.push(val))
      a(5)
      expect(values).toEqual([5])
    })
  })

  describe("snapshot", () => {
    it("returns all current values", async () => {
      const a = g.cell("a", 1)
      const b = g.cell("b", 2)
      const c = g.cell("c", () => a() + b())
      await tick()
      expect(g.snapshot()).toEqual({ a: 1, b: 2, c: 3 })
    })

    it("omits uninitialized cells", () => {
      g.cell("computed", () => {
        const missing = g.value("missing")
        return missing
      })
      expect(g.snapshot()).toEqual({})
    })

    it("omits errored cells", async () => {
      const a = g.cell("a", 1)
      g.cell("b", () => { a(); throw new Error("fail") })
      await tick()
      const snap = g.snapshot()
      expect(snap).toEqual({ a: 1 })
    })

    it("includes stale cells with their last good value", async () => {
      let shouldFail = false
      const a = g.cell("a", 1)
      const b = g.cell("b", () => {
        const v = a()
        if (shouldFail) throw new Error("fail")
        return v * 2
      })
      const c = g.cell("c", () => b() + 1)
      await tick()
      expect(g.snapshot()).toEqual({ a: 1, b: 2, c: 3 })

      shouldFail = true
      a(5)
      await tick()
      expect(b.state.status).toBe("error")
      expect(c.state.status).toBe("stale")
      expect(g.snapshot()).toEqual({ a: 5, c: 3 })
    })
  })

  describe("cycle detection", () => {
    it("detects self-reference and enters error state", async () => {
      const a = g.cell("a", 1)
      let self
      self = g.cell("self", () => {
        a()
        self()
        return 1
      })
      await tick()
      expect(self.state.status).toBe("error")
      expect(self.state.error.message).toContain("cycle detected")
    })
  })

  describe("late dependency resolution", () => {
    it("computed cell defined before source deps resolves on set", async () => {
      const doubled = g.cell("doubled", () => {
        const v = g.value("input")
        return v === undefined ? undefined : v * 2
      })
      await tick()
      expect(doubled()).toBeUndefined()

      g.cell("input", 0)
      g.set("input", 5)
      await tick()
      expect(doubled()).toBe(10)
    })
  })

  describe("equality check", () => {
    it("uses === for primitives", async () => {
      let count = 0
      const a = g.cell("a", 1)
      const b = g.cell("b", () => {
        count++
        return a() + 1
      })
      await tick()
      expect(count).toBe(1)

      a(1)
      await tick()
      expect(count).toBe(1)
    })

    it("uses JSON comparison for objects", async () => {
      let count = 0
      const a = g.cell("a", { x: 1 })
      const b = g.cell("b", () => {
        count++
        return a()
      })
      await tick()
      expect(count).toBe(1)

      a({ x: 1 })
      await tick()
      expect(count).toBe(1)
    })

    it("supports custom equals function", async () => {
      let count = 0
      const a = g.cell("a", { id: 1, ts: 100 })
      const b = g.cell("b", () => a(), {
        equals: (prev, next) => prev?.id === next?.id,
      })
      const c = g.cell("c", () => {
        count++
        b()
        return "ok"
      })
      await tick()
      expect(count).toBe(1)

      a({ id: 1, ts: 200 })
      await tick()
      expect(count).toBe(1)

      a({ id: 2, ts: 300 })
      await tick()
      expect(count).toBe(2)
    })
  })

  describe("polling", () => {
    it("polls a source cell via accessor.poll", async () => {
      vi.useFakeTimers()
      let counter = 0
      const c = g.cell("counter", 0)
      c.poll(() => ++counter, 100)

      await vi.advanceTimersByTimeAsync(50)
      expect(c()).toBe(1)

      await vi.advanceTimersByTimeAsync(100)
      expect(c()).toBe(2)

      await vi.advanceTimersByTimeAsync(100)
      expect(c()).toBe(3)

      vi.useRealTimers()
    })

    it("throws when polling a computed cell", () => {
      const a = g.cell("a", 1)
      const b = g.cell("b", () => a())
      expect(() => b.poll(() => 1, 100)).toThrow("cannot poll computed cell")
    })

    it("stops polling via accessor.stop", async () => {
      vi.useFakeTimers()
      let counter = 0
      const c = g.cell("counter", 0)
      c.poll(() => ++counter, 100)

      await vi.advanceTimersByTimeAsync(50)
      expect(c()).toBe(1)

      c.stop()
      await vi.advanceTimersByTimeAsync(200)
      expect(c()).toBe(1)

      vi.useRealTimers()
    })

    it("handles poll errors gracefully", async () => {
      vi.useFakeTimers()
      let shouldFail = true
      const errors = []
      const flaky = g.cell("flaky", 0)
      flaky.onError((err) => errors.push(err.message))
      flaky.poll(() => {
        if (shouldFail) throw new Error("poll fail")
        return 42
      }, 100)

      await vi.advanceTimersByTimeAsync(50)
      expect(flaky.state.status).toBe("error")
      expect(errors).toEqual(["poll fail"])

      shouldFail = false
      await vi.advanceTimersByTimeAsync(100)
      expect(flaky()).toBe(42)
      expect(flaky.state.status).toBe("current")

      vi.useRealTimers()
    })
  })

  describe("debouncing", () => {
    it("initial compute is not debounced", async () => {
      const a = g.cell("a", 1)
      const debounced = g.cell("debounced", () => a() * 2, { debounce: 5000 })
      await tick()
      expect(debounced()).toBe(2)
    })

    it("debounces computed cell recomputation", async () => {
      vi.useFakeTimers()
      let count = 0
      const a = g.cell("a", 1)
      const debounced = g.cell("debounced", () => {
        count++
        return a() * 2
      }, { debounce: 200 })

      await vi.advanceTimersByTimeAsync(0)
      expect(count).toBe(1)
      count = 0

      a(2)
      a(3)
      a(4)

      await vi.advanceTimersByTimeAsync(100)
      expect(count).toBe(0)

      await vi.advanceTimersByTimeAsync(200)
      expect(count).toBe(1)
      expect(debounced()).toBe(8)

      vi.useRealTimers()
    })
  })

  describe("removal", () => {
    it("removes a leaf cell via accessor.remove", async () => {
      const a = g.cell("a", 1)
      const b = g.cell("b", () => a() * 2)
      await tick()

      b.remove()
      expect(g.get("b")).toBeNull()
      expect(g.cells()).toHaveLength(1)
    })

    it("throws when removing cell with dependents", async () => {
      const a = g.cell("a", 1)
      g.cell("b", () => a())
      await tick()
      expect(() => a.remove()).toThrow('cannot remove "a": "b" depends on it')
    })

    it("removeTree removes cell and all dependents", async () => {
      const a = g.cell("a", 1)
      const b = g.cell("b", () => a() + 1)
      const c = g.cell("c", () => b() + 1)
      g.cell("d", 99)
      await tick()

      a.removeTree()
      expect(g.cells()).toHaveLength(1)
      expect(g.cells()[0].name).toBe("d")
    })
  })

  describe("graph introspection", () => {
    it("returns correct topology", async () => {
      const a = g.cell("a", 1)
      const b = g.cell("b", 2)
      const c = g.cell("c", () => a() + b())
      await tick()

      const info = g.cells()
      expect(info).toHaveLength(3)

      const aInfo = info.find(c => c.name === "a")
      expect(aInfo.type).toBe("source")
      expect(aInfo.deps).toEqual([])
      expect(aInfo.dependents).toEqual(["c"])

      const cInfo = info.find(c => c.name === "c")
      expect(cInfo.type).toBe("computed")
      expect(cInfo.deps).toContain("a")
      expect(cInfo.deps).toContain("b")
      expect(cInfo.dependents).toEqual([])
      expect(cInfo.status).toBe("current")
    })
  })

  describe("destroy", () => {
    it("makes graph unusable", async () => {
      g.cell("a", 1)
      await g.destroy()
      expect(() => g.cell("b", 2)).toThrow("graph is destroyed")
      expect(() => g.set("a", 2)).toThrow("graph is destroyed")
    })

    it("clears all state", async () => {
      vi.useFakeTimers()
      const a = g.cell("a", 1)
      g.cell("b", () => a() * 2)
      a.poll(() => 99, 100)
      await g.destroy()
      expect(g.cells()).toHaveLength(0)
      vi.useRealTimers()
    })
  })

  describe("g.set and g.value escape hatches", () => {
    it("g.set works for cross-module access", () => {
      const a = g.cell("a", 1)
      g.set("a", 42)
      expect(a()).toBe(42)
    })

    it("g.value reads by name", () => {
      g.cell("a", 100)
      expect(g.value("a")).toBe(100)
    })

    it("g.get reads full state by name", () => {
      g.cell("a", 100)
      const state = g.get("a")
      expect(state.value).toBe(100)
      expect(state.status).toBe("current")
    })

    it("g.value participates in dependency tracking", async () => {
      const a = g.cell("a", 10)
      const b = g.cell("b", () => g.value("a") * 2)
      await tick()
      expect(b()).toBe(20)

      a(5)
      await tick()
      expect(b()).toBe(10)

      const info = g.cells().find(c => c.name === "b")
      expect(info.deps).toContain("a")
    })
  })

  describe("async error handling", () => {
    it("captures errors in async computed cells", async () => {
      const a = g.cell("a", 1)
      const b = g.cell("b", async () => {
        a()
        await delay(5)
        throw new Error("async boom")
      })
      await tick()
      await delay(50)
      expect(b.state.status).toBe("error")
      expect(b.state.error.message).toBe("async boom")
    })

    it("retains last good value after async error", async () => {
      let shouldFail = false
      const a = g.cell("a", 1)
      const b = g.cell("b", async () => {
        const v = a()
        await delay(5)
        if (shouldFail) throw new Error("fail")
        return v * 2
      })
      await tick()
      await delay(50)
      expect(b()).toBe(2)

      shouldFail = true
      a(5)
      await tick()
      await delay(50)
      expect(b.state.status).toBe("error")
      expect(b.state.value).toBe(2)
    })

    it("recovers from async error on next successful compute", async () => {
      let shouldFail = true
      const a = g.cell("a", 1)
      const b = g.cell("b", async () => {
        const v = a()
        await delay(5)
        if (shouldFail) throw new Error("fail")
        return v * 2
      })
      await tick()
      await delay(50)
      expect(b.state.status).toBe("error")

      shouldFail = false
      a(5)
      await tick()
      await delay(50)
      expect(b.state.status).toBe("current")
      expect(b()).toBe(10)
    })
  })

  describe("indirect cycle detection", () => {
    it("detects A -> B -> A cycle", async () => {
      let cellA, cellB
      cellA = g.cell("a", () => {
        cellB()
        return 1
      })
      cellB = g.cell("b", () => {
        cellA()
        return 2
      })
      await tick()

      const aState = cellA.state
      const bState = cellB.state
      const hasError = aState.status === "error" || bState.status === "error"
      expect(hasError).toBe(true)
    })

    it("detects longer cycle chains", async () => {
      let cellC
      const a = g.cell("a", 1)
      const b = g.cell("b", () => a() + (cellC ? cellC() : 0))
      cellC = g.cell("c", () => b() + 1)
      await tick()

      expect(b.state.status === "error" || cellC.state.status === "error").toBe(true)
    })
  })

  describe("sync fn returning promise", () => {
    it("handles non-async fn that returns a promise", async () => {
      const a = g.cell("a", 5)
      const b = g.cell("b", () => {
        const v = a()
        return Promise.resolve(v * 3)
      })
      await tick()
      await delay(20)
      expect(b()).toBe(15)
    })

    it("propagates after promise resolves", async () => {
      const a = g.cell("a", 2)
      const b = g.cell("b", () => {
        return Promise.resolve(a() * 10)
      })
      await tick()
      await delay(20)
      expect(b()).toBe(20)

      a(5)
      await tick()
      await delay(20)
      expect(b()).toBe(50)
    })
  })

  describe("metadata", () => {
    it("stores arbitrary metadata on a cell", () => {
      g.cell("price", 100, { metadata: { description: "current BTC price", units: "usd" } })
      const info = g.cells().find(c => c.name === "price")
      expect(info.metadata).toEqual({ description: "current BTC price", units: "usd" })
    })

    it("stores source descriptor on a cell", () => {
      g.cell("docs", [], { source: { type: "sharepoint", site: "https://x", interval: "5m" } })
      const info = g.cells().find(c => c.name === "docs")
      expect(info.source).toEqual({ type: "sharepoint", site: "https://x", interval: "5m" })
    })

    it("omits metadata/source keys when not set", () => {
      g.cell("plain", 1)
      const info = g.cells().find(c => c.name === "plain")
      expect(info.metadata).toBeUndefined()
      expect(info.source).toBeUndefined()
    })

    it("metadata survives on computed cells", async () => {
      g.cell("a", 1)
      g.cell("b", () => g.value("a") * 2, { metadata: { description: "doubled" } })
      await tick()
      const info = g.cells().find(c => c.name === "b")
      expect(info.metadata).toEqual({ description: "doubled" })
    })
  })

  describe("history", () => {
    it("returns empty array when history not enabled", () => {
      const price = g.cell("price", 100)
      price(200)
      expect(g.history("price")).toEqual([])
    })

    it("records initial value when history enabled", () => {
      g.cell("price", 100, { history: true })
      const h = g.history("price")
      expect(h).toHaveLength(1)
      expect(h[0].value).toBe(100)
      expect(typeof h[0].timestamp).toBe("number")
    })

    it("records updates", () => {
      const price = g.cell("price", 100, { history: true })
      price(200)
      price(300)
      const h = g.history("price")
      expect(h.map(e => e.value)).toEqual([100, 200, 300])
    })

    it("respects custom limit", () => {
      const price = g.cell("price", 0, { history: 3 })
      for (let i = 1; i <= 5; i++) price(i)
      const h = g.history("price")
      expect(h.map(e => e.value)).toEqual([3, 4, 5])
    })

    it("limits to default of 100", () => {
      const price = g.cell("price", 0, { history: true })
      for (let i = 1; i <= 150; i++) price(i)
      const h = g.history("price")
      expect(h).toHaveLength(100)
      expect(h[0].value).toBe(51)
      expect(h[99].value).toBe(150)
    })

    it("can slice with explicit limit on read", () => {
      const price = g.cell("price", 0, { history: true })
      for (let i = 1; i <= 10; i++) price(i)
      expect(g.history("price", 3).map(e => e.value)).toEqual([8, 9, 10])
    })

    it("records computed cell values", async () => {
      const a = g.cell("a", 1)
      g.cell("doubled", () => a() * 2, { history: true })
      await tick()
      a(2)
      await tick()
      a(3)
      await tick()
      const h = g.history("doubled")
      expect(h.map(e => e.value)).toEqual([2, 4, 6])
    })

    it("does not record when value is unchanged (equality)", () => {
      const price = g.cell("price", 100, { history: true })
      price(100)
      price(100)
      const h = g.history("price")
      expect(h).toHaveLength(1)
    })

    it("clears history when cell removed", () => {
      const price = g.cell("price", 100, { history: true })
      price(200)
      g.cell("other", 1)
      price.remove()
      expect(g.history("price")).toEqual([])
    })
  })

  describe("template", () => {
    it("renders static template with no deps", async () => {
      const t = g.template("greet", "hello world")
      await tick()
      expect(t()).toBe("hello world")
    })

    it("renders with single dep", async () => {
      g.cell("name", "alice")
      const t = g.template("greet", "hello {{name}}")
      await tick()
      expect(t()).toBe("hello alice")
    })

    it("renders with nested path", async () => {
      g.cell("doc", { title: "spec", author: { name: "bob" } })
      const t = g.template("intro", "{{doc.title}} by {{doc.author.name}}")
      await tick()
      expect(t()).toBe("spec by bob")
    })

    it("stringifies object values", async () => {
      g.cell("metrics", { a: 1, b: 2 })
      const t = g.template("desc", "metrics: {{metrics}}")
      await tick()
      expect(t()).toBe(`metrics: {"a":1,"b":2}`)
    })

    it("renders empty for missing values", async () => {
      g.cell("name", null)
      const t = g.template("greet", "hello {{name}}!")
      await tick()
      expect(t()).toBe("hello !")
    })

    it("supports #if conditionals", async () => {
      g.cell("flag", true)
      g.cell("note", "important")
      const t = g.template("msg", "base{{#if flag}}: {{note}}{{/if}}")
      await tick()
      expect(t()).toBe("base: important")
      g.set("flag", false)
      await tick()
      expect(t()).toBe("base")
    })

    it("re-renders when dep changes", async () => {
      const name = g.cell("name", "alice")
      const t = g.template("greet", "hello {{name}}")
      await tick()
      expect(t()).toBe("hello alice")
      name("bob")
      await tick()
      expect(t()).toBe("hello bob")
    })

    it("is consumable as a dep by other cells", async () => {
      g.cell("name", "alice")
      g.template("greet", "hello {{name}}")
      const upper = g.cell("upper", () => g.value("greet").toUpperCase())
      await tick()
      expect(upper()).toBe("HELLO ALICE")
      g.set("name", "bob")
      await tick()
      expect(upper()).toBe("HELLO BOB")
    })

    it("auto-tracks all referenced cells as deps", async () => {
      g.cell("a", "X")
      g.cell("b", "Y")
      g.template("combined", "{{a}}-{{b}}")
      await tick()
      const info = g.cells().find(c => c.name === "combined")
      expect(info.deps.sort()).toEqual(["a", "b"])
      expect(info.kind).toBe("template")
      expect(info.template).toBe("{{a}}-{{b}}")
    })

    it("throws on non-string body", () => {
      expect(() => g.template("x", 42)).toThrow("template body must be a string")
    })

    it("accepts metadata", async () => {
      g.cell("name", "alice")
      g.template("greet", "hi {{name}}", { metadata: { description: "greeting line" } })
      await tick()
      const info = g.cells().find(c => c.name === "greet")
      expect(info.metadata).toEqual({ description: "greeting line" })
    })

    it("handles cell names with hyphens", async () => {
      g.cell("btc-price", 67000)
      g.cell("eth-price", 3400)
      const t = g.template("summary", "BTC ${{btc-price}}, ETH ${{eth-price}}")
      await tick()
      expect(t()).toBe("BTC $67000, ETH $3400")
      const info = g.cells().find(c => c.name === "summary")
      expect(info.deps.sort()).toEqual(["btc-price", "eth-price"])
    })

    it("handles hyphenated names in #if conditionals", async () => {
      g.cell("risk-tier", "high")
      const t = g.template("msg", "{{#if risk-tier}}tier: {{risk-tier}}{{/if}}")
      await tick()
      expect(t()).toBe("tier: high")
      g.set("risk-tier", "")
      await tick()
      expect(t()).toBe("")
    })
  })
})

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
