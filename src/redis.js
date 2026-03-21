import { createClient } from "redis"
import { randomUUID } from "crypto"
import { mutex } from "@prsm/lock"

export function createRedisManager(options, prefix) {
  const instanceId = randomUUID()
  const client = createClient(options)
  client.on("error", () => {})
  const lock = mutex({ redis: options, prefix })

  let subClient = null
  let connected = false
  const listeners = new Map()

  async function connect() {
    await client.connect()
    await lock.peek("_warmup").catch(() => {})
    subClient = client.duplicate()
    subClient.on("error", () => {})
    await subClient.connect()
    await subClient.subscribe(`${prefix}sync`, (message) => {
      let parsed
      try {
        parsed = JSON.parse(message)
      } catch {
        return
      }
      for (const [, cb] of listeners) {
        cb(parsed)
      }
    })
    connected = true
  }

  async function disconnect() {
    connected = false
    if (subClient?.isOpen) {
      await subClient.unsubscribe(`${prefix}sync`).catch(() => {})
      await subClient.quit().catch(() => {})
    }
    if (client.isOpen) {
      await client.quit().catch(() => {})
    }
    await lock.close().catch(() => {})
  }

  function onSync(id, callback) {
    listeners.set(id, callback)
  }

  function offSync(id) {
    listeners.delete(id)
  }

  async function publish(data) {
    if (!connected) return
    await client.publish(`${prefix}sync`, JSON.stringify(data)).catch(() => {})
  }

  async function setValue(name, value, version) {
    if (!connected) return
    const data = JSON.stringify({ value, version })
    await client.set(`${prefix}value:${name}`, data)
  }

  async function getValue(name) {
    if (!connected) return null
    const raw = await client.get(`${prefix}value:${name}`)
    if (!raw) return null
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }

  async function getAllValues(cellNames) {
    if (!connected || cellNames.length === 0) return new Map()
    const keys = cellNames.map(n => `${prefix}value:${n}`)
    const results = await client.mGet(keys)
    const map = new Map()
    for (let i = 0; i < cellNames.length; i++) {
      if (results[i]) {
        try {
          map.set(cellNames[i], JSON.parse(results[i]))
        } catch {}
      }
    }
    return map
  }

  async function acquireLock(key, ttlMs) {
    if (!connected) return false
    const result = await lock.acquire(key, { ttl: ttlMs, id: instanceId })
    return result.acquired
  }

  async function releaseLock(key) {
    if (!connected) return
    await lock.release(key, instanceId).catch(() => {})
  }

  async function deleteValue(name) {
    if (!connected) return
    await client.del(`${prefix}value:${name}`).catch(() => {})
  }

  return {
    get instanceId() { return instanceId },
    get connected() { return connected },
    connect,
    disconnect,
    publish,
    setValue,
    getValue,
    getAllValues,
    acquireLock,
    releaseLock,
    deleteValue,
    onSync,
    offSync,
  }
}
