import { AsyncLocalStorage } from "node:async_hooks"
import ms from "@prsm/ms"
import { randomUUID } from "crypto"
import { topoSort, getDownstream, topoLevels, valuesEqual } from "./propagate.js"
import { createRedisManager } from "./redis.js"

const DEFAULT_LOCK_TTL = 30000
const DEFAULT_PREFIX = "cell:"
const DEFAULT_HISTORY_LIMIT = 100

/**
 * @typedef {Object} RedisOptions
 * Connection settings forwarded as-is to node-redis `createClient`. Providing this object switches the graph into distributed mode. Omit it to run purely in-process.
 * @property {string} [url] - full connection string, for example `redis://user:pass@host:6379/0`. Takes precedence over the discrete host/port fields below
 * @property {string} [host] - redis host (default `127.0.0.1`)
 * @property {number} [port] - redis port (default `6379`)
 * @property {string} [password] - password, if the server requires auth
 */

/**
 * @typedef {Object} GraphOptions
 * @property {RedisOptions} [redis] - redis connection settings. When set, cell values live in Redis, computation is lock-coordinated so each handler runs on exactly one instance, and value changes sync across instances via pub/sub. When omitted, the graph runs entirely in-process (good for tests, scripts, and single-instance apps)
 * @property {string} [prefix] - prefix for every Redis key this graph touches (default `"cell:"`). Only relevant in distributed mode. Use distinct prefixes to run independent graphs against one Redis database
 * @property {string|number} [lockTtl] - how long a compute or poll lock survives before it can be re-acquired, as a duration string (`"2m"`) or milliseconds (default `"30s"`). Set this longer than your slowest async handler. If a computation outlives the TTL another instance may recompute, which is safe because cell writes are versioned and last-write-wins
 * @property {object} [tracer] - optional `@prsm/trace` tracer. When set, every cell computation runs inside a `cells.compute` span tagged with the cell name and prefix
 */

/**
 * @typedef {Object} CellOptions
 * Options bag accepted by `cell`, `template`, and the source-cell form. Every field is optional.
 * @property {string|number} [debounce] - for computed cells, wait this long after the last dependency change before recomputing, as a duration string (`"2s"`) or milliseconds (default `0`, no debounce). If deps change again within the window the timer resets. Use this to keep an expensive async handler from firing on every rapid upstream tick
 * @property {(prev: any, next: any) => boolean} [equals] - custom equality test deciding whether a new value counts as a change. Returning `true` suppresses propagation and listeners. Defaults to `===` for primitives and a `JSON.stringify` comparison for objects and arrays
 * @property {boolean|number} [history] - keep a per-instance ring buffer of recent values. `true` enables it with a 100-entry limit; a positive number sets a custom limit (default off). History is in-memory only and is not synced across instances. Use `@prsm/workflow` for a durable audit trail
 * @property {object} [metadata] - free-form, opaque bag (descriptions, owner, units, tags) stored on the cell and surfaced through `cells()`. Does not affect propagation, compute, or any runtime behavior
 * @property {object} [source] - opaque descriptor of where a cell's values come from (polled API, webhook, queue worker, file watcher), surfaced through `cells()` for tooling. Does not affect any runtime behavior
 */

/**
 * @typedef {Object} CellState
 * The full state of a cell, returned by `get` and passed to value listeners.
 * @property {any} value - the cell's current value. Retained even while `status` is `stale` or `error`, so a dashboard can keep showing the last good value
 * @property {"uninitialized"|"pending"|"current"|"stale"|"error"} status - `uninitialized` (no value yet), `pending` (computing), `current` (value is fresh), `stale` (an upstream change or error means this value may be out of date but is still shown), or `error` (last computation threw)
 * @property {Error|null} error - the error from the last failed computation, or `null`
 * @property {number|null} updatedAt - epoch milliseconds of the last value update, or `null` if never updated
 * @property {number|null} computeTime - milliseconds the last computation took, or `null` for cells that have not computed
 */

