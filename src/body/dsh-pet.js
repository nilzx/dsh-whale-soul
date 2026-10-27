import { assetPath } from '../memory/asset-route.js'

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

function bubbleText(value, maxChars) {
  const clean = String(value ?? '').toWellFormed().replace(/\s+/g, ' ').trim()
  const limit = Math.max(0, Math.floor(Number(maxChars) || 0))
  const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(clean)
  const out = []
  for (const { segment } of segments) {
    if (out.length >= limit) break
    out.push(segment)
  }
  return out.join('')
}

function collectAnimations(config) {
  const out = new Set()
  const push = (value) => {
    if (typeof value === 'string' && value.trim()) out.add(value.trim())
  }
  const animations = config?.animations
  if (!animations || typeof animations !== 'object') return []
  for (const key of ['idle', 'turn', 'drag', 'clicks']) {
    if (Array.isArray(animations[key])) animations[key].forEach(push)
  }
  if (Array.isArray(animations.moves?.actions)) {
    for (const action of animations.moves.actions) push(action?.name)
  }
  if (Array.isArray(animations.categories)) {
    for (const category of animations.categories) {
      if (Array.isArray(category?.actions)) category.actions.forEach(push)
    }
  }
  if (animations.events && typeof animations.events === 'object') {
    for (const pool of Object.values(animations.events)) {
      if (!Array.isArray(pool)) continue
      for (const slot of pool) {
        if (typeof slot === 'string') push(slot)
        else if (Array.isArray(slot)) slot.forEach(push)
      }
    }
  }
  return [...out]
}

export class DshPetBody {
  constructor({
    baseUrl,
    petId,
    surface = 'any',
    routePrefix = '/dsh-pet-7340',
    fetchImpl = globalThis.fetch,
    timeoutMs = 1200,
    playbackWaitMs = 15000,
    maxBubbleChars = 100,
    memoryRoot,
  } = {}) {
    this.baseUrl = typeof baseUrl === 'string' ? baseUrl.replace(/\/+$/, '') : ''
    this.explicitPetId = petId !== undefined
    this.configuredPetId = petId === undefined ? 'main' : petId
    this.petId = this.configuredPetId
    this.surface = surface
    this.routePrefix = routePrefix
    this.fetchImpl = fetchImpl
    this.timeoutMs = timeoutMs
    this.playbackWaitMs = Number.isFinite(Number(playbackWaitMs)) ? Math.min(15000, Math.max(1, Math.floor(Number(playbackWaitMs)))) : 15000
    this.maxBubbleChars = maxBubbleChars
    this.memoryRoot = memoryRoot
    this.available = false
    this.pets = []
    this.animations = []
    this.lockId = null
    this.lockOwner = null
    this.pendingLockOwner = null
    this.lockPromise = null
    this.releasePromise = null
    this.closePromise = null
    this.playbackWaits = new Set()
    this.disposed = false
  }

  static isLoopback(baseUrl) {
    try {
      const url = new URL(baseUrl)
      return LOOPBACK.has(url.hostname)
    } catch {
      return false
    }
  }

