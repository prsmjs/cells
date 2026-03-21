import { describe, it, expect, beforeEach, vi } from "vitest"
import { createGraph } from "../src/index.js"

describe("local mode", () => {
  let g

  beforeEach(() => {
    g = createGraph()
  })

  describe("source cells", () => {
    it("defines a source cell with initial value", () => {
      g.cell("price", 100)
      const state = g.get("price")
      expect(state.value).toBe(100)
      expect(state.status).toBe("current")
      expect(state.error).toBeNull()
    })

    it("defines a source cell with object value", () => {
      g.cell("config", { theme: "dark" })
      expect(g.value("config")).toEqual({ theme: "dark" })
    })

    it("defines a source cell with null value", () => {
      g.cell("empty", null)
      const state = g.get("empty")
      expect(state.value).toBeNull()
      expect(state.status).toBe("current")
    })

    it("throws on duplicate cell name", () => {
      g.cell("a", 1)
      expect(() => g.cell("a", 2)).toThrow("cell already exists: a")
    })

    it("updates via set", () => {
      g.cell("price", 100)
      g.set("price", 200)
      expect(g.value("price")).toBe(200)
    })

    it("throws when setting nonexistent cell", () => {
      expect(() => g.set("nope", 1)).toThrow("cell not found: nope")
    })

    it("throws when setting computed cell", () => {
      g.cell("a", 1)
      g.cell("b", ["a"], (a) => a * 2)
      expect(() => g.set("b", 5)).toThrow("cannot set computed cell: b")
    })
  })

  describe("computed cells (sync)", () => {
    it("computes from a single dependency", async () => {
      g.cell("price", 100)
      g.cell("doubled", ["price"], (p) => p * 2)
      await tick()
      expect(g.value("doubled")).toBe(200)
    })

    it("computes from multiple dependencies", async () => {
      g.cell("price", 100)
      g.cell("tax", 0.08)
      g.cell("total", ["price", "tax"], (p, t) => p * (1 + t))
      await tick()
      expect(g.value("total")).toBe(108)
    })

    it("propagates through a chain", async () => {
      g.cell("a", 1)
      g.cell("b", ["a"], (a) => a + 1)
      g.cell("c", ["b"], (b) => b + 1)
      await tick()
      expect(g.value("c")).toBe(3)
    })

    it("recomputes on source change", async () => {
      g.cell("a", 1)
      g.cell("b", ["a"], (a) => a * 10)
      await tick()
      expect(g.value("b")).toBe(10)

      g.set("a", 5)
      await tick()
      expect(g.value("b")).toBe(50)
    })

    it("handles diamond dependencies (computes only once)", async () => {
      let callCount = 0
      g.cell("root", 1)
      g.cell("left", ["root"], (r) => r + 1)
      g.cell("right", ["root"], (r) => r + 2)
      g.cell("bottom", ["left", "right"], (l, r) => {
        callCount++
        return l + r
      })
      await tick()
      expect(g.value("bottom")).toBe(5)
      expect(callCount).toBe(1)

      callCount = 0
      g.set("root", 10)
      await tick()
      expect(g.value("bottom")).toBe(23)
      expect(callCount).toBe(1)
    })

    it("does not propagate when value unchanged", async () => {
      let callCount = 0
      g.cell("a", 1)
      g.cell("b", ["a"], (a) => Math.min(a, 5))
      g.cell("c", ["b"], (b) => {
        callCount++
        return b * 2
      })
      await tick()
      expect(callCount).toBe(1)
      expect(g.value("c")).toBe(2)

      g.set("a", 3)
      await tick()
      expect(g.value("b")).toBe(3)
      expect(callCount).toBe(2)

      callCount = 0
      g.set("a", 4)
      await tick()
      g.set("a", 4)
      await tick()
      expect(callCount).toBe(1)
    })
  })

  describe("computed cells (async)", () => {
    it("resolves async computations", async () => {
      g.cell("input", "hello")
      g.cell("upper", ["input"], async (val) => {
        await delay(10)
        return val.toUpperCase()
      })
      await tick()
      await delay(50)
      expect(g.value("upper")).toBe("HELLO")
    })

    it("discards stale async results", async () => {
      let resolvers = []
      g.cell("input", 1)
      g.cell("slow", ["input"], (val) => {
        return new Promise((resolve) => {
          resolvers.push(() => resolve(val * 10))
        })
      })

      await tick()
      expect(resolvers).toHaveLength(1)
      expect(g.get("slow").status).toBe("pending")

      g.set("input", 2)
      await tick()

      resolvers[0]()
      await tick()
      expect(g.value("slow")).not.toBe(10)

      resolvers[1]()
      await tick()
      await delay(10)
      expect(g.value("slow")).toBe(20)
    })
  })

  describe("error handling", () => {
    it("captures errors in computed cells", async () => {
      g.cell("a", 1)
      g.cell("b", ["a"], () => {
        throw new Error("boom")
      })
      await tick()
      const state = g.get("b")
      expect(state.status).toBe("error")
      expect(state.error.message).toBe("boom")
    })

    it("retains last good value on error", async () => {
      let shouldFail = false
      g.cell("a", 1)
      g.cell("b", ["a"], (a) => {
        if (shouldFail) throw new Error("fail")
        return a * 2
      })
      await tick()
      expect(g.value("b")).toBe(2)

      shouldFail = true
      g.set("a", 5)
      await tick()
      expect(g.get("b").status).toBe("error")
      expect(g.get("b").value).toBe(2)
    })

    it("marks downstream cells as stale on error", async () => {
      g.cell("a", 1)
      g.cell("b", ["a"], (a) => a * 2)
      g.cell("c", ["b"], (b) => b + 1)
      await delay(10)
      expect(g.value("c")).toBe(3)

      g.cell.__test_failB = true
      g.remove("c")
      g.remove("b")
      g.cell("b", ["a"], (a) => { throw new Error("fail") })
      g.cell("c", ["b"], (b) => b + 1)
      await delay(10)
      expect(g.get("b").status).toBe("error")
      expect(g.get("c").status).toBe("uninitialized")
    })

    it("marks previously-computed downstream as stale when dep errors", async () => {
      let shouldFail = false
      g.cell("a", 1)
      g.cell("b", ["a"], (a) => {
        if (shouldFail) throw new Error("fail")
        return a * 2
      })
      g.cell("c", ["b"], (b) => b + 1)
      await delay(10)
      expect(g.value("c")).toBe(3)

      shouldFail = true
      g.set("a", 5)
      await delay(10)
      expect(g.get("b").status).toBe("error")
      expect(g.get("c").status).toBe("stale")
      expect(g.get("c").value).toBe(3)
    })

    it("does not recompute downstream when dep is in error", async () => {
      let cCount = 0
      g.cell("a", 1)
      g.cell("b", ["a"], (a) => a * 2)
      g.cell("c", ["b"], (b) => {
        cCount++
        return b + 1
      })
      await tick()
      expect(cCount).toBe(1)

      cCount = 0
      g.cell("b2", ["a"], () => { throw new Error("fail") })
      g.cell("d", ["b2"], (b) => b + 1)
      await tick()
      expect(g.get("d").status).not.toBe("current")
    })

    it("recovers when error clears", async () => {
      let shouldFail = true
      g.cell("a", 1)
      g.cell("b", ["a"], (a) => {
        if (shouldFail) throw new Error("fail")
        return a * 2
      })
      g.cell("c", ["b"], (b) => b + 10)
      await tick()
      expect(g.get("b").status).toBe("error")

      shouldFail = false
      g.set("a", 5)
      await tick()
      expect(g.get("b").status).toBe("current")
      expect(g.value("b")).toBe(10)
      expect(g.value("c")).toBe(20)
    })

    it("recovers downstream even when value is unchanged", async () => {
      let shouldFail = false
      g.cell("a", 1)
      g.cell("b", ["a"], (a) => {
        if (shouldFail) throw new Error("fail")
        return 42
      })
      g.cell("c", ["b"], (b) => b + 1)
      await tick()
      expect(g.value("b")).toBe(42)
      expect(g.value("c")).toBe(43)

      shouldFail = true
      g.set("a", 2)
      await tick()
      expect(g.get("b").status).toBe("error")
      expect(g.get("c").status).toBe("stale")

      shouldFail = false
      g.set("a", 3)
      await tick()
      expect(g.get("b").status).toBe("current")
      expect(g.value("b")).toBe(42)
      expect(g.get("c").status).toBe("current")
      expect(g.value("c")).toBe(43)
    })

    it("fires onError listeners", async () => {
      const errors = []
      g.cell("a", 1)
      g.cell("b", ["a"], () => { throw new Error("oops") })
      g.onError("b", (err) => errors.push(err.message))
      await delay(20)
      expect(errors).toEqual(["oops"])
    })
  })

  describe("listeners", () => {
    it("fires on value change", async () => {
      const values = []
      g.cell("a", 1)
      g.cell("b", ["a"], (a) => a * 2)
      g.on("b", (val) => values.push(val))
      await tick()
      expect(values).toEqual([2])

      g.set("a", 5)
      await tick()
      expect(values).toEqual([2, 10])
    })

    it("unsubscribes correctly", async () => {
      const values = []
      g.cell("a", 1)
      g.cell("b", ["a"], (a) => a * 2)
      const off = g.on("b", (val) => values.push(val))
      await tick()
      expect(values).toEqual([2])

      off()
      g.set("a", 5)
      await tick()
      expect(values).toEqual([2])
    })

    it("fires wildcard listener on any change", async () => {
      const changes = []
      g.cell("a", 1)
      g.cell("b", ["a"], (a) => a * 2)
      g.on("*", (name, val) => changes.push({ name, val }))
      await tick()
      expect(changes).toEqual([{ name: "b", val: 2 }])

      g.set("a", 5)
      await tick()
      expect(changes).toContainEqual({ name: "a", val: 5 })
      expect(changes).toContainEqual({ name: "b", val: 10 })
    })

    it("provides state as second argument", async () => {
      let receivedState = null
      g.cell("a", 1)
      g.cell("b", ["a"], (a) => a * 2)
      g.on("b", (val, state) => { receivedState = state })
      await tick()
      expect(receivedState.value).toBe(2)
      expect(receivedState.status).toBe("current")
      expect(receivedState.computeTime).toBeTypeOf("number")
    })

    it("listener errors don't break propagation", async () => {
      g.cell("a", 1)
      g.cell("b", ["a"], (a) => a * 2)
      g.cell("c", ["b"], (b) => b + 1)
      g.on("b", () => { throw new Error("listener fail") })
      const cValues = []
      g.on("c", (val) => cValues.push(val))
      await tick()
      expect(cValues).toEqual([3])
    })
  })

  describe("snapshot", () => {
    it("returns all current values", async () => {
      g.cell("a", 1)
      g.cell("b", 2)
      g.cell("c", ["a", "b"], (a, b) => a + b)
      await tick()
      expect(g.snapshot()).toEqual({ a: 1, b: 2, c: 3 })
    })

    it("omits uninitialized cells", () => {
      g.cell("computed", ["missing"], (v) => v)
      expect(g.snapshot()).toEqual({})
    })

    it("omits errored cells", async () => {
      g.cell("a", 1)
      g.cell("b", ["a"], () => { throw new Error("fail") })
      await tick()
      const snap = g.snapshot()
      expect(snap).toEqual({ a: 1 })
    })
  })

  describe("cycle detection", () => {
    it("detects direct self-reference", () => {
      expect(() => g.cell("a", ["a"], (a) => a)).toThrow("cycle detected")
    })

    it("detects indirect cycle", () => {
      g.cell("a", 1)
      g.cell("b", ["a"], (a) => a)
      expect(() => g.cell("a2", ["b"], (b) => b)).not.toThrow()
      expect(() => {
        g.cell("x", ["y"], (y) => y)
        g.cell("y", ["x"], (x) => x)
      }).toThrow("cycle detected")
    })

    it("cleans up cell on cycle detection", () => {
      g.cell("x", ["y"], (y) => y)
      try {
        g.cell("y", ["x"], (x) => x)
      } catch {}
      expect(g.cells().find(c => c.name === "y")).toBeUndefined()
      expect(g.cells().find(c => c.name === "x")).toBeDefined()
    })
  })

  describe("late dependency resolution", () => {
    it("computes when deps become available", async () => {
      g.cell("total", ["price", "tax"], (p, t) => p * (1 + t))
      expect(g.get("total").status).toBe("uninitialized")

      g.cell("price", 100)
      expect(g.get("total").status).toBe("uninitialized")

      g.cell("tax", 0.08)
      await tick()
      expect(g.value("total")).toBe(108)
    })

    it("handles multi-level late resolution", async () => {
      g.cell("c", ["b"], (b) => b + 1)
      g.cell("b", ["a"], (a) => a * 2)
      g.cell("a", 5)
      await tick()
      expect(g.value("b")).toBe(10)
      expect(g.value("c")).toBe(11)
    })
  })

  describe("equality check", () => {
    it("uses === for primitives", async () => {
      let count = 0
      g.cell("a", 1)
      g.cell("b", ["a"], (a) => {
        count++
        return a + 1
      })
      await tick()
      expect(count).toBe(1)

      g.set("a", 1)
      await tick()
      expect(count).toBe(1)
    })

    it("uses JSON comparison for objects", async () => {
      let count = 0
      g.cell("a", { x: 1 })
      g.cell("b", ["a"], (a) => {
        count++
        return a
      })
      await tick()
      expect(count).toBe(1)

      g.set("a", { x: 1 })
      await tick()
      expect(count).toBe(1)
    })

    it("supports custom equals function", async () => {
      let count = 0
      g.cell("a", { id: 1, ts: 100 })
      g.cell("b", ["a"], (a) => a, {
        equals: (prev, next) => prev?.id === next?.id,
      })
      g.cell("c", ["b"], () => {
        count++
        return "ok"
      })
      await tick()
      expect(count).toBe(1)

      g.set("a", { id: 1, ts: 200 })
      await tick()
      expect(count).toBe(1)

      g.set("a", { id: 2, ts: 300 })
      await tick()
      expect(count).toBe(2)
    })
  })

  describe("polling", () => {
    it("polls a source cell", async () => {
      vi.useFakeTimers()
      let counter = 0
      g.cell("counter", 0)
      g.poll("counter", () => ++counter, 100)

      await vi.advanceTimersByTimeAsync(50)
      expect(g.value("counter")).toBe(1)

      await vi.advanceTimersByTimeAsync(100)
      expect(g.value("counter")).toBe(2)

      await vi.advanceTimersByTimeAsync(100)
      expect(g.value("counter")).toBe(3)

      vi.useRealTimers()
    })

    it("throws when polling a computed cell", () => {
      g.cell("a", 1)
      g.cell("b", ["a"], (a) => a)
      expect(() => g.poll("b", () => 1, 100)).toThrow("cannot poll computed cell")
    })

    it("throws when polling nonexistent cell", () => {
      expect(() => g.poll("nope", () => 1, 100)).toThrow("cell not found")
    })

    it("stops polling", async () => {
      vi.useFakeTimers()
      let counter = 0
      g.cell("counter", 0)
      g.poll("counter", () => ++counter, 100)

      await vi.advanceTimersByTimeAsync(50)
      expect(g.value("counter")).toBe(1)

      g.stop("counter")
      await vi.advanceTimersByTimeAsync(200)
      expect(g.value("counter")).toBe(1)

      vi.useRealTimers()
    })

    it("handles poll errors gracefully", async () => {
      vi.useFakeTimers()
      let shouldFail = true
      const errors = []
      g.cell("flaky", 0)
      g.onError("flaky", (err) => errors.push(err.message))
      g.poll("flaky", () => {
        if (shouldFail) throw new Error("poll fail")
        return 42
      }, 100)

      await vi.advanceTimersByTimeAsync(50)
      expect(g.get("flaky").status).toBe("error")
      expect(errors).toEqual(["poll fail"])

      shouldFail = false
      await vi.advanceTimersByTimeAsync(100)
      expect(g.value("flaky")).toBe(42)
      expect(g.get("flaky").status).toBe("current")

      vi.useRealTimers()
    })
  })

  describe("debouncing", () => {
    it("initial compute is not debounced", async () => {
      g.cell("a", 1)
      g.cell("debounced", ["a"], (a) => a * 2, { debounce: 5000 })
      await tick()
      expect(g.value("debounced")).toBe(2)
    })

    it("debounces computed cell recomputation", async () => {
      vi.useFakeTimers()
      let count = 0
      g.cell("a", 1)
      g.cell("debounced", ["a"], (a) => {
        count++
        return a * 2
      }, { debounce: 200 })

      await vi.advanceTimersByTimeAsync(0)
      expect(count).toBe(1)
      count = 0

      g.set("a", 2)
      g.set("a", 3)
      g.set("a", 4)

      await vi.advanceTimersByTimeAsync(100)
      expect(count).toBe(0)

      await vi.advanceTimersByTimeAsync(200)
      expect(count).toBe(1)
      expect(g.value("debounced")).toBe(8)

      vi.useRealTimers()
    })
  })

  describe("removal", () => {
    it("removes a leaf cell", async () => {
      g.cell("a", 1)
      g.cell("b", ["a"], (a) => a * 2)
      await tick()

      g.remove("b")
      expect(g.get("b")).toBeNull()
      expect(g.cells()).toHaveLength(1)
    })

    it("throws when removing cell with dependents", () => {
      g.cell("a", 1)
      g.cell("b", ["a"], (a) => a)
      expect(() => g.remove("a")).toThrow('cannot remove "a": "b" depends on it')
    })

    it("removeTree removes cell and all dependents", async () => {
      g.cell("a", 1)
      g.cell("b", ["a"], (a) => a + 1)
      g.cell("c", ["b"], (b) => b + 1)
      g.cell("d", 99)
      await tick()

      g.removeTree("a")
      expect(g.cells()).toHaveLength(1)
      expect(g.cells()[0].name).toBe("d")
    })
  })

  describe("graph introspection", () => {
    it("returns correct topology", async () => {
      g.cell("a", 1)
      g.cell("b", 2)
      g.cell("c", ["a", "b"], (a, b) => a + b)
      await tick()

      const info = g.cells()
      expect(info).toHaveLength(3)

      const a = info.find(c => c.name === "a")
      expect(a.type).toBe("source")
      expect(a.deps).toEqual([])
      expect(a.dependents).toEqual(["c"])

      const c = info.find(c => c.name === "c")
      expect(c.type).toBe("computed")
      expect(c.deps).toEqual(["a", "b"])
      expect(c.dependents).toEqual([])
      expect(c.status).toBe("current")
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
      g.cell("a", 1)
      g.cell("b", ["a"], (a) => a * 2)
      g.poll("a", () => 99, 100)
      await g.destroy()
      expect(g.cells()).toHaveLength(0)
      vi.useRealTimers()
    })
  })
})

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
