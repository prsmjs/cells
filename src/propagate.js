export function topoSort(cells) {
  const order = []
  const visited = new Set()
  const visiting = new Set()

  function visit(name) {
    if (visited.has(name)) return
    if (visiting.has(name)) {
      const cycle = [...visiting, name]
      const start = cycle.indexOf(name)
      throw new Error(`cycle detected: ${cycle.slice(start).join(" -> ")}`)
    }
    visiting.add(name)
    const cell = cells.get(name)
    if (cell) {
      for (const dep of cell.deps) {
        visit(dep)
      }
    }
    visiting.delete(name)
    visited.add(name)
    order.push(name)
  }

  for (const name of cells.keys()) {
    visit(name)
  }

  return order
}

export function getDownstream(cells, sourceName) {
  const downstream = new Set()
  const queue = [sourceName]

  while (queue.length > 0) {
    const current = queue.shift()
    for (const [name, cell] of cells) {
      if (cell.deps.has(current) && !downstream.has(name)) {
        downstream.add(name)
        queue.push(name)
      }
    }
  }

  return downstream
}

export function topoLevels(cells, names) {
  const levels = []
  const placed = new Set()
  const remaining = new Set(names)

  while (remaining.size > 0) {
    const level = []
    for (const name of remaining) {
      const cell = cells.get(name)
      if (!cell) continue
      const depsReady = [...cell.deps].every(d => !remaining.has(d) || placed.has(d))
      if (depsReady) level.push(name)
    }
    if (level.length === 0) break
    for (const name of level) {
      remaining.delete(name)
      placed.add(name)
    }
    levels.push(level)
  }

  return levels
}

export function valuesEqual(a, b, equalsFn) {
  if (equalsFn) return equalsFn(a, b)
  if (a === b) return true
  if (a == null || b == null) return false
  if (typeof a !== "object" || typeof b !== "object") return false
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}