/**
 * @typedef {Object} CellInfo
 * One entry in the topology returned by `cells`.
 * @property {string} name - the cell's name
 * @property {"source"|"computed"} type - whether values are pushed in (`source`) or derived from other cells (`computed`)
 * @property {"source"|"computed"|"template"} kind - like `type`, but distinguishes a `template` cell from a plain `computed` one so tooling can render it specially
 * @property {string[]} deps - names of the cells this cell depends on
 * @property {string[]} dependents - names of the cells that depend on this one
 * @property {"uninitialized"|"pending"|"current"|"stale"|"error"} status - the cell's current status
 * @property {object} [metadata] - present only when set via options
 * @property {object} [source] - present only when set via options
 * @property {string} [template] - the raw template body, present only on template cells
 * @property {number} [historyLimit] - the history ring-buffer size, present only when history is enabled
 */

/**
 * @typedef {Object} HistoryEntry
 * @property {any} value - the recorded value
 * @property {number} timestamp - epoch milliseconds when the value was recorded
 */

/**
 * @callback ValueListener
 * @param {any} value - the cell's new value
 * @param {CellState} state - the cell's full state at the time of the change
 * @returns {void}
 */

/**
 * @callback WildcardListener
 * @param {string} name - the name of the cell that changed
 * @param {any} value - the cell's new value
 * @param {CellState} state - the cell's full state at the time of the change
 * @returns {void}
 */

/**
 * @callback ErrorListener
 * @param {Error} error - the error thrown or rejected by the cell's computation
 * @param {CellState} state - the cell's full state at the time of the error
 * @returns {void}
 */

/**
 * @typedef {Object} ListenerOptions
 * Rate-limiting options for `Cell.on` and the wildcard `on`. At most one of `debounce` or `throttle` may be set.
 * @property {string|number} [debounce] - fire the listener only after this much quiet time has passed since the last change, as a duration string or milliseconds. Each new change resets the timer
 * @property {string|number} [throttle] - fire the listener at most once per this interval, as a duration string or milliseconds. The trailing change in a window still fires once the interval elapses
 */

/**
 * @callback PollFn
 * @returns {any|Promise<any>} the cell's next value. May be async (fetch, query, etc). If it throws, the cell enters error state and polling continues
 */

/**
 * A cell handle returned by `cell` and `template`. Calling it with no arguments reads
 * the current value (and registers a dependency when called inside another cell's handler);
 * calling it with one argument sets the value (source cells only). Carries methods for
 * observing, polling, and removing the cell.
 * @typedef {Object} Cell
 * @property {string} name - the cell's name (read-only)
 * @property {CellState} state - the cell's current state (read-only accessor)
 * @property {(value?: any) => any} __call - read the value with no args, or set it with one arg
 * @property {(callback: ValueListener, opts?: ListenerOptions) => (() => void)} on - subscribe to value changes. Returns an unsubscribe function. Does not fire on errors; use `onError`. In distributed mode this fires on every instance that has the cell defined
 * @property {(callback: ErrorListener) => (() => void)} onError - subscribe to computation errors. Returns an unsubscribe function
 * @property {(fn: PollFn, interval: string|number) => Cell} poll - refresh this source cell by calling `fn` every `interval` (duration string or ms). In distributed mode only one instance polls per tick. Throws if the cell is computed
 * @property {() => void} stop - stop polling this cell on this instance. The cell keeps its last value
 * @property {() => void} remove - remove this cell. Throws if other cells depend on it
 * @property {() => void} removeTree - remove this cell and everything downstream of it
 */

const tracking = new AsyncLocalStorage()

