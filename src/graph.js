import ms from "@prsm/ms"
import { randomUUID } from "crypto"
import { topoSort, getDownstream, topoLevels, valuesEqual } from "./propagate.js"
import { createRedisManager } from "./redis.js"

const DEFAULT_LOCK_TTL = 30000
const DEFAULT_PREFIX = "cell:"

export function createGraph(options = {}) {
  const prefix = options.prefix ?? DEFAULT_PREFIX
  const lockTtl = ms(options.lockTtl ?? DEFAULT_LOCK_TTL)

  const cells = new Map()
  const listeners = new Map()
  const errorListeners = new Map()
  const wildcardListeners = new Map()
  const pollTimers = new Map()
  const debounceTimers = new Map()
  const activePropagations = new Set()
  let redis = null
  let destroyed = false

  function assertNotDestroyed() {
    if (destroyed) throw new Error("graph is destroyed")
  }

  function makeCell(name, config) {
    return {
      name,
      type: config.type,
      deps: config.deps || [],
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

  function allDepsReady(c) {
    return c.deps.every(d => {
      const dep = cells.get(d)
      return dep && (dep.status === "current" || dep.status === "stale")
    })
  }

  function cell(name, depsOrValue, fnOrOptions, maybeOptions) {
    assertNotDestroyed()
    if (cells.has(name)) throw new Error(`cell already exists: ${name}`)

    if (Array.isArray(depsOrValue)) {
      const deps = depsOrValue
      const fn = fnOrOptions
      const opts = maybeOptions || {}
      const debounce = opts.debounce ? ms(opts.debounce) : 0

      for (const dep of deps) {
        if (dep === name) throw new Error(`cycle detected: ${name} -> ${name}`)
      }

      const c = makeCell(name, { type: "computed", deps, fn, debounce, equals: opts.equals })
      cells.set(name, c)
      checkCycles(name)

      if (!options.redis && allDepsReady(c)) {
        scheduleInitialCompute(name)
      }

      return graph
    }

    const c = makeCell(name, { type: "source", value: depsOrValue })
    cells.set(name, c)
    if (!options.redis) resolveWaiting(name)

    return graph
  }

  function checkCycles(name) {
    try {
      topoSort(cells)
    } catch (err) {
      cells.delete(name)
      throw err
    }
  }

  function resolveWaiting(readyName) {
    for (const [name, c] of cells) {
      if (c.type !== "computed") continue
      if (c.status !== "uninitialized") continue
      if (!c.deps.includes(readyName)) continue
      if (!allDepsReady(c)) continue
      scheduleInitialCompute(name)
    }
  }

  function scheduleInitialCompute(name) {
    const c = cells.get(name)
    if (!c || c.type !== "computed") return
    if (c.status !== "uninitialized") return

    c.status = "pending"
    doInitialCompute(name)
  }

  function doInitialCompute(name) {
    queueMicrotask(() => {
      const p = runSingleCompute(name).then(() => {
        resolveWaiting(name)
      })
      activePropagations.add(p)
      p.finally(() => activePropagations.delete(p))
    })
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

  async function executeCompute(name) {
    const c = cells.get(name)
    if (!c) return false

    const gen = c.generation
    const wasError = c.status === "error"
    c.status = "pending"

    const depValues = c.deps.map(d => cells.get(d)?.value)

    const start = Date.now()
    try {
      const result = await c.fn(...depValues)

      if (c.generation !== gen) return false

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
        if (c.deps.some(d => cells.get(d)?.status === "error")) return false
        return c.deps.some(d => changed.has(d))
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

  function on(name, callback) {
    assertNotDestroyed()
    const id = randomUUID()
    if (name === "*") {
      wildcardListeners.set(id, callback)
      return () => wildcardListeners.delete(id)
    }
    if (!listeners.has(name)) listeners.set(name, new Map())
    listeners.get(name).set(id, callback)
    return () => {
      const map = listeners.get(name)
      if (map) map.delete(id)
    }
  }

  function onError(name, callback) {
    assertNotDestroyed()
    const id = randomUUID()
    if (!errorListeners.has(name)) errorListeners.set(name, new Map())
    errorListeners.get(name).set(id, callback)
    return () => {
      const map = errorListeners.get(name)
      if (map) map.delete(id)
    }
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
      if (n !== name && c.deps.includes(name)) {
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
    listeners.delete(name)
    errorListeners.delete(name)
    if (redis) redis.deleteValue(name).catch(() => {})
  }

  function getCells() {
    const result = []
    for (const [name, c] of cells) {
      const dependents = []
      for (const [n, other] of cells) {
        if (other.deps.includes(name)) dependents.push(n)
      }
      result.push({
        name,
        type: c.type,
        deps: [...c.deps],
        dependents,
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
      if (c.type === "computed" && c.status === "uninitialized" && allDepsReady(c)) {
        scheduleInitialCompute(name)
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
    onError,
    poll,
    stop,
    remove,
    removeTree,
    cells: getCells,
    ready,
    destroy,
  }

  return graph
}
