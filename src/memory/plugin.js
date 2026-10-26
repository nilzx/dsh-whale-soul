import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { MemoryStore } from './store.js'
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

function registerAssetRoute(ctx, store) {
  let webServer
  try {
    webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  } catch {
    webServer = undefined
  }
  if (!webServer || typeof webServer.register !== 'function') return null
  try {
    const dispose = webServer.register({
      kind: 'prefix',
      path: '/whale-soul-assets',
      handler: (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const name = basename(decodeURIComponent(url.pathname))
          if (!/^[a-f0-9]{64}\.(png|jpe?g|webp|gif)$/i.test(name)) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('asset not found')
            return
          }
          const path = join(store.paths.assets, name)
          if (!existsSync(path)) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('asset not found')
            return
          }
          const ext = name.split('.').pop()?.toLowerCase()
          const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg'
          const bytes = readFileSync(path)
          res.writeHead(200, {
            'content-type': mime,
            'cache-control': 'private, max-age=86400',
            'content-length': bytes.byteLength,
          })
          res.end(bytes)
        } catch {
          if (!res.writableEnded) {
            res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('asset read failed')
          }
        }
      },
    })
    return dispose
  } catch {
    return null
  }
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
  let dreaming = false

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

  for (const definition of createMemoryTools(store)) {
    ctx.effect(() => ctx.tools.register(definition), `whale-soul.memory.tool(${definition.name})`)
  }

  // Keep dreams out of active chat. Any user turn resets the idle clock; the
  // maintenance pass itself runs only when the house is quiet.
  if (typeof ctx.on === 'function') {
    const activityDispose = ctx.on('session/event', (_session, event) => {
      if (event?.type === 'user/message' || event?.type === 'turn/start') store.touchActivity()
    })
    ctx.effect(() => () => activityDispose(), 'whale-soul.memory.activity()')
  }

  if (autoDream && checkIntervalMs > 0) {
    ctx.effect(() => {
      const timer = setInterval(maybeDream, Math.max(30_000, checkIntervalMs))
      timer.unref?.()
      return () => clearInterval(timer)
    }, 'whale-soul.memory.dream-timer()')
  }

  const assetDispose = registerAssetRoute(ctx, store)
  if (assetDispose) ctx.effect(() => assetDispose, 'whale-soul.memory.asset-route()')

  ctx.effect(() => () => store.dispose(), 'whale-soul.memory.dispose()')

  runtimes.set(ctx, { store, runDreamNow })
}

export default { name, inject, apply }
