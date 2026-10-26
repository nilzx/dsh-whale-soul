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
    petId = 'main',
    surface = 'any',
    routePrefix = '/dsh-pet-7340',
    fetchImpl = globalThis.fetch,
    timeoutMs = 1200,
    maxBubbleChars = 100,
    memoryRoot,
  } = {}) {
    this.baseUrl = typeof baseUrl === 'string' ? baseUrl.replace(/\/+$/, '') : ''
    this.configuredPetId = petId
    this.petId = petId
    this.surface = surface
    this.routePrefix = routePrefix
    this.fetchImpl = fetchImpl
    this.timeoutMs = timeoutMs
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

  async request(path, { method = 'GET', body, query } = {}) {
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
        signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(this.timeoutMs) : undefined,
      })
      if (!response?.ok) return null
      return await response.json()
    } catch {
      return null
    }
  }

  async detect() {
    if (!DshPetBody.isLoopback(this.baseUrl)) return false
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
    const entry =
      entries.find((value) => value.pets.some((pet) => String(pet?.id ?? '') === this.configuredPetId)) ??
      entries[0] ??
      config
    this.pets = Array.isArray(entry.pets) ? entry.pets : []
    this.animations = collectAnimations(entry)
    const ids = this.pets.map((pet) => String(pet?.id ?? '')).filter(Boolean)
    if (ids.length > 0) {
      this.petId = ids.includes(this.configuredPetId) ? this.configuredPetId : ids[0]
    }
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
      query: { pet: this.petId, surface: this.surface },
    })
    return result?.ok === true
  }

  async play(name, facing) {
    if (!name) return false
    const result = await this.request('/anim', {
      method: 'POST',
      body: { name, ...(facing ? { facing } : {}) },
      query: { pet: this.petId, surface: this.surface },
    })
    return result?.ok === true
  }

  async clearBubble() {
    const result = await this.request('/bubble/clear', {
      method: 'POST',
      body: {},
      query: { pet: this.petId, surface: this.surface },
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