function parseTemplateDeps(str) {
  const deps = new Set()
  const re = /\{\{(?:#if\s+)?([\w-]+)(?:[.\[][^}]*?)?\}\}/g
  let m
  while ((m = re.exec(str)) !== null) deps.add(m[1])
  return [...deps]
}

function resolveBinding(key, bindings) {
  const parts = key.split(/[.\[\]]/).filter(Boolean)
  let current = bindings
  for (const part of parts) {
    if (current == null) return undefined
    current = current[part]
  }
  return current
}

function renderTemplate(str, bindings) {
  let result = str.replace(/\{\{#if\s+([\w\-.[\]]+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, key, body) => {
    const val = resolveBinding(key, bindings)
    return val ? body : ""
  })
  result = result.replace(/\{\{([\w\-.[\]]+)\}\}/g, (_, key) => {
    const val = resolveBinding(key, bindings)
    if (val === undefined || val === null) return ""
    if (typeof val === "object") return JSON.stringify(val)
    return String(val)
  })
  return result
}

function wrapListener(callback, opts) {
  if (!opts || (!opts.throttle && !opts.debounce)) return callback
  if (opts.throttle && opts.debounce) {
    throw new Error("throttle and debounce are mutually exclusive")
  }

  if (opts.throttle) {
    const wait = ms(opts.throttle)
    let lastFire = 0
    let pending = null
    let timer = null

    const fire = (args) => {
      lastFire = Date.now()
      try { callback(...args) } catch {}
    }

    const wrapped = (...args) => {
      const elapsed = Date.now() - lastFire
      if (elapsed >= wait) {
        pending = null
        if (timer) { clearTimeout(timer); timer = null }
        fire(args)
      } else {
        pending = args
        if (!timer) {
          timer = setTimeout(() => {
            timer = null
            if (pending) {
              const a = pending
              pending = null
              fire(a)
            }
          }, wait - elapsed)
          timer.unref?.()
        }
      }
    }

    wrapped._cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null }
      pending = null
    }
    return wrapped
  }

  const wait = ms(opts.debounce)
  let timer = null
  let pending = null

  const wrapped = (...args) => {
    pending = args
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      const a = pending
      pending = null
      try { callback(...a) } catch {}
    }, wait)
    timer.unref?.()
  }

  wrapped._cleanup = () => {
    if (timer) { clearTimeout(timer); timer = null }
    pending = null
  }
  return wrapped
}

/**
 * Create a reactive computation graph: a DAG of named cells where a change to one
 * cell propagates to everything downstream in topological order. Source cells hold
 * values pushed in externally; computed cells derive their values from other cells
 * and may be sync or async. Returns a plain object of methods, not a class.
 * @param {GraphOptions} [options]
 * @returns {Graph}
 */
