# @prsm/cell

reactive computation graph. define named cells with dependencies - values propagate automatically when upstream changes. async-first: transformations can call LLMs, APIs, databases, anything. distributed by default via Redis (same model as @prsm/cron). designed to feed realtime UIs.

## what it is

a DAG of named cells. each cell holds a value. when a cell's value changes, all downstream cells recompute automatically. cells are either **sources** (values pushed in externally or via polling) or **computed** (values derived from other cells, sync or async).

the mental model is a spreadsheet. cell A1 is a price. cell B1 is a tax rate. cell C1 is `=A1 * (1 + B1)`. when you change A1, C1 updates. now imagine A1 polls a stock API every 10 seconds and C1 calls an LLM to generate analysis. that's @prsm/cell.

## design principles

- async-first. any cell computation can return a promise. LLM calls, API fetches, database queries - all first-class
- distributed by default. provide Redis and the graph works across multiple instances with no code changes. cell values live in Redis, computation is lock-coordinated so only one instance runs each handler. no redundant work
- without Redis, the graph works purely in-process. good for tests, scripts, single-instance apps
- explicit dependencies. no dependency inference, no proxy magic. you declare what a cell depends on by name
- introspectable. graph topology and cell states are always queryable. devtools-friendly
- no framework coupling. the graph is a standalone computation primitive. integration with @prsm/realtime or anything else happens outside the graph via event handlers

## tech constraints

- plain javascript, ESM, no typescript, no build step
- package ships raw .js files
- runtime dependencies: @prsm/ms (duration parsing), redis (node-redis, for distributed mode)
- node >= 20
- vitest for tests

## package setup

- name: `@prsm/cell`
- `"type": "module"` in package.json
- single entry point: `import { createGraph } from "@prsm/cell"`

## API

### `createGraph(options?)`

factory function. returns a graph instance (plain object with methods, not a class).

```js
import { createGraph } from "@prsm/cell"

// in-process only (good for tests, single instance)
const g = createGraph()

// distributed (cell values in Redis, computation lock-coordinated)
const g = createGraph({
  redis: { host: "127.0.0.1", port: 6379 }
})

await g.ready()
```

options:
- `redis` - optional. `{ url?, host?, port?, password? }` passed to node-redis `createClient`. when provided, the graph operates in distributed mode
- `prefix` - optional. Redis key prefix, default `"cell:"`

### `g.ready()` - initialize

```js
await g.ready()
```

connects to Redis (if configured), subscribes to pub/sub for cross-instance sync, and restores current cell values from Redis. no-op in local mode. must be called before `set`/`get` in distributed mode.

### `g.cell(name, value)` - define a source cell

```js
g.cell("tax-rate", 0.08)
g.cell("config", { theme: "dark", locale: "en" })
```

sets a source cell with a static initial value. source cells are updated externally via `g.set()`.

### `g.cell(name, deps, fn, options?)` - define a computed cell

```js
// sync
g.cell("total", ["price", "tax-rate"], (price, tax) => price * (1 + tax))

// async
g.cell("analysis", ["price"], async (price) => {
  const response = await llm.complete(`analyze BTC at $${price}`)
  return response.text
})

// with options
g.cell("summary", ["analysis", "price"], async (analysis, price) => {
  return await generateSummary(analysis, price)
}, { debounce: "2s" })
```

deps is an array of cell names this cell depends on. fn receives resolved dependency values as positional args in the same order as deps. fn can be sync or async.

options:
- `debounce` - duration string or ms. if deps change rapidly, wait this long after the last change before recomputing. prevents expensive async work from firing on every upstream tick

### `g.set(name, value)` - update a source cell

```js
g.set("tax-rate", 0.10)
g.set("config", { theme: "light", locale: "en" })
```

