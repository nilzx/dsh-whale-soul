import { AsyncLocalStorage } from 'node:async_hooks'
import { lstatSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { MemoryError, assertId, failure } from './contracts.js'

export const MAINTENANCE_WRITER_PROTOCOL = '1.0.0'
export const MAINTENANCE_WRITER_CAPABILITY = 'maintenance-writer-registry-v1'
const fail = (code) => { throw new MemoryError(code) }
const catalogKey = Symbol.for('dsh.whale-soul.maintenance-writer-catalog.v1')
const catalog = globalThis[catalogKey] ??= { protocol_version: MAINTENANCE_WRITER_PROTOCOL, ports: new Set(), listeners: new Set() }
if (catalog.protocol_version !== MAINTENANCE_WRITER_PROTOCOL || !(catalog.ports instanceof Set) || !(catalog.listeners instanceof Set)) fail('MEMORY_WRITER_CATALOG_CONFLICT')

export function observeMaintenanceWriterPorts(listener) {
  if (typeof listener !== 'function') fail('INVALID_WRITER_OBSERVER')
  catalog.listeners.add(listener)
  for (const ref of catalog.ports) { const port = ref.deref(); if (port) listener(port); else catalog.ports.delete(ref) }
  return () => catalog.listeners.delete(listener)
}

export function discoverMaintenanceWriterPorts(scope) {
  const ports = []
  for (const ref of catalog.ports) {
    const port = ref.deref()
    if (!port) { catalog.ports.delete(ref); continue }
    try { if (port.snapshot(scope).writers.some((writer) => !writer.retired)) ports.push(port) }
    catch (error) { if (error.code !== 'MEMORY_PROVIDER_UNAVAILABLE') throw error }
  }
  return ports
}


export function maintenanceRoot(root) {
  let current = resolve(root), suffix = []
  for (;;) {
    try {
      const stat = lstatSync(current)
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail('UNSAFE_STORAGE_PATH')
      return join(realpathSync.native(current), ...suffix.reverse())
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      const parent = dirname(current)
      if (parent === current) fail('UNSAFE_STORAGE_PATH')
      suffix.push(current.slice(parent.length + (parent.endsWith('/') ? 0 : 1))); current = parent
    }
  }
}

export function assertMaintenanceWriterPort(provider) {
  const port = provider?.maintenance_writers
  if (!Array.isArray(provider?.capabilities) || !provider.capabilities.includes(MAINTENANCE_WRITER_CAPABILITY) ||
    port?.protocol_version !== MAINTENANCE_WRITER_PROTOCOL || ['admitStore', 'snapshot', 'acquire', 'subscribe'].some((name) => typeof port?.[name] !== 'function')) fail('MEMORY_MAINTENANCE_COVERAGE_UNVERIFIED')
  return port
}

/** Complete process-local coverage for stores created by one trusted provider. */
export function createMaintenanceWriterRegistry({ assertAvailable } = {}) {
  if (typeof assertAvailable !== 'function') fail('TRUSTED_WRITER_PROVIDER_REQUIRED')
  const records = new Map(), byStore = new WeakMap(), listeners = new Set(), spaces = new Map(), operations = new AsyncLocalStorage()
  const contextLeases = new WeakMap()
  let serial = 0, disposed = false
  const live = () => { if (disposed) fail('MEMORY_PROVIDER_UNAVAILABLE'); assertAvailable() }
  const keyOf = (root, spaceId) => `${maintenanceRoot(root)}\0${assertId(spaceId)}`
  const space = (key) => { let state = spaces.get(key); if (!state) spaces.set(key, state = { generation: 0, lease: null }); return state }
  const emit = (record, reason) => {
    const state = space(record.key); state.generation++
    state.lease?.controller.abort(new MemoryError('MEMORY_WRITER_ACTIVITY_CHANGED'))
    for (const listener of listeners) { try { listener({ root: record.root, memory_space_id: record.spaceId, generation: state.generation, reason }) } catch {} }
  }
  const list = (key) => {
    const output = []
    for (const [id, record] of records) {
      if (!record.store.deref() && !record.engine.deref() && !record.active) { records.delete(id); continue }
      if (record.key === key) output.push(record)
    }
    return output
  }
  const validOwner = (record) => {
    if (!record.owner || typeof record.isCurrent !== 'function') return false
    let result
    try { result = record.isCurrent() } catch { return false }
    return result === true
  }
  const enter = async (record, method, callback) => {
    live()
    if (record.retired) fail('MEMORY_WRITER_RETIRED')
    const parent = operations.getStore(), state = space(record.key), lease = state.lease
    if (lease && parent?.lease !== lease) {
      emit(record, 'held-context-operation')
      await lease.done
      return enter(record, method, callback)
    }
    if (parent?.active?.has(record)) {
      if (!lease) return callback()
      if (method === 'locked' && parent.engineStage === 'run') return operations.run({ ...parent, engineStage: 'locked' }, callback)
      emit(record, 'unscoped-engine-operation'); fail('MEMORY_WRITER_UNSCOPED_OPERATION')
    }
    if (lease) {
      lease.check()
      if (parent?.publicStore !== record) { emit(record, 'unscoped-engine-operation'); fail('MEMORY_WRITER_UNSCOPED_OPERATION') }
    }
    else emit(record, 'operation-start')
    record.active++
    try { return await operations.run({ lease: parent?.lease ?? null, active: new Set([...(parent?.active ?? []), record]), engineStage: method, publicStore: parent?.publicStore }, callback) }
    finally { record.active--; if (!lease) emit(record, 'operation-end') }
  }
  const registry = {
    protocol_version: MAINTENANCE_WRITER_PROTOCOL,
    registerStore(store) {
      live()
      if (!store?.engine || typeof store.engine.run !== 'function' || typeof store.engine.locked !== 'function' || byStore.has(store)) fail('INVALID_WRITER_STORE')
      const record = { id: `writer-${++serial}`, root: maintenanceRoot(store.root), spaceId: assertId(store.memorySpaceId), store: new WeakRef(store), engine: new WeakRef(store.engine), owner: null, host: null, isCurrent: null, retired: false, active: 0 }
      record.key = keyOf(record.root, record.spaceId); byStore.set(store, record); records.set(record.id, record)
      for (const name of ['run', 'locked']) {
        const actual = store.engine[name]
        Object.defineProperty(store.engine, name, { configurable: false, writable: false, value: function (...args) { return enter(record, name, () => actual.apply(this, args)) } })
      }
      const issueContext = store.issueContext, authorize = store._authorize
      record.issueContext = issueContext
      Object.defineProperty(store, 'issueContext', { configurable: false, writable: false, value: function (...args) {
        if (record.retired) fail('MEMORY_WRITER_RETIRED')
        const context = issueContext.apply(this, args), current = operations.getStore(), lease = space(record.key).lease
        if (lease && current?.minting === record && current.lease === lease) contextLeases.set(context, lease.token)
        return context
      } })
      Object.defineProperty(store, '_authorize', { configurable: false, writable: false, value: function (context, ...args) {
        if (record.retired) fail('MEMORY_WRITER_RETIRED')
        const lease = space(record.key).lease, token = contextLeases.get(context)
        if (lease && (token !== lease.token || operations.getStore()?.lease !== lease)) { emit(record, 'held-context-authorization'); fail('MEMORY_WRITER_CONTEXT_NOT_ADMITTED') }
        if (!lease && token) fail('MEMORY_MAINTENANCE_CONTEXT_EXPIRED')
        return authorize.call(this, context, ...args)
      } })
      const contextIndex = { proposeMemory: 1, reviseMemory: 1, queryMemory: 1, rebuildIndex: 0, managedTransaction: 3, managedRead: 0 }
      for (const [name, index] of Object.entries(contextIndex)) {
        const actual = store[name]
        if (typeof actual !== 'function') fail('INVALID_WRITER_STORE')
        Object.defineProperty(store, name, { configurable: false, writable: false, value: function (...args) {
          const lease = space(record.key).lease, parent = operations.getStore()
          if (lease && parent?.lease === lease) {
            if (contextLeases.get(args[index]) !== lease.token) { emit(record, 'held-context-authorization'); return Promise.resolve(failure(new MemoryError('MEMORY_WRITER_CONTEXT_NOT_ADMITTED'))) }
            return operations.run({ ...parent, publicStore: record }, () => actual.apply(this, args))
          }
          return actual.apply(this, args)
        } })
      }
      emit(record, 'store-created')
      return store
    },
    admitStore(store, { owner, host, isCurrent } = {}) {
      live(); const record = byStore.get(store)
      if (!record || record.retired || !owner || typeof owner !== 'object' || !host || typeof host !== 'object' || typeof isCurrent !== 'function') fail('INVALID_WRITER_ADMISSION')
      if (record.owner && (record.owner !== owner || record.host !== host)) fail('WRITER_OWNER_CONFLICT')
      record.owner = owner; record.host = host; record.isCurrent = isCurrent; emit(record, 'store-admitted')
      let released = false
      return () => { if (released) return; released = true; record.retired = true; record.owner = null; record.host = null; record.isCurrent = null; emit(record, 'store-retired') }
    },
    snapshot({ root, memory_space_id }) {
      live(); const key = keyOf(root, memory_space_id), state = space(key)
      return Object.freeze({ protocol_version: MAINTENANCE_WRITER_PROTOCOL, root: maintenanceRoot(root), memory_space_id,
        generation: state.generation, reserved: !!state.lease,
        writers: Object.freeze(list(key).map((record) => Object.freeze({ writer_id: record.id, owner: record.owner, host: record.host, retired: record.retired, admitted: record.retired || validOwner(record), inflight: record.active }))) })
    },
    acquire({ root, memory_space_id, owners, host }) {
      live(); const key = keyOf(root, memory_space_id), state = space(key)
      if (!(owners instanceof Set) || !owners.size || !host || typeof host !== 'object') fail('INVALID_WRITER_LEASE')
      if (state.lease) fail('MEMORY_WRITER_COORDINATOR_BUSY')
      const checkWriters = () => {
        live()
        for (const record of list(key)) {
          if (record.retired) continue
          if (!validOwner(record) || !owners.has(record.owner)) fail('MEMORY_MAINTENANCE_UNKNOWN_WRITER')
          if (record.host !== host) fail('MEMORY_MAINTENANCE_HOST_CONFLICT')
          if (record.active && operations.getStore()?.lease !== state.lease) fail('MEMORY_WRITER_BUSY')
        }
      }
      checkWriters()
      const controller = new AbortController(), generation = state.generation
      let finish, released = false
      const done = new Promise((resolve) => { finish = resolve })
      const lease = { controller, done, token: Symbol('memory-maintenance-context'),
        check() { live(); if (released || state.lease !== lease || controller.signal.aborted || state.generation !== generation) fail('MEMORY_WRITER_LEASE_CHANGED'); checkWriters(); return true },
        run(task) { lease.check(); return operations.run({ lease, active: new Set() }, task) },
        release() { if (released) return; released = true; if (state.lease === lease) state.lease = null; finish() },
      }
      state.lease = lease
      return Object.freeze({ signal: controller.signal, issueContext(store, options) {
        lease.check(); const record = byStore.get(store)
        if (!record || record.key !== key || !owners.has(record.owner) || record.host !== host || record.retired) fail('INVALID_WRITER_ADMISSION')
        return operations.run({ lease, active: new Set(), minting: record }, () => store.issueContext(options))
      }, check: lease.check, run: lease.run, release: lease.release, generation })
    },
    subscribe(listener) { live(); if (typeof listener !== 'function') fail('INVALID_WRITER_OBSERVER'); listeners.add(listener); return () => listeners.delete(listener) },
    dispose() { if (disposed) return; disposed = true; for (const state of spaces.values()) state.lease?.controller.abort(new MemoryError('MEMORY_PROVIDER_UNAVAILABLE')); for (const record of records.values()) record.retired = true; listeners.clear() },
  }
  const port = Object.freeze(registry)
  catalog.ports.add(new WeakRef(port))
  for (const listener of catalog.listeners) { try { listener(port) } catch {} }
  return port
}