export function createGraph(options = {}) {
  const tracer = options.tracer ?? null
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
  const histories = new Map()
  let redis = null
  let destroyed = false

  function assertNotDestroyed() {
    if (destroyed) throw new Error("graph is destroyed")
  }

  function makeCell(name, config) {
    return {
      name,
      type: config.type,
      kind: config.kind || config.type,
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
      metadata: config.metadata || null,
      source: config.source || null,
      historyLimit: config.historyLimit || 0,
      template: config.template || null,
    }
  }

  function recordHistory(name, value) {
    const c = cells.get(name)
    if (!c || c.historyLimit <= 0) return
    let buf = histories.get(name)
    if (!buf) {
      buf = []
      histories.set(name, buf)
    }
    buf.push({ value, timestamp: Date.now() })
    if (buf.length > c.historyLimit) buf.shift()
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

    accessor.on = (callback, opts) => {
      assertNotDestroyed()
      const wrapped = wrapListener(callback, opts)
      const id = randomUUID()
      if (!listeners.has(name)) listeners.set(name, new Map())
      listeners.get(name).set(id, wrapped)
      return () => {
        const map = listeners.get(name)
        if (map) {
          const fn = map.get(id)
          fn?._cleanup?.()
          map.delete(id)
        }
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

  function resolveHistoryLimit(opt) {
    if (opt === true) return DEFAULT_HISTORY_LIMIT
    if (typeof opt === "number" && opt > 0) return Math.floor(opt)
    return 0
  }

  /**
   * Define a cell. Pass a value to create a source cell whose value is pushed in via
   * the cell handle or `set`. Pass a function to create a computed cell: dependencies
   * are discovered automatically from the other cells the function reads, and the cell
   * recomputes whenever any of them change. The function may be sync or async (return a
   * promise to call an LLM, fetch an API, query a database, and so on).
   * @param {string} name - the cell name. Throws if a cell with this name already exists
   * @param {any|(() => any|Promise<any>)} valueOrFn - the initial value for a source cell, or the handler for a computed cell
   * @param {CellOptions} [maybeOptions]
   * @returns {Cell} a handle for reading, setting, observing, polling, and removing the cell
   */
  function cell(name, valueOrFn, maybeOptions) {
    assertNotDestroyed()
    if (cells.has(name)) throw new Error(`cell already exists: ${name}`)

    const opts = (typeof valueOrFn === "function" ? maybeOptions : maybeOptions) || {}
    const metadata = opts.metadata ?? null
    const source = opts.source ?? null
    const historyLimit = resolveHistoryLimit(opts.history)

    if (typeof valueOrFn === "function") {
      const fn = valueOrFn
      const debounce = opts.debounce ? ms(opts.debounce) : 0

      const c = makeCell(name, {
        type: "computed",
        deps: [],
        fn,
        debounce,
        equals: opts.equals,
        metadata,
        source,
        historyLimit,
      })
      cells.set(name, c)

      const acc = createAccessor(name)
      accessors.set(name, acc)

      if (!options.redis) {
        scheduleInitialComputeBatch()
      }

      return acc
    }

    const c = makeCell(name, {
      type: "source",
      value: valueOrFn,
      equals: opts.equals,
      metadata,
      source,
      historyLimit,
    })
    cells.set(name, c)
    rebuildDependents()

    if (valueOrFn !== undefined) {
      recordHistory(name, valueOrFn)
    }

    const acc = createAccessor(name)
    accessors.set(name, acc)

    if (!options.redis) scheduleInitialComputeBatch()

    return acc
  }

  /**
   * Define a computed cell whose value is a rendered template string. Dependencies are
   * discovered by parsing `{{...}}` references in the body: `{{path}}` resolves a dot or
   * bracket path against the referenced cell's value, `{{#if path}}...{{/if}}` includes
   * the body when the value is truthy, object values are JSON-stringified, and
   * null/undefined render as empty. The cell appears in `cells` with `kind: "template"`
   * and the raw body in `template`, giving tooling an exact audit trail of the rendered
   * prompt.
   * @param {string} name - the cell name. Throws if a cell with this name already exists
   * @param {string} str - the template body. Throws if not a string
   * @param {CellOptions} [maybeOptions]
   * @returns {Cell}
   */
  function template(name, str, maybeOptions) {
    assertNotDestroyed()
    if (typeof str !== "string") {
      throw new Error(`template body must be a string, got ${typeof str}`)
    }
    const opts = maybeOptions || {}
    const depNames = parseTemplateDeps(str)

    const fn = () => {
      const bindings = {}
      for (const dep of depNames) bindings[dep] = value(dep)
      return renderTemplate(str, bindings)
    }

    const acc = cell(name, fn, opts)
    const c = cells.get(name)
    if (c) {
      c.kind = "template"
      c.template = str
    }
    return acc
  }

  /**
   * Read the recent value history of a cell. Returns entries oldest-first. Only cells
   * created with the `history` option record history; others return `[]`. Entries are
   * recorded when the value actually changes (after the equality check). History is
   * per-instance and in-memory only, not synced across instances.
   * @param {string} name - the cell name
   * @param {number} [limit] - return only the most recent `limit` entries
   * @returns {HistoryEntry[]}
   */
  function history(name, limit) {
    const buf = histories.get(name)
    if (!buf) return []
    if (typeof limit === "number" && limit > 0) {
      return buf.slice(-limit)
    }
    return buf.slice()
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
      const result = tracer
        ? await tracer.span('cells.compute', { 'cell.name': name, 'cell.prefix': prefix }, () => tracking.run(tracker, c.fn))
        : await tracking.run(tracker, c.fn)

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

  /**
   * Update a source cell's value and propagate the change to all downstream cells. No-op
   * if the new value is equal to the current one (per the cell's equality test). In
   * distributed mode the value is written to Redis and published so every instance
   * converges, while downstream computation runs on whichever instance wins the lock.
   * @param {string} name - the cell name. Throws if the cell does not exist
   * @param {any} value - the new value. Throws if the cell is computed (computed cells derive their values)
   * @returns {void}
   */
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

  /**
   * Read a cell's full state, not just its value, so callers can tell whether a value is
   * fresh, stale, or errored. In distributed mode this reads from the local cache kept in
   * sync via pub/sub, so it does not hit Redis on every call.
   * @param {string} name - the cell name
   * @returns {CellState|null} the cell's state, or `null` if no such cell exists
   */
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

  /**
   * Read just a cell's current value, a convenience over `get(name).value`. Returns
   * `undefined` if the cell has not produced a value yet or is in error. Called inside a
   * computed cell's handler, it registers a dependency on the named cell.
   * @param {string} name - the cell name
   * @returns {any} the value, or `undefined`
   */
  function value(name) {
    const tracker = tracking.getStore()
    if (tracker) tracker.deps.add(name)
    const c = cells.get(name)
    if (!c || c.status === "uninitialized" || c.status === "error") return undefined
    return c.value
  }

  /**
   * Serialize every cell's current value into a plain object keyed by cell name. Cells
   * that are uninitialized or in error are omitted. Handy for writing the whole graph as
   * a single realtime record and letting the client diff it.
   * @returns {Object<string, any>}
   */
  function snapshot() {
    const snap = {}
    for (const [name, c] of cells) {
      if (c.status !== "uninitialized" && c.status !== "error") {
        snap[name] = c.value
      }
    }
    return snap
  }

  /**
   * Subscribe to changes on any cell in the graph (the wildcard listener). To observe a
   * single cell, use the handle returned by `cell`: `g.cell(name).on(cb)`. In distributed
   * mode this fires on every instance whenever a value changes, since listeners are meant
   * for local side effects (logging, pushing to locally-connected clients, and so on).
   * @param {WildcardListener} callback - receives `(name, value, state)` on every cell change
   * @param {ListenerOptions} [opts]
   * @returns {() => void} an unsubscribe function
   */
  function on(callback, opts) {
    assertNotDestroyed()
    const wrapped = wrapListener(callback, opts)
    const id = randomUUID()
    wildcardListeners.set(id, wrapped)
    return () => {
      const fn = wildcardListeners.get(id)
      fn?._cleanup?.()
      wildcardListeners.delete(id)
    }
  }

  function fireListeners(name, val, state) {
    recordHistory(name, val)
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
    histories.delete(name)
    rebuildDependents()
    if (redis) redis.deleteValue(name).catch(() => {})
  }

  /**
   * Return the full graph topology with each cell's current status: names, types, deps,
   * dependents, and any metadata, source, template, or history limit that was set. Useful
   * for devtools and debugging.
   * @returns {CellInfo[]}
   */
  function getCells() {
    const result = []
    for (const [name, c] of cells) {
      const entry = {
        name,
        type: c.type,
        kind: c.kind || c.type,
        deps: [...c.deps],
        dependents: [...c.dependents],
        status: c.status,
      }
      if (c.metadata) entry.metadata = c.metadata
      if (c.source) entry.source = c.source
      if (c.template) entry.template = c.template
      if (c.historyLimit > 0) entry.historyLimit = c.historyLimit
      result.push(entry)
    }
    return result
  }

  const REGISTRY_HEARTBEAT_MS = 15000
  const REGISTRY_TTL_SEC = 60
  let registryTimer = null

  async function writeRegistryNow() {
    if (!redis) return
    try { await redis.writeRegistry(getCells(), REGISTRY_TTL_SEC) } catch {}
  }

  /**
   * Gather each connected instance's view of the topology, keyed by instance id. Every
   * instance periodically publishes its `cells()` to Redis with a TTL, so this reflects
   * the live fleet. In local mode it returns a single `"local"` entry with this graph's
   * topology.
   * @returns {Promise<Object<string, CellInfo[]>>}
   */
  async function getTopologyAcrossInstances() {
    if (!redis) return { [redis?.instanceId ?? "local"]: getCells() }
    const remote = await redis.getAllRegistries()
    remote[redis.instanceId] = getCells()
    return remote
  }

  /**
   * Initialize distributed mode: connect to Redis, restore current cell values from
   * Redis, subscribe to the pub/sub sync channel, and start publishing this instance's
   * topology. Must be called before `set`/`get` when a `redis` option was provided. No-op
   * in local mode, so it is always safe to call.
   * @returns {Promise<void>}
   */
  async function ready() {
    if (!options.redis) return

    redis = createRedisManager(options.redis, prefix)
    await redis.connect()
    await writeRegistryNow()
    registryTimer = setInterval(() => { writeRegistryNow() }, REGISTRY_HEARTBEAT_MS)
    registryTimer.unref?.()

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

  /**
   * Tear down the graph: stop all polling and debounce timers, clear every cell, drop all
   * listeners, and disconnect the Redis clients in distributed mode. The graph is unusable
   * afterward.
   * @returns {Promise<void>}
   */
  async function destroy() {
    destroyed = true
    if (registryTimer) { clearInterval(registryTimer); registryTimer = null }
    for (const timer of pollTimers.values()) clearInterval(timer)
    pollTimers.clear()
    for (const timer of debounceTimers.values()) clearTimeout(timer)
    debounceTimers.clear()
    for (const map of listeners.values()) {
      for (const fn of map.values()) fn?._cleanup?.()
    }
    for (const fn of wildcardListeners.values()) fn?._cleanup?.()
    await Promise.all(activePropagations).catch(() => {})
    cells.clear()
    accessors.clear()
    listeners.clear()
    errorListeners.clear()
    wildcardListeners.clear()
    histories.clear()
    if (redis) {
      await redis.deleteRegistry().catch(() => {})
      await redis.disconnect()
      redis = null
    }
  }

  /**
   * @typedef {Object} Graph
   * @property {typeof cell} cell - define a source or computed cell
   * @property {typeof template} template - define a templated string cell
   * @property {typeof history} history - read a cell's recent value history
   * @property {typeof set} set - update a source cell and propagate downstream
   * @property {typeof getState} get - read a cell's full state
   * @property {typeof value} value - read just a cell's value
   * @property {typeof snapshot} snapshot - serialize all cell values to a plain object
   * @property {typeof on} on - subscribe to changes on any cell (wildcard listener)
   * @property {typeof getCells} cells - read the full graph topology with statuses
   * @property {typeof getTopologyAcrossInstances} cellsAcrossInstances - read every instance's topology, keyed by instance id
   * @property {typeof ready} ready - initialize distributed mode (no-op in local mode)
   * @property {typeof destroy} destroy - tear down the graph
   */
  const graph = {
    cell,
    template,
    history,
    set,
    get: getState,
    value,
    snapshot,
    on,
    cells: getCells,
    cellsAcrossInstances: getTopologyAcrossInstances,
    ready,
    destroy,
  }

  return graph
}