triggers recomputation of all downstream cells. throws if the cell is a computed cell (computed cells derive their values, they don't accept manual input).

in distributed mode: writes the value to Redis and publishes a change event. all instances see the new value. only one instance (the lock winner) runs downstream computations.

### `g.get(name)` - read cell state

```js
const state = g.get("total")
// {
//   value: 108,
//   status: "current",   // "pending" | "current" | "stale" | "error" | "uninitialized"
//   error: null,
//   updatedAt: 1711036800000,
//   computeTime: 2          // ms taken by last computation
// }
```

returns the full cell state, not just the value. this is intentional - callers should know if a value is stale or errored.

in distributed mode: reads from the local cache (kept in sync via Redis pub/sub). does not hit Redis on every call.

### `g.value(name)` - read just the value

```js
const total = g.value("total") // 108
```

convenience shorthand. returns `undefined` if cell hasn't computed yet or is in error.

### `g.on(name, callback)` - observe value changes

```js
const off = g.on("total", (value, state) => {
  console.log("total changed:", value)
  server.writeChannel("dashboard:total", value)
})

// later
off() // unsubscribe
```

callback receives `(value, state)` where state is the same shape as `g.get()`. fires only when the cell has a new value (not on errors - use `g.onError` for that). returns an unsubscribe function.

in distributed mode: fires on ALL instances when a cell value changes, not just the instance that computed it. every instance receives the new value via pub/sub and fires its local listeners. this is correct because listeners are typically used for side effects that should happen locally (logging, updating local state, sending to locally-connected WebSocket clients, etc).

### `g.on("*", callback)` - observe any cell change

```js
g.on("*", (name, value, state) => {
  console.log(`${name} changed:`, value)
})
```

wildcard listener fires whenever any cell in the graph produces a new value. callback receives `(name, value, state)`. useful for syncing the entire graph to a realtime record (see "streaming the graph to clients" below).

in distributed mode: fires on all instances, same as named listeners.

### `g.snapshot()` - serialize all cell values

```js
const snap = g.snapshot()
// { "price": 100, "tax-rate": 0.08, "total": 108, "analysis": "..." }
```

returns a plain object mapping cell names to their current values. cells that are uninitialized or in error state are omitted. useful for writing the entire graph as a single realtime record.

### `g.onError(name, callback)` - observe errors

```js
const off = g.onError("analysis", (error, state) => {
  console.error("analysis failed:", error.message)
})
```

fires when a cell's computation throws or rejects. returns an unsubscribe function.

### `g.poll(name, fn, interval)` - auto-refresh a source cell

```js
g.cell("btc-price", 0)
g.poll("btc-price", async () => {
  const res = await fetch("https://api.example.com/price/btc")
  return (await res.json()).price
}, "10s")
```

calls fn on the given interval and sets the cell's value with the result. fn can be async. interval is a duration string (parsed by @prsm/ms) or milliseconds. throws if the cell is a computed cell.

if fn throws, the cell enters error state. polling continues - the next successful poll clears the error.

in distributed mode: polling uses the same lock mechanism as cron - only one instance polls per interval tick. this prevents five instances from all hitting the same external API every 10 seconds. the lock key is `${prefix}poll:${name}:${tickId}` where `tickId = Math.floor(Date.now() / intervalMs)`.

### `g.stop(name)` - stop polling a cell

```js
g.stop("btc-price")
```

stops the polling interval for a source cell on this instance. the cell retains its last value.

### `g.remove(name)` - remove a cell

```js
g.remove("analysis")
```

removes a cell from the graph. stops any polling. throws if other cells depend on it (remove dependents first, or use `g.removeTree(name)` to remove a cell and all its downstream dependents).

### `g.removeTree(name)` - remove a cell and all dependents

```js
g.removeTree("price")
// removes "price" and everything downstream of it
```

### `g.cells()` - introspect the graph

```js
const info = g.cells()
// [
//   { name: "price", type: "source", deps: [], dependents: ["total", "analysis"], status: "current" },
//   { name: "tax-rate", type: "source", deps: [], dependents: ["total"], status: "current" },
//   { name: "total", type: "computed", deps: ["price", "tax-rate"], dependents: [], status: "current" },
//   { name: "analysis", type: "computed", deps: ["price"], dependents: ["summary"], status: "pending" },
// ]
```

returns the full graph topology with current statuses. useful for devtools integration and debugging.

### `g.destroy()` - tear down the graph

```js
await g.destroy()
```

stops all polling, clears all cells, removes all listeners. disconnects Redis clients if in distributed mode. the graph is unusable after this.

## behavior

### distributed mode

when `redis` is provided to `createGraph()`, the graph operates in distributed mode. the model follows the same pattern as @prsm/cron: every instance defines the same graph, Redis ensures coordination.

**how it works:**

1. **cell values live in Redis.** stored as `${prefix}value:${name}` (JSON-serialized). every instance maintains a local cache that stays in sync via pub/sub
2. **`g.set()` writes to Redis and publishes.** the change is published on `${prefix}changed` with the cell name. all instances receive the update and refresh their local cache
3. **computed cells use lock-based exactly-once execution.** when a source cell changes and downstream cells need recomputing, instances compete for a lock: `SET ${prefix}lock:${name} ${instanceId} NX PX ${ttl}`. the winner runs the handler function, writes the result to Redis, and publishes. losers do nothing - they receive the computed result via pub/sub like everyone else
4. **`g.on()` fires on every instance.** when a value changes (whether computed locally or received via pub/sub), all instances fire their local listeners. this is the correct behavior: listeners are for local side effects (logging, writing to locally-connected clients, etc)
5. **polling is lock-coordinated.** same as @prsm/cron - only one instance runs the poll function per interval tick. prevents redundant external API calls

**what this means in practice:**

- define the same graph on every instance. same cells, same deps, same handlers
- call `g.set()` from any instance. the value propagates everywhere
- expensive async computations (LLM calls, API fetches) run exactly once, on whichever instance wins the lock. the result is distributed to all instances via Redis
- `g.on()` listeners fire on every instance, so each instance can react locally (e.g. push to its own connected WebSocket clients)

**lock TTL:** the default lock TTL should be generous enough to cover async computations. default `"30s"`, configurable via `createGraph({ lockTtl: "2m" })`. if a computation exceeds the TTL, another instance may re-acquire the lock and recompute (safe because cell writes are idempotent - last write wins with version checking).

### propagation

when a source cell changes (via `set` or `poll`), the graph recomputes all downstream cells in topological order. sync cells compute immediately. async cells compute concurrently where possible (two async cells that don't depend on each other can run in parallel).

propagation is **breadth-first by topological level**. given:

```
price -> total -> display
price -> analysis -> display
```

when price changes: total and analysis compute (potentially in parallel since they're on the same level), then display computes after both resolve.

in distributed mode, the instance that wins the lock for a given propagation chain runs the entire chain. it doesn't release and re-lock per cell - it holds the propagation lock for the full topological walk. this keeps things simple and prevents interleaving issues.

### async recomputation and staleness

if a cell is currently computing (async) and a dependency changes:
1. the in-flight computation is NOT cancelled (no AbortSignal - keeps things simple)
2. the cell is marked `stale`
3. when the in-flight computation finishes, its result is **discarded** because deps changed
4. the cell immediately recomputes with fresh dependency values

this prevents stale results from briefly appearing. the cell stays at its previous value until the recomputation with current deps completes.

### error handling

if a cell's computation throws:
- the cell enters `error` status
- the cell retains its last good value (accessible via `state.value`)
- `g.onError` listeners fire
- downstream cells do NOT recompute. they keep their last good values and are marked `stale`
- when the errored cell next produces a good value (e.g. next poll succeeds, or deps change and recompute succeeds), downstream cells recompute and `stale` clears

rationale: for UI dashboards, slightly stale data is better than no data. you'd rather show a 10-second-old price than a blank screen because one LLM call failed.

### debouncing

computed cells with `debounce` set will wait for the specified duration after the last dependency change before recomputing. if deps change again within the debounce window, the timer resets. this prevents expensive async operations from firing on every rapid upstream change.

```js
// if price updates every second, analysis recomputes at most once every 5 seconds
g.cell("analysis", ["price"], async (price) => {
  return await expensiveLLMCall(price)
}, { debounce: "5s" })
```

in distributed mode: the debounce timer runs on the instance that will attempt computation. debounce resets are driven by pub/sub change events, so all instances see the same change cadence.

### cycle detection

defining a cell that would create a cycle throws immediately:

```js
g.cell("a", ["b"], (b) => b + 1)
g.cell("b", ["a"], (a) => a + 1)
// throws: "cycle detected: b -> a -> b"
```

### late dependency resolution

cells can be defined before their dependencies exist. a computed cell won't compute until all its dependencies are defined and have values.

```js
g.cell("total", ["price", "tax"], (p, t) => p * (1 + t))  // won't compute yet
g.cell("price", 100)  // still waiting on "tax"
g.cell("tax", 0.08)   // now all deps exist, "total" computes -> 108
```

the cell stays in `uninitialized` status until all deps are available.

### equality check

before propagating, the graph checks if a cell's new value actually changed (via `===` for primitives, or JSON.stringify comparison for objects). if the value is the same, downstream cells are NOT recomputed. this prevents unnecessary cascade.

configurable per-cell if needed:

```js
g.cell("data", ["source"], (s) => transform(s), {
  equals: (prev, next) => prev.id === next.id
})
```

if `equals` is not provided, default behavior: `===` for primitives, `JSON.stringify` comparison for objects/arrays.

## integration with @prsm/realtime

the graph itself has no knowledge of realtime. integration is done externally via the event API. this keeps the library decoupled.

### sourcing from realtime records

```js
import { RealtimeClient } from "@prsm/realtime/client"
import { createGraph } from "@prsm/cell"

const client = new RealtimeClient("ws://localhost:8080")
await client.connect()

const g = createGraph()
g.cell("settings", null)
g.cell("portfolio", null)

client.subscribeRecord("settings:1", (update) => {
  g.set("settings", update.full ?? update.patch)
})

client.subscribeRecord("portfolio:1", (update) => {
  g.set("portfolio", update.full ?? update.patch)
})

g.cell("risk-score", ["settings", "portfolio"], async (settings, portfolio) => {
  return await calculateRisk(portfolio, settings.riskTolerance)
})
```

### sinking to realtime channels/records

```js
import { RealtimeServer } from "@prsm/realtime"

const server = new RealtimeServer({ redis: { host: "127.0.0.1", port: 6379 } })

g.on("risk-score", (value) => {
  server.writeChannel("dashboard:risk", { score: value, timestamp: Date.now() })
})

g.on("portfolio-summary", (value) => {
  server.writeRecord("computed:portfolio-summary", value)
})
```

### full example: realtime dashboard pipeline

```js
import { RealtimeServer } from "@prsm/realtime"
import { createGraph } from "@prsm/cell"

const server = new RealtimeServer({ redis: { host: "127.0.0.1", port: 6379 } })
server.exposeChannel(/^dashboard:/)
server.exposeRecord(/^computed:/)

const g = createGraph({
  redis: { host: "127.0.0.1", port: 6379 }
})

// sources: poll external APIs (only one instance polls per tick)
g.cell("btc-price", 0)
g.poll("btc-price", () => fetchPrice("BTC"), "5s")

g.cell("eth-price", 0)
g.poll("eth-price", () => fetchPrice("ETH"), "5s")

// computed: pure transforms (one instance computes, all instances see results)
g.cell("portfolio-value", ["btc-price", "eth-price"], (btc, eth) => {
  return (btc * holdings.btc) + (eth * holdings.eth)
})

g.cell("portfolio-change", ["portfolio-value"], (value) => {
  return { value, change: ((value - baseline) / baseline) * 100 }
})

// computed: async LLM analysis (debounced, runs on exactly one instance)
g.cell("market-analysis", ["btc-price", "eth-price"], async (btc, eth) => {
  return await llm.complete(
    `BTC: $${btc}, ETH: $${eth}. Brief market analysis.`
  )
}, { debounce: "30s" })

// sink to realtime (fires on every instance - each pushes to its own connected clients)
g.on("portfolio-change", (data) => {
  server.writeChannel("dashboard:portfolio", data)
})

g.on("market-analysis", (analysis) => {
  server.writeRecord("computed:market-analysis", { text: analysis, generatedAt: Date.now() })
})

await g.ready()
await server.listen(8080)
```

### streaming the entire graph to clients (patch mode)

the most powerful integration pattern: write the graph as a single realtime record. realtime's record system diffs the previous value and sends only JSON patches to subscribed clients.

```js
// server
const g = createGraph({
  redis: { host: "127.0.0.1", port: 6379 }
})

g.cell("price", 0)
g.cell("tax", 0.08)
g.cell("total", ["price", "tax"], (p, t) => p * (1 + t))
g.cell("analysis", ["price"], async (price) => {
  return await llm.complete(`analyze $${price}`)
}, { debounce: "10s" })

g.poll("price", () => fetchPrice(), "5s")

server.exposeRecord(/^graph:/)

g.on("*", () => {
  server.writeRecord("graph:dashboard", g.snapshot())
})
```

```js
// client
let dashboard = {}

client.subscribeRecord("graph:dashboard", (update) => {
  if (update.full) dashboard = update.full
  if (update.patch) dashboard = applyPatch(dashboard, update.patch).newDocument
  render(dashboard)
}, { mode: "patch" })

// first update:  full = { price: 100, tax: 0.08, total: 108 }
// price changes: patch = [{ op: "replace", path: "/price", value: 105 },
//                         { op: "replace", path: "/total", value: 113.4 }]
// LLM finishes:  patch = [{ op: "replace", path: "/analysis", value: "..." }]
```

the graph just dumps its state. realtime handles the diffing. the client gets minimal patches. no custom serialization, no manual change tracking.

note: in distributed mode with multiple instances, the `g.on("*")` listener fires on every instance. since all instances have the same snapshot (synced via Redis), calling `server.writeRecord` from multiple instances is safe - realtime's record versioning deduplicates identical writes.

## testing

use vitest. tests are split into two categories:

### local mode tests (no Redis)

no external dependencies needed.

1. **source cells** - set/get, type coercion, overwrite behavior
2. **computed cells (sync)** - basic propagation, multi-level chains, diamond dependencies
3. **computed cells (async)** - resolution, concurrent computation, staleness discard
4. **error handling** - error state, downstream staleness, recovery on next good value
5. **debouncing** - debounce window reset, final value correctness (use fake timers)
6. **polling** - interval accuracy, error recovery during polling (use fake timers)
7. **cycle detection** - direct cycles, indirect cycles, self-reference
8. **late dependency resolution** - cells defined before deps, computation triggers when deps arrive
9. **equality check** - no propagation when value unchanged, custom equals
10. **removal** - remove leaf cell, remove with dependents error, removeTree
11. **graph introspection** - cells() returns correct topology and statuses
12. **destroy** - stops all polling, clears state
13. **snapshot** - returns correct values, omits uninitialized/errored cells
14. **wildcard listener** - fires on any cell change with correct args

### distributed mode tests (requires Redis)

redis must be running on localhost:6379. each test file should flush its redis DB in beforeEach.

1. **cross-instance value sync** - g.set() on instance A, g.get() on instance B sees the new value
2. **exactly-once computation** - two instances with the same graph, only one runs the handler
3. **poll lock coordination** - only one instance polls per interval tick
4. **listener fires on all instances** - g.on() callback runs on both instances when value changes
5. **instance failover** - if the computing instance disconnects, another picks up
6. **rapid updates** - multiple g.set() calls in quick succession, all instances converge to the same final state

for distributed tests, create two graph instances pointed at the same Redis in the same test process. this simulates multi-instance behavior without needing separate processes.

## structure

```
src/
  index.js          - exports createGraph
  graph.js          - graph factory, public API
  propagate.js      - topological sort, change propagation, async scheduling
  redis.js          - Redis client management, pub/sub, locking
tests/
  local.test.js     - local mode tests (no Redis)
  distributed.test.js - distributed mode tests (requires Redis)
compose.yml         - Redis for local dev/tests
package.json
CLAUDE.md
```

## important implementation notes

- propagation must be topological. use kahn's algorithm or DFS-based topo sort. recompute the order when cells are added/removed
- async cells on the same topological level should run concurrently (Promise.all), not sequentially
- the staleness discard behavior (see "async recomputation and staleness" above) requires tracking a generation/version counter per cell. increment it when deps change. when an async computation finishes, check if the generation matches. if not, discard and recompute
- polling uses setInterval internally. timers should be unref'd so they don't keep the process alive (consistent with @prsm/cron behavior)
- debounce uses setTimeout internally, also unref'd
- the graph should handle diamond dependencies correctly. if A depends on B and C, and both B and C depend on D, changing D should only cause A to compute once (after both B and C have settled), not twice
- in distributed mode, use a single Redis pub/sub channel (`${prefix}sync`) for all cell value updates. messages should include `{ type: "set"|"computed", name, value, version }`. each instance filters and applies updates to its local cache
- the lock pattern for computation is: `SET ${prefix}lock:${name} ${instanceId} NX PX ${lockTtl}`. release via Lua script that checks the value matches (same pattern as @prsm/cron)
- in distributed mode, the propagation lock should cover the entire downstream chain from the changed source, not individual cells. this prevents two instances from interleaving computation of the same chain. the lock key for propagation is `${prefix}propagate:${sourceName}:${version}` where version is the source cell's new version number
- cell values in Redis should include a version counter to handle race conditions. when writing a computed result, check that the dependency versions haven't changed since computation started (optimistic concurrency)
