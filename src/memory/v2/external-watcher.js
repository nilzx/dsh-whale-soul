import { watch as nativeWatch } from 'node:fs'
import { MemoryError, digest } from './contracts.js'

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const delay = (value, fallback, min, max) => Number.isInteger(value) && value >= min && value <= max ? value : fallback

/** One host-owned watcher per configured store, with observable fallback. */
export class MemoryExternalWatcher {
  #service; #context; #factory; #handles = []; #timer = null; #debounce = null
  #controller = new AbortController(); #running = null; #dirty = new Set(); #full = false
  #started = false; #disposed = false; #subscribers = new Set(); #lastDigest = null
  #pollMs; #debounceMs; #maxPages; #state

  constructor({ service, contextFactory, watchFactory = nativeWatch, pollIntervalMs = 1000,
    debounceMs = 40, maxPages = 100, simulatedFallback = false } = {}) {
    if (typeof service?.scan !== 'function' || typeof service?.list !== 'function' || typeof contextFactory !== 'function' || typeof watchFactory !== 'function') throw new MemoryError('EXTERNAL_WATCH_BINDINGS_REQUIRED')
    this.#service = service; this.#context = contextFactory; this.#factory = watchFactory
    this.#pollMs = delay(pollIntervalMs, 1000, 50, 60000)
    this.#debounceMs = delay(debounceMs, 40, 0, 1000)
    this.#maxPages = delay(maxPages, 100, 1, 100)
    this.#state = { mode: 'not_started', platform: process.platform, simulatedFallback: simulatedFallback === true,
      generation: 0, nativeEvents: 0, scans: 0, pollScans: 0, lastScanStarted: null, lastScanCompleted: null,
      lastError: null, watchErrorCode: null, unavailableCount: 0, pendingCount: 0, pendingCountComplete: true, cleanupComplete: false }
  }

  status() { return Object.freeze({ ...this.#state, disposed: this.#disposed, running: this.#running !== null, queued: this.#dirty.size + (this.#full ? 1 : 0) }) }
  subscribe(callback) {
    if (typeof callback !== 'function' || this.#disposed) return () => {}
    this.#subscribers.add(callback)
    return () => this.#subscribers.delete(callback)
  }
  #emit() { if (this.#disposed) return; for (const fn of this.#subscribers) { try { fn(this.status()) } catch {} } }
  #closeHandles() { for (const handle of this.#handles.splice(0)) { try { handle.close() } catch {} } }
  #poll(reason) {
    if (this.#disposed) return
    this.#closeHandles(); this.#state.mode = 'degraded_polling'; this.#state.lastError = reason
    if (!this.#timer) {
      this.#timer = setInterval(() => { if (this.#disposed) return; this.#state.pollScans++; this.scanNow({ full: true }).catch(() => {}) }, this.#pollMs)
      this.#timer.unref?.()
    }
    this.#emit()
  }
  #schedule() {
    if (this.#disposed || this.#debounce) return
    this.#debounce = setTimeout(() => { this.#debounce = null; this.scanNow().catch(() => {}) }, this.#debounceMs)
    this.#debounce.unref?.()
  }
  #event(filename) {
    if (this.#disposed) return
    this.#state.nativeEvents++
    const text = Buffer.isBuffer(filename) ? filename.toString('utf8') : filename
    const first = typeof text === 'string' ? text.split(/[\\/]/)[0] : null
    if (first && idPattern.test(first)) this.#dirty.add(first)
    else this.#full = true
    this.#schedule()
  }

  async start() {
    if (this.#disposed) return this.status()
    if (this.#started) { if (this.#running) await this.#running; return this.status() }
    this.#started = true
    try {
      for (const key of ['records', 'quarantine']) {
        const handle = this.#factory(this.#service.store.paths[key], { recursive: true, persistent: false }, (_event, filename) => this.#event(filename))
        if (typeof handle?.close !== 'function' || typeof handle?.on !== 'function') throw new MemoryError('WATCH_UNAVAILABLE')
        handle.on('error', (error) => { if (this.#disposed) return; this.#state.watchErrorCode = /^[A-Z_]{1,64}$/.test(error?.code ?? '') ? error.code : 'WATCH_ERROR'; this.#poll('WATCH_RUNTIME_UNAVAILABLE') })
        this.#handles.push(handle)
      }
      this.#state.mode = 'native'; this.#state.lastError = null
    } catch (error) { this.#state.watchErrorCode = /^[A-Z_]{1,64}$/.test(error?.code ?? '') ? error.code : 'WATCH_ERROR'; this.#poll('WATCH_UNAVAILABLE') }
    await this.scanNow({ full: true })
    return this.status()
  }

  async scanNow({ full = false } = {}) {
    if (this.#disposed) return { status: 'disposed' }
    if (full) this.#full = true
    if (!this.#full && !this.#dirty.size) this.#full = true
    if (this.#running) return this.#running
    const job = (async () => {
      let rounds = 0
      do {
        const entire = this.#full, ids = [...this.#dirty]
        this.#full = false; this.#dirty.clear()
        this.#state.lastScanStarted = new Date().toISOString()
        let cursor, pages = 0, unavailable = 0
        const context = this.#context()
        do {
          if (this.#disposed) return { status: 'disposed' }
          const args = { capture: true, limit: 100, ...(entire ? cursor === undefined ? {} : { cursor } : { record_ids: ids.slice(pages * 100, (pages + 1) * 100) }) }
          const result = await this.#service.scan(args, context, { signal: this.#controller.signal })
          if (this.#disposed) return { status: 'disposed' }
          this.#state.scans++
          if (result.status !== 'ok') { this.#state.lastError = /^[A-Z_]+$/.test(result.reason_code ?? '') ? result.reason_code : 'EXTERNAL_SCAN_UNAVAILABLE'; return result }
          unavailable += result.items.filter((item) => ['unsafe', 'unavailable'].includes(item.status) && item.reason_code !== 'PURGED_CONTENT').length
          cursor = entire ? result.cursor : (pages + 1) * 100 < ids.length ? 'more' : null
          pages++
        } while (cursor !== null && pages < this.#maxPages)
        if (cursor !== null) this.#state.lastError = 'SCAN_PAGE_BUDGET_EXCEEDED'
        else if (unavailable) this.#state.lastError = 'EXTERNAL_ITEMS_UNAVAILABLE'
        else if (this.#state.mode === 'native') this.#state.lastError = null
        this.#state.unavailableCount = unavailable
        const list = await this.#service.list({ limit: 100 }, this.#context(), { signal: this.#controller.signal })
        if (this.#disposed) return { status: 'disposed' }
        if (list.status === 'ok') {
          this.#state.pendingCount = list.items.length; this.#state.pendingCountComplete = list.cursor === null
          const next = digest(list.items)
          if (next !== this.#lastDigest) { this.#lastDigest = next; this.#state.generation++ }
        } else this.#state.lastError = 'EXTERNAL_LIST_UNAVAILABLE'
        this.#state.lastScanCompleted = new Date().toISOString(); this.#emit()
      } while (!this.#disposed && (this.#full || this.#dirty.size) && ++rounds < 3)
      return { status: 'ok', watcher: this.status() }
    })()
    this.#running = job
    try { return await job }
    catch (error) {
      if (!this.#disposed) { this.#state.lastError = error instanceof MemoryError ? error.code : 'EXTERNAL_SCAN_UNAVAILABLE'; this.#emit() }
      return { status: this.#disposed ? 'disposed' : 'unavailable', reason_code: this.#disposed ? 'DISPOSED' : this.#state.lastError }
    } finally {
      this.#running = null
      if (!this.#disposed && (this.#full || this.#dirty.size)) this.#schedule()
    }
  }

  async dispose() {
    if (!this.#disposed) {
      this.#disposed = true; this.#controller.abort(); this.#closeHandles()
      clearInterval(this.#timer); clearTimeout(this.#debounce); this.#timer = null; this.#debounce = null
      this.#dirty.clear(); this.#full = false; this.#subscribers.clear(); this.#state.mode = 'disposed'
    }
    if (this.#running) await this.#running
    this.#state.cleanupComplete = true
    return this.status()
  }
}
