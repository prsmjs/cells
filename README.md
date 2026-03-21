<p align="center">
  <img src=".github/logo.svg" width="80" height="80" alt="cell logo">
</p>

<h1 align="center">@prsm/cells</h1>

A DAG of named cells. Each cell holds a value. When a cell changes, everything downstream recomputes automatically. Think spreadsheet - cell A1 is a price, B1 is a tax rate, C1 is `=A1 * (1 + B1)`. Now imagine A1 polls a stock API every 10 seconds and C1 calls an LLM to generate analysis. That's @prsm/cells.

Continuous reactive dataflow for the backend. Not a job runner, not a task queue - a living graph of derived state that stays current as its inputs change. Computations can be sync or async (API calls, LLM calls, database queries), and with Redis the same graph runs across multiple instances with exactly-once computation and automatic value sync.

## Installation

```bash
npm install @prsm/cells
```

Requires Node.js >= 20. Redis required only for distributed mode.

## Quick Start

```js
import { createGraph } from "@prsm/cells"

const g = createGraph()

g.cell("price", 100)
g.cell("tax", 0.08)
g.cell("total", ["price", "tax"], (price, tax) => price * (1 + tax))

g.on("total", (value) => console.log("total:", value))

g.set("price", 200) // total: 216
```

## Async Cells

Any cell computation can be async. Debounce prevents expensive work from firing on every upstream tick.

```js
g.cell("btc", 0)
g.poll("btc", () => fetchPrice("BTC"), "10s")

g.cell("analysis", ["btc"], async (price) => {
  return await llm.complete(`BTC at $${price}. Brief market analysis.`)
}, { debounce: "30s" })

g.cell("alert", ["btc", "analysis"], (price, analysis) => {
  return { price, analysis, timestamp: Date.now() }
})
```

Price polls every 10 seconds. Analysis recomputes at most every 30 seconds. Alert updates whenever either upstream settles. You describe the relationships - the graph handles when things run.

## Distributed Mode

Add Redis and the graph works across multiple instances with no code changes.

```js
const g = createGraph({
  redis: { host: "127.0.0.1", port: 6379 }
})

g.cell("price", 0)
g.cell("doubled", ["price"], (p) => p * 2)

await g.ready()
```

`set()` on instance A propagates to instance B. Computed handlers run exactly once (lock winner computes, result is broadcast to all). Polling is coordinated so only one instance hits the external API per interval tick. Listeners fire on every instance, so each can push to its own connected clients.

## API

### `createGraph(options?)`

```js
const g = createGraph()                                    // local mode
const g = createGraph({ redis: { host: "...", port: 6379 } }) // distributed
```

Options:
- `redis` - Redis connection config. When provided, enables distributed mode
- `prefix` - Redis key prefix (default `"cell:"`)
- `lockTtl` - Lock duration for computation (default `"30s"`)

### `g.cell(name, value)` - source cell

```js
g.cell("config", { theme: "dark" })
```

### `g.cell(name, deps, fn, options?)` - computed cell

```js
g.cell("total", ["price", "tax"], (price, tax) => price * (1 + tax))

g.cell("summary", ["data"], async (data) => {
  return await generateSummary(data)
}, { debounce: "5s" })
```

Options:
- `debounce` - Duration string or ms. Delays recomputation after rapid dep changes
- `equals` - Custom equality function `(prev, next) => boolean`

### `g.set(name, value)` - update a source cell

```js
g.set("price", 200)
```

### `g.get(name)` / `g.value(name)`

```js
g.get("total")   // { value: 216, status: "current", error: null, ... }
g.value("total") // 216
```

### `g.on(name, callback)` - observe changes

```js
const off = g.on("total", (value, state) => { ... })
off() // unsubscribe

g.on("*", (name, value, state) => { ... }) // wildcard
```

### `g.onError(name, callback)` - observe errors

```js
g.onError("analysis", (error, state) => { ... })
```

### `g.snapshot()` - all cell values

```js
g.snapshot() // { price: 100, tax: 0.08, total: 108 }
```

### `g.poll(name, fn, interval)` / `g.stop(name)` - auto-refresh a source

```js
g.cell("btc", 0)
g.poll("btc", () => fetchPrice("BTC"), "10s")
g.stop("btc")
```

### `g.remove(name)` / `g.removeTree(name)` - remove cells

### `g.cells()` - graph introspection

### `g.ready()` - initialize (required for distributed mode)

### `g.destroy()` - tear down

## Behavior

### Propagation

Changes propagate in topological order. Async cells at the same level compute concurrently.

### Diamond Dependencies

If A depends on B and C, and both depend on D, changing D computes B and C first, then A once (not twice).

### Staleness

If a cell is computing (async) and a dependency changes, the in-flight result is discarded. The cell recomputes with fresh values.

### Error Handling

Errored cells retain their last good value. Downstream cells are marked stale but keep their values. Recovery is automatic when the error clears.

### Equality

Before propagating, values are compared (`===` for primitives, `JSON.stringify` for objects). No change = no downstream recomputation.

## License

MIT