  async request(path, { method = 'GET', body, query, signal, timeoutMs = this.timeoutMs } = {}) {
    if (this.disposed && path !== '/lock/release') return null
    if (!this.baseUrl || typeof this.fetchImpl !== 'function') return null
    const url = new URL(`${this.routePrefix}${path}`, `${this.baseUrl}/`)
    if (query) for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
    }
    try {
      const response = await this.fetchImpl(url, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]) : signal,
      })
      if (!response?.ok) return null
      return await response.json()
    } catch {
      return null
    }
  }

  async detect() {
    this.available = false
    if (!DshPetBody.isLoopback(this.baseUrl)) return false
    if (this.explicitPetId && (typeof this.configuredPetId !== 'string' || !this.configuredPetId.trim())) return false
    const state = await this.request('/state')
    if (!state || typeof state !== 'object') return false
    const config = await this.request('/config')
    if (!config || typeof config !== 'object') return false
    // dsh-pet returns one config entry per pet kind, keyed by the entry name
    // (for example `{ main: { pets, animations, ... } }`). Older or embedded
    // shapes may return the flattened entry directly; support both.
    const entries = Object.values(config).filter(
      (value) => value && typeof value === 'object' && Array.isArray(value.pets),
    )
    const matching =
      entries.find((value) => value.pets.some((pet) => String(pet?.id ?? '') === this.configuredPetId)) ??
      (Array.isArray(config.pets) && config.pets.some((pet) => String(pet?.id ?? '') === this.configuredPetId) ? config : null)
    if (this.explicitPetId && !matching) return false
    const entry = matching ?? entries[0] ?? config
    this.pets = Array.isArray(entry.pets) ? entry.pets : []
    this.animations = collectAnimations(entry)
    const ids = this.pets.map((pet) => String(pet?.id ?? '')).filter(Boolean)
    if (!ids.length || this.explicitPetId && !ids.includes(this.configuredPetId)) return false
    // Automatic selection is retained only when the host omitted petId.
    this.petId = ids.includes(this.configuredPetId) ? this.configuredPetId : ids[0]
    this.available = true
    return true
  }

  pickAnimation(candidates) {
    for (const name of candidates ?? []) {
      if (!name) continue
      if (this.animations.length === 0 || this.animations.includes(name)) return name
    }
    return this.animations.find((name) => /待机/.test(name)) ?? this.animations[0] ?? null
  }

  async say(text, { duration, url, anim = false } = {}) {
    const clean = bubbleText(text, this.maxBubbleChars)
    if (!clean) return false
    const result = await this.request('/broadcast', {
      method: 'POST',
      body: {
        text: clean,
        duration,
        anim,
        ...(url ? { url } : {}),
      },
      query: { pet: this.petId, surface: this.surface, lock: this.lockId },
    })
    return result?.ok === true
  }

  async play(name, facing, { waitForEnd = false } = {}) {
    if (!name) return false
    const result = await this.request('/anim', {
      method: 'POST',
      body: { name, ...(facing ? { facing } : {}) },
      query: { pet: this.petId, surface: this.surface, lock: this.lockId },
    })
    if (result?.ok !== true) return false
    return waitForEnd && result.playbackId !== undefined ? this.waitForPlayback(result.playbackId) : true
  }

  async waitForPlayback(playbackId) {
    if (this.disposed || typeof playbackId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(playbackId)) return false
    const controller = new AbortController(), deadline = performance.now() + this.playbackWaitMs
    this.playbackWaits.add(controller)
    let abort
    const canceled = new Promise((resolve) => { abort = () => resolve(false); controller.signal.addEventListener('abort', abort, { once: true }) })
    const timer = setTimeout(() => controller.abort(), this.playbackWaitMs)
    const poll = (async () => {
      // dsh-pet 0.3.8 caps each long poll at 10s. The total remains 15s,
      // and an incompatible endpoint cannot turn this into an unbounded loop.
      for (let attempt = 0; attempt < 3 && !this.disposed && !controller.signal.aborted; attempt++) {
        const remaining = Math.floor(deadline - performance.now())
        if (remaining <= 0) return false
        const result = await this.request(`/playback/${playbackId}`, { signal: controller.signal, timeoutMs: remaining,
          query: { wait: 'ended,failed,cancelled', timeout: Math.min(10000, remaining) } })
        if (this.disposed || controller.signal.aborted || !result || result.playbackId !== playbackId || result.petId !== undefined && result.petId !== this.petId) return false
        if (['ended', 'failed', 'cancelled'].includes(result.status)) return result.status === 'ended'
        if (!['accepted', 'playing'].includes(result.status)) return false
      }
      return false
    })().catch(() => false)
    try { return await Promise.race([poll, canceled]) }
    finally { clearTimeout(timer); controller.signal.removeEventListener('abort', abort); this.playbackWaits.delete(controller) }
  }

  async clearBubble() {
    const result = await this.request('/bubble/clear', {
      method: 'POST',
      body: {},
      query: { pet: this.petId, surface: this.surface, lock: this.lockId },
    })
    return result?.ok === true
  }

  async lock(ttl = 60_000, owner = 'default') {
    if (this.disposed) return null
    if (this.releasePromise) await this.releasePromise
    if (this.disposed) return null
    if (this.lockId) return this.lockOwner === owner ? this.lockId : null
    if (this.lockPromise) return this.pendingLockOwner === owner ? this.lockPromise : null
    this.pendingLockOwner = owner
    const pending = this.request('/lock', {
        method: 'POST',
        body: { ttl },
        query: { pet: this.petId, surface: this.surface },
      }).then((result) => {
        if (result?.ok && result.lockId) {
          this.lockId = result.lockId
          this.lockOwner = owner
          return this.lockId
        }
        return null
      })
    this.lockPromise = pending
    try {
      return await pending
    } finally {
      if (this.lockPromise === pending) {
        this.lockPromise = null
        this.pendingLockOwner = null
      }
    }
  }

  async release({ owner, lockId: expectedLockId } = {}) {
    const currentOwner = this.lockId ? this.lockOwner : this.pendingLockOwner
    if (owner !== undefined && currentOwner !== null && currentOwner !== owner) return false
    if (expectedLockId !== undefined && this.lockId !== expectedLockId) return false
    if (this.releasePromise) return this.releasePromise
    const pending = Promise.resolve().then(async () => {
      // A late lock response still carries a cleanup responsibility.
      if (this.lockPromise) await this.lockPromise
      if (!this.lockId) return true
      if (owner !== undefined && this.lockOwner !== owner) return false
      if (expectedLockId !== undefined && this.lockId !== expectedLockId) return false
      const lockId = this.lockId
      const result = await this.request('/lock/release', {
        method: 'POST',
        body: { lockId },
        query: { pet: this.petId },
      })
      if (result?.ok === true) {
        if (this.lockId === lockId) {
          this.lockId = null
          this.lockOwner = null
        }
        return true
      }
      return false
    })
    this.releasePromise = pending
    try {
      return await pending
    } finally {
      if (this.releasePromise === pending) this.releasePromise = null
    }
  }

  close() {
    if (this.closePromise) return this.closePromise
    this.disposed = true
    this.available = false
    for (const controller of this.playbackWaits) controller.abort()
    this.closePromise = (async () => {
      // Bound cleanup to two HTTP attempts; failed IDs remain inspectable.
      if (await this.release()) return true
      return this.release()
    })()
    return this.closePromise
  }

  assetUrl(file) {
    const path = this.memoryRoot ? assetPath(this.memoryRoot, file) : null
    return path ? `${this.baseUrl}${path}` : null
  }
}
