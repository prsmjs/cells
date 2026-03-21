import { AsyncLocalStorage } from "node:async_hooks"
import ms from "@prsm/ms"
import { randomUUID } from "crypto"
import { topoSort, getDownstream, topoLevels, valuesEqual } from "./propagate.js"
import { createRedisManager } from "./redis.js"

const DEFAULT_LOCK_TTL = 30000
const DEFAULT_PREFIX = "cell:"

const tracking = new AsyncLocalStorage()

export function createGraph(options = {}) {
  const prefix = options.prefix ?? DEFAULT_PREFIX
  const lockTtl = ms(options.lockTtl ?? DEFAULT_LOCK_TTL)

  const cells = new Map()
  const accessors = new Map()
  const listeners = new Map()
  const errorListeners = new Map()
  const wildcardListeners = new Map()
  const pollTimers = new Map()
  const debounceTimers = new Map()
  const activePropagations = new Set()
  const initialComputePromises = new Map()
  let redis = null
  let destroyed = false

  function assertNotDestroyed() {
    if (destroyed) throw new Error("graph is destroyed")
  }

  function makeCell(name, config) {
    return {
      name,
      type: config.type,
      deps: new Set(config.deps || []),
      dependents: new Set(),
      fn: config.fn || null,
      equals: config.equals || null,
      debounce: config.debounce || 0,
      value: config.value,
      status: config.value !== undefined ? "current" : "uninitialized",
      error: null,
      updatedAt: config.value !== undefined ? Date.now() : null,
      computeTime: null,
      version: 0,
      generation: 0,
    }
  }

  function rebuildDependents() {
    for (const c of cells.values()) c.dependents.clear()
    for (const [name, c] of cells) {
      for (const dep of c.deps) {
        const parent = cells.get(dep)
        if (parent) parent.dependents.add(name)
      }
    }
  }

  function allDepsReady(c) {
    if (c.deps.size === 0) return true
    for (const d of c.deps) {
      const dep = cells.get(d)
      if (!dep || (dep.status !== "current" && dep.status !== "stale")) return false
    }
    return true
  }

  function triggerInitialCompute(name) {
    if (initialComputePromises.has(name)) return initialComputePromises.get(name)
    const c = cells.get(name)
    if (!c || c.type !== "computed" || c.status !== "uninitialized") return null

    c.status = "pending"
    const p = executeCompute(name)
    initialComputePromises.set(name, p)
    activePropagations.add(p)
    p.finally(() => {
      activePropagations.delete(p)
      initialComputePromises.delete(name)
    })
    return p
  }

  function isAsyncFn(fn) {
    return fn.constructor.name === "AsyncFunction"
  }

  function computeSync(name) {
    const c = cells.get(name)
    if (!c || c.type !== "computed") return
    if (c.status !== "uninitialized") return

    c.status = "pending"
    const tracker = { deps: new Set() }
    const start = Date.now()
    try {
      const result = tracking.run(tracker, c.fn)
      if (result && typeof result.then === "function") {
        const newDeps = tracker.deps
        newDeps.delete(name)
        c.deps = newDeps
        rebuildDependents()
        c.status = "pending"
        // re-use this promise rather than creating a new one
        const p = (async () => {
          try {
            const val = await result
            if (c.generation !== 0) return
            c.value = val
            c.status = "current"
            c.error = null
            c.updatedAt = Date.now()
            c.computeTime = Date.now() - start
            fireListeners(name, val, getState(name))
          } catch (err) {
            if (c.generation !== 0) return
            c.status = "error"
            c.error = err
            c.computeTime = Date.now() - start
            markDownstreamStale(name)
            fireErrorListeners(name, err, getState(name))
          }
        })()
        initialComputePromises.set(name, p)
        activePropagations.add(p)
        p.finally(() => {
          activePropagations.delete(p)
          initialComputePromises.delete(name)
        })
        return
      }

      const newDeps = tracker.deps

      if (newDeps.has(name)) {
        const err = new Error(`cycle detected: ${name} -> ${name}`)
        c.deps = new Set()
        rebuildDependents()
        c.status = "error"
        c.error = err
        c.computeTime = Date.now() - start
        fireErrorListeners(name, err, getState(name))
        return
      }

      c.deps = newDeps
      rebuildDependents()

      try {
        topoSort(cells)
      } catch (err) {
        c.status = "error"
        c.error = err
        c.computeTime = Date.now() - start
        fireErrorListeners(name, err, getState(name))
        return
      }

      c.value = result
      c.status = "current"
      c.error = null
      c.updatedAt = Date.now()
      c.computeTime = Date.now() - start

      const state = getState(name)
      fireListeners(name, result, state)
    } catch (err) {
      const newDeps = tracker.deps
      newDeps.delete(name)
      c.deps = newDeps
      rebuildDependents()

      c.status = "error"
      c.error = err
      c.computeTime = Date.now() - start
      markDownstreamStale(name)
      fireErrorListeners(name, err, getState(name))
    }
  }

  function createAccessor(name) {
    const accessor = (...args) => {
      if (args.length > 0) {
        set(name, args[0])
        return
      }

      const tracker = tracking.getStore()
      if (tracker) tracker.deps.add(name)

      const c = cells.get(name)
      if (!c) return undefined
      if (c.status === "error") return undefined

      if (c.status === "uninitialized" && c.type === "computed" && !tracker?.discovering) {
        computeSync(name)
      }

      if (c.status === "uninitialized") return undefined
      return c.value
    }

    accessor.on = (callback) => {
      assertNotDestroyed()
      const id = randomUUID()
      if (!listeners.has(name)) listeners.set(name, new Map())
      listeners.get(name).set(id, callback)
      return () => {
        const map = listeners.get(name)
        if (map) map.delete(id)
      }
    }

    accessor.onError = (callback) => {
      assertNotDestroyed()
      const id = randomUUID()
      if (!errorListeners.has(name)) errorListeners.set(name, new Map())
      errorListeners.get(name).set(id, callback)
      return () => {
        const map = errorListeners.get(name)
        if (map) map.delete(id)
      }
    }

    Object.defineProperty(accessor, "state", {
      get() {
        return getState(name)
      },
    })

    accessor.poll = (fn, interval) => {
      poll(name, fn, interval)
      return accessor
    }

    accessor.stop = () => {
      stop(name)
    }

    accessor.remove = () => {
      remove(name)
    }

    accessor.removeTree = () => {
      removeTree(name)
    }

    Object.defineProperty(accessor, "name", {
      value: name,
      writable: false,
    })

    return accessor
  }

  let initialComputeScheduled = false

  function cell(name, valueOrFn, maybeOptions) {
    assertNotDestroyed()
    if (cells.has(name)) throw new Error(`cell already exists: ${name}`)

    if (typeof valueOrFn === "function") {
      const fn = valueOrFn
      const opts = maybeOptions || {}
      const debounce = opts.debounce ? ms(opts.debounce) : 0

      const c = makeCell(name, { type: "computed", deps: [], fn, debounce, equals: opts.equals })
      cells.set(name, c)

      const acc = createAccessor(name)
      accessors.set(name, acc)

      if (!options.redis) {
        scheduleInitialComputeBatch()
      }

      return acc
    }

    const c = makeCell(name, { type: "source", value: valueOrFn })
    cells.set(name, c)
    rebuildDependents()

    const acc = createAccessor(name)
    accessors.set(name, acc)

    if (!options.redis) scheduleInitialComputeBatch()

    return acc
  }

  function scheduleInitialComputeBatch() {
    if (initialComputeScheduled) return
    initialComputeScheduled = true
    queueMicrotask(() => {
      initialComputeScheduled = false
      runInitialComputes()
    })
  }

  function runInitialComputes() {
    let didCompute = true
    while (didCompute) {
      didCompute = false
      for (const [name, c] of cells) {
        if (c.type === "computed" && c.status === "uninitialized") {
          computeSync(name)
          if (c.status === "current" || c.status === "error") {
            didCompute = true
          }
        }
      }
    }

    for (const [name, c] of cells) {
      if (c.type === "computed" && c.status === "uninitialized" && !initialComputePromises.has(name)) {
        triggerInitialCompute(name)
      }
    }
  }

  async function runSingleCompute(name) {
    const c = cells.get(name)
    if (!c || c.type !== "computed") return false

    if (redis) {
      const lockKey = `lock:compute:${name}:${c.generation}`
      const acquired = await redis.acquireLock(lockKey, lockTtl).catch(() => false)
      if (!acquired) return false
      try {
        return await executeCompute(name)
      } finally {
        await redis.releaseLock(lockKey)
      }
    }

    return await executeCompute(name)
  }

  async function ensureDepsReady(deps) {
    for (const depName of deps) {
      const dep = cells.get(depName)
      if (dep && dep.type === "computed" && (dep.status === "uninitialized" || dep.status === "pending")) {
        if (dep.status === "uninitialized") {
          triggerInitialCompute(depName)
        }
        const p = initialComputePromises.get(depName)
        if (p) await p
      }
    }
  }

  async function executeCompute(name) {
    const c = cells.get(name)
    if (!c) return false

    const gen = c.generation
    const wasError = c.status === "error"
    c.status = "pending"

    await ensureDepsReady(c.deps)

    const start = Date.now()
    try {
      const tracker = { deps: new Set() }
      const result = await tracking.run(tracker, c.fn)

      if (c.generation !== gen) return false

      const newDeps = tracker.deps
      newDeps.delete(name)

      if (!setsEqual(c.deps, newDeps)) {
        c.deps = newDeps
        rebuildDependents()

        try {
          topoSort(cells)
        } catch (err) {
          c.status = "error"
          c.error = err
          c.computeTime = Date.now() - start
          fireErrorListeners(name, err, getState(name))
          return false
        }
      }

      const oldValue = c.value
      c.value = result
      c.status = "current"
      c.error = null
      c.updatedAt = Date.now()
      c.computeTime = Date.now() - start

      if (!wasError && valuesEqual(oldValue, result, c.equals)) return false

      if (redis) {
        c.version++
        await redis.setValue(name, result, c.version).catch(() => {})
        await redis.publish({ type: "computed", name, value: result, version: c.version, source: redis.instanceId }).catch(() => {})
      }

      const state = getState(name)
      fireListeners(name, result, state)
      return true
    } catch (err) {
      if (c.generation !== gen) return false

      c.status = "error"
      c.error = err
      c.computeTime = Date.now() - start

      markDownstreamStale(name)

      const state = getState(name)
      fireErrorListeners(name, err, state)
      return false
    }
  }

  function setsEqual(a, b) {
    if (a.size !== b.size) return false
    for (const v of a) {
      if (!b.has(v)) return false
    }
    return true
  }

  function set(name, value) {
    assertNotDestroyed()
    const c = cells.get(name)
    if (!c) throw new Error(`cell not found: ${name}`)
    if (c.type === "computed") throw new Error(`cannot set computed cell: ${name}`)

    const oldValue = c.value
    c.version++
    c.value = value
    c.status = "current"
    c.updatedAt = Date.now()
    c.error = null

    if (valuesEqual(oldValue, value, c.equals)) return

    const state = getState(name)
    fireListeners(name, value, state)

    if (redis) {
      const ver = c.version
      redis.setValue(name, value, ver)
        .then(() => redis.publish({ type: "set", name, value, version: ver, source: redis.instanceId }))
        .catch(() => {})
    }

    startPropagation(name)
  }

  function startPropagation(sourceName) {
    const p = doPropagation(sourceName)
    activePropagations.add(p)
    p.finally(() => activePropagations.delete(p))
  }

  async function doPropagation(sourceName) {
    const downstream = getDownstream(cells, sourceName)
    if (downstream.size === 0) return

    for (const name of downstream) {
      const c = cells.get(name)
      if (c) c.generation++
    }

    const levels = topoLevels(cells, downstream)
    const changed = new Set([sourceName])

    for (const level of levels) {
      const eligible = level.filter(name => {
        const c = cells.get(name)
        if (!c) return false
        if ([...c.deps].some(d => cells.get(d)?.status === "error")) return false
        return [...c.deps].some(d => changed.has(d))
      })

      if (eligible.length === 0) continue

      const debounced = []
      const immediate = []
      for (const name of eligible) {
        const c = cells.get(name)
        if (c?.debounce > 0) {
          debounced.push(name)
        } else {
          immediate.push(name)
        }
      }

      for (const name of debounced) {
        scheduleDebouncedCompute(name)
      }

      const results = await Promise.all(
        immediate.map(async (name) => {
          const didChange = await runSingleCompute(name)
          return { name, didChange }
        })
      )

      for (const { name, didChange } of results) {
        if (didChange) changed.add(name)
      }
    }
  }

  function scheduleDebouncedCompute(name) {
    const c = cells.get(name)
    if (!c) return
    const existing = debounceTimers.get(name)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      debounceTimers.delete(name)
      const p = runSingleCompute(name).then((changed) => {
        if (changed) startPropagation(name)
      })
      activePropagations.add(p)
      p.finally(() => activePropagations.delete(p))
    }, c.debounce)
    timer.unref()
    debounceTimers.set(name, timer)
  }

  function markDownstreamStale(name) {
    const downstream = getDownstream(cells, name)
    for (const d of downstream) {
      const dc = cells.get(d)
      if (dc && dc.status !== "error" && dc.status !== "uninitialized") {
        dc.status = "stale"
      }
    }
  }

  function getState(name) {
    const c = cells.get(name)
    if (!c) return null
    return {
      value: c.value,
      status: c.status,
      error: c.error,
      updatedAt: c.updatedAt,
      computeTime: c.computeTime,
    }
  }

  function value(name) {
    const tracker = tracking.getStore()
    if (tracker) tracker.deps.add(name)
    const c = cells.get(name)
    if (!c || c.status === "uninitialized" || c.status === "error") return undefined
    return c.value
  }

  function snapshot() {
    const snap = {}
    for (const [name, c] of cells) {
      if (c.status !== "uninitialized" && c.status !== "error") {
        snap[name] = c.value
      }
    }
    return snap
  }

  function on(callback) {
    assertNotDestroyed()
    const id = randomUUID()
    wildcardListeners.set(id, callback)
    return () => wildcardListeners.delete(id)
  }

  function fireListeners(name, val, state) {
    const map = listeners.get(name)
    if (map) {
      for (const [, cb] of map) {
        try { cb(val, state) } catch {}
      }
    }
    for (const [, cb] of wildcardListeners) {
      try { cb(name, val, state) } catch {}
    }
  }

  function fireErrorListeners(name, error, state) {
    const map = errorListeners.get(name)
    if (map) {
      for (const [, cb] of map) {
        try { cb(error, state) } catch {}
      }
    }
  }

  function poll(name, fn, interval) {
    assertNotDestroyed()
    const c = cells.get(name)
    if (!c) throw new Error(`cell not found: ${name}`)
    if (c.type === "computed") throw new Error(`cannot poll computed cell: ${name}`)

    const intervalMs = ms(interval)
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new Error("poll interval must be a positive duration")
    }

    if (pollTimers.has(name)) {
      clearInterval(pollTimers.get(name))
    }

    async function doPoll() {
      if (destroyed) return

      if (redis) {
        const tickId = Math.floor(Date.now() / intervalMs)
        const lockKey = `poll:${name}:${tickId}`
        const acquired = await redis.acquireLock(lockKey, Math.max(intervalMs, 1000)).catch(() => false)
        if (!acquired) return
      }

      try {
        const result = await fn()
        set(name, result)
      } catch (err) {
        const c = cells.get(name)
        if (c) {
          c.status = "error"
          c.error = err
          markDownstreamStale(name)
          fireErrorListeners(name, err, getState(name))
        }
      }
    }

    const timer = setInterval(doPoll, intervalMs)
    timer.unref()
    pollTimers.set(name, timer)

    doPoll()

    return graph
  }

  function stop(name) {
    assertNotDestroyed()
    const timer = pollTimers.get(name)
    if (timer) {
      clearInterval(timer)
      pollTimers.delete(name)
    }
  }

  function remove(name) {
    assertNotDestroyed()

    for (const [n, c] of cells) {
      if (n !== name && c.deps.has(name)) {
        throw new Error(`cannot remove "${name}": "${n}" depends on it`)
      }
    }

    cleanupCell(name)
  }

  function removeTree(name) {
    assertNotDestroyed()
    const downstream = getDownstream(cells, name)
    const toRemove = [...downstream].reverse()
    for (const n of toRemove) {
      cleanupCell(n)
    }
    cleanupCell(name)
  }

  function cleanupCell(name) {
    const timer = pollTimers.get(name)
    if (timer) clearInterval(timer)
    pollTimers.delete(name)
    const dt = debounceTimers.get(name)
    if (dt) clearTimeout(dt)
    debounceTimers.delete(name)
    cells.delete(name)
    accessors.delete(name)
    listeners.delete(name)
    errorListeners.delete(name)
    rebuildDependents()
    if (redis) redis.deleteValue(name).catch(() => {})
  }

  function getCells() {
    const result = []
    for (const [name, c] of cells) {
      result.push({
        name,
        type: c.type,
        deps: [...c.deps],
        dependents: [...c.dependents],
        status: c.status,
      })
    }
    return result
  }

  async function ready() {
    if (!options.redis) return

    redis = createRedisManager(options.redis, prefix)
    await redis.connect()

    const cellNames = [...cells.keys()]
    if (cellNames.length > 0) {
      const stored = await redis.getAllValues(cellNames)
      for (const [name, data] of stored) {
        const c = cells.get(name)
        if (c && data) {
          c.value = data.value
          c.version = data.version || 0
          c.status = "current"
          c.updatedAt = Date.now()
        }
      }
    }

    for (const [name, c] of cells) {
      if (c.type === "computed" && c.status === "uninitialized") {
        triggerInitialCompute(name)
      }
    }

    redis.onSync("graph", (msg) => {
      if (msg.source === redis.instanceId) return

      const c = cells.get(msg.name)
      if (!c) return

      if (msg.version <= c.version) return

      const oldValue = c.value
      c.value = msg.value
      c.version = msg.version
      c.status = "current"
      c.error = null
      c.updatedAt = Date.now()

      if (!valuesEqual(oldValue, msg.value, c.equals)) {
        const state = getState(msg.name)
        fireListeners(msg.name, msg.value, state)

        if (msg.type === "set") {
          startPropagation(msg.name)
        }
      }
    })
  }

  async function destroy() {
    destroyed = true
    for (const timer of pollTimers.values()) clearInterval(timer)
    pollTimers.clear()
    for (const timer of debounceTimers.values()) clearTimeout(timer)
    debounceTimers.clear()
    await Promise.all(activePropagations).catch(() => {})
    cells.clear()
    accessors.clear()
    listeners.clear()
    errorListeners.clear()
    wildcardListeners.clear()
    if (redis) {
      await redis.disconnect()
      redis = null
    }
  }

  const graph = {
    cell,
    set,
    get: getState,
    value,
    snapshot,
    on,
    cells: getCells,
    ready,
    destroy,
  }

  return graph
}
