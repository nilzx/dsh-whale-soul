import { MemoryStore } from './store.js'
import { registerAssetRoutes } from './asset-route.js'
import { buildL0 } from './retrieval.js'
import { runDream } from './decay.js'
import { createMemoryTools } from '../tools.js'
import { nowIso } from './schema.js'

export const name = 'whale-soul-memory'
export const inject = ['systemPrompt', 'tools']

const DEFAULT_CHECK_INTERVAL_MS = 15 * 60 * 1000
const DEFAULT_IDLE_MS = 5 * 60 * 1000

function option(config, key, fallback) {
  const value = Number(config?.[key])
  return Number.isFinite(value) ? value : fallback
}

const runtimes = new WeakMap()

export function runtimeFor(ctx) {
  return runtimes.get(ctx)
}

export function apply(ctx, config = {}) {
  const options = config && typeof config === 'object' ? config : {}
  const store = new MemoryStore(options)
  try {
    store.ensure()
  } catch (error) {
    store.state.last_error = {
      at: nowIso(),
      reason: error instanceof Error ? error.message : String(error),
    }
  }

  const idleMs = option(options, 'idleMs', DEFAULT_IDLE_MS)
  const checkIntervalMs = option(options, 'checkIntervalMs', DEFAULT_CHECK_INTERVAL_MS)
  const maintenanceDays = option(options, 'maintenanceDays', 7)
  const maintenanceWrites = option(options, 'maintenanceWrites', 40)
  const autoDream = options.autoDream !== false
  const latestImages = new Map()
  let dreaming = false

  const attachments = (() => {
    try {
      return typeof ctx.get === 'function' ? ctx.get('attachments') : undefined
    } catch {
      return undefined
    }
  })()

  const recentImage = async (sessionId) => {
    if (!sessionId || !attachments || typeof attachments.readImage !== 'function') return null
    const ref = latestImages.get(sessionId)
    if (!ref) return null
    try {
      const stored = await attachments.readImage(
        ref,
        typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(10_000) : undefined,
      )
      if (latestImages.get(sessionId) !== ref) return null
      return { bytes: stored.data, mediaType: stored.ref.mediaType, source: 'chat-attachment' }
    } catch {
      return null
    }
  }

  const runDreamNow = (trigger = 'timer') => {
    if (dreaming) return
    if (store.entries.size === 0) return
    dreaming = true
    const payload = { at: nowIso(), trigger }
    try {
      ctx.emit?.('whale-soul/dream-start', payload)
    } catch {
      // No body listener is fine.
    }
    try {
      runDream(store, options)
      ctx.emit?.('whale-soul/dream-end', { ...payload, ok: true })
    } catch (error) {
      store.state.last_error = {
        at: nowIso(),
        reason: error instanceof Error ? error.message : String(error),
      }
      try {
        store.saveState()
      } catch {
        // Do not break the session for a maintenance error.
      }
      ctx.emit?.('whale-soul/dream-end', { ...payload, ok: false })
    } finally {
      dreaming = false
    }
  }

  const maybeDream = () => {
    if (!autoDream || dreaming) return
    if (!store.due({ days: maintenanceDays, writes: maintenanceWrites })) return
    if (Date.now() - store.activityAt < idleMs) return
    runDreamNow('timer')
  }

  ctx.effect(
    () =>
      ctx.systemPrompt.context({
        name: 'whale-soul:memory',
        order: 240,
        required: true,
        interpolate: false,
        text: () => {
          try {
            return buildL0(store.active(), { maxChars: option(options, 'maxContextChars', 2400) })
          } catch (error) {
            return `<whale-soul-memory>\n记忆花园暂时有点雾：${error instanceof Error ? error.message : String(error)}\n不要编造记不清的事。\n</whale-soul-memory>`
          }
        },
      }),
    'whale-soul.memory.context()',
  )

  for (const definition of createMemoryTools(store, { recentImage })) {
    ctx.effect(() => ctx.tools.register(definition), `whale-soul.memory.tool(${definition.name})`)
  }

  // Keep dreams out of active chat. Any user turn resets the idle clock; the
  // maintenance pass itself runs only when the house is quiet.
  if (typeof ctx.on === 'function') {
    const activityDispose = ctx.on('session/event', (session, event) => {
      if (event?.type === 'user/message' || event?.type === 'turn/start') store.touchActivity()
      if (event?.type !== 'user/message') return
      const sessionId = session?.header?.id ?? session?.id
      if (!sessionId) return
      const images = Array.isArray(event.data?.content)
        ? event.data.content.filter((part) => part?.type === 'image' && part.attachment)
        : []
      if (images.length === 0) return
      latestImages.set(sessionId, images[images.length - 1].attachment)
      if (latestImages.size > 64) {
        const oldest = latestImages.keys().next().value
        if (oldest !== undefined) latestImages.delete(oldest)
      }
    })
    const sessionDispose = ctx.on('session/disposed', (session) => {
      latestImages.delete(session?.header?.id ?? session?.id)
    })
    ctx.effect(() => () => {
      activityDispose()
      sessionDispose()
      latestImages.clear()
    }, 'whale-soul.memory.activity()')
  }

  if (autoDream && checkIntervalMs > 0) {
    ctx.effect(() => {
      const timer = setInterval(maybeDream, Math.max(30_000, checkIntervalMs))
      timer.unref?.()
      return () => clearInterval(timer)
    }, 'whale-soul.memory.dream-timer()')
  }

  const assetRoute = registerAssetRoutes(ctx, store)

  ctx.effect(() => () => store.dispose(), 'whale-soul.memory.dispose()')

  runtimes.set(ctx, { store, runDreamNow, assetRoute })
}

export default { name, inject, apply }
