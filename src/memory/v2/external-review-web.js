import { randomBytes, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { API_VERSION, MemoryError, assertOnly, digest } from './contracts.js'
import { MemoryExternalWatcher } from './external-watcher.js'
import { renderExternalReviewPage } from './external-review-page.js'

const original = Symbol.for('cordis.original'), owners = new WeakMap()
const raw = (value) => value?.[original] ?? value
const safeCode = (value, fallback) => typeof value === 'string' && /^[A-Z_]+$/.test(value) ? value : fallback
const bounded = (value, fallback, min, max) => Number.isInteger(value) && value >= min && value <= max ? value : fallback
const token = () => randomBytes(32).toString('base64url')
const headers = { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cross-origin-resource-policy': 'same-origin' }

function reply(res, status, data) {
  if (res.writableEnded || res.destroyed) return
  if (status >= 400) res.shouldKeepAlive = false
  try { res.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)) }
  catch { res.destroy() }
}
const rejection = (res, status, reason) => reply(res, status, { status: 'rejected', reason_code: reason })

async function readBody(req, limit, signal) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) throw new MemoryError('JSON_BODY_REQUIRED')
  if (req.headers['content-length'] !== undefined && (!/^\d+$/.test(req.headers['content-length']) || Number(req.headers['content-length']) > limit)) throw new MemoryError('REVIEW_BODY_TOO_LARGE')
  const chunks = []; let size = 0
  await new Promise((resolve, reject) => {
    const finish = (error) => {
      req.off('data', data); req.off('end', end); req.off('error', errorHandler); signal.removeEventListener('abort', cancelled)
      if (error) { req.pause(); reject(error) } else resolve()
    }
    const data = (chunk) => { size += chunk.length; if (size > limit) finish(new MemoryError('REVIEW_BODY_TOO_LARGE')); else chunks.push(chunk) }
    const end = () => finish(), errorHandler = () => finish(new MemoryError('INVALID_REVIEW_BODY')), cancelled = () => finish(new MemoryError('OPERATION_CANCELLED'))
    req.on('data', data); req.on('end', end); req.on('error', errorHandler); signal.addEventListener('abort', cancelled, { once: true })
    if (signal.aborted) cancelled()
  })
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) } catch { throw new MemoryError('INVALID_REVIEW_JSON') }
}

/** Register one generation of authenticated routes; disposal invalidates all leases. */
export function createExternalReviewRoutes({ web, connection, service, watcher, contextFactory, isCurrent = () => true,
  bodyLimit = 16384, requestTimeoutMs = 10000, csrfTtlMs = 600000, previewTtlMs = 60000, maxInflight = 32, now = Date.now } = {}) {
  if (typeof web?.register !== 'function' || typeof web?.getOrigin !== 'function' || typeof connection?.admit !== 'function' || typeof connection?.authorizeIndex !== 'function' || typeof service?.resolve !== 'function' || typeof contextFactory !== 'function' || typeof watcher?.status !== 'function') throw new MemoryError('REVIEW_HOST_BINDINGS_REQUIRED')
  const origin = new URL(web.getOrigin()).origin
  const namespace = digest({ root: realpathSync(service.store.root), space: service.store.memorySpaceId }).slice(0, 24)
  const prefix = `/dsh-memory-review/${namespace}`, controller = new AbortController(), csrf = new Map(), previews = new Map(), inflight = new Set()
  const maxBody = bounded(bodyLimit, 16384, 256, 65536), timeoutMs = bounded(requestTimeoutMs, 10000, 50, 60000)
  const activeLimit = bounded(maxInflight, 32, 1, 128)
  const csrfLife = bounded(csrfTtlMs, 600000, 50, 3600000), previewLife = bounded(previewTtlMs, 60000, 50, 600000)
  let closed = false
  const current = () => {
    try { return !closed && !controller.signal.aborted && isCurrent() === true && new URL(web.getOrigin()).origin === origin } catch { return false }
  }
  const prune = (map) => { for (const [key, value] of map) if (value.expires <= now()) map.delete(key); while (map.size > 128) map.delete(map.keys().next().value) }
  const handle = async (req, res) => {
    const abort = new AbortController(); let deadline
    req.on('error', () => {}) // Transport errors after cancellation do not become process errors.
    const onAbort = () => abort.abort(), onClose = () => { if (!res.writableEnded) abort.abort() }
    req.on('aborted', onAbort); res.on('close', onClose)
    try {
      if (!current()) return rejection(res, 503, 'REVIEW_SERVICE_CHANGED')
      let admission
      try { admission = connection.admit(req) } catch { return rejection(res, 503, 'REVIEW_AUTH_UNAVAILABLE') }
      if (admission?.rejection === 401 || admission?.rejection === 403) return rejection(res, admission.rejection, admission.rejection === 401 ? 'OWNER_AUTH_REQUIRED' : 'FORBIDDEN')
      const peer = admission?.peer
      if (peer?.principal?.kind !== 'owner' || !(peer.signal instanceof AbortSignal) || peer.signal.aborted) return rejection(res, 403, 'OWNER_AUTH_REQUIRED')
      const browserOwner = () => {
        let responseOwned = false
        try { return connection.authorizeIndex(req, { writeHead() { responseOwned = true }, end() {} }) === true && !responseOwned } catch { return false }
      }
      if (!browserOwner()) return rejection(res, 401, 'OWNER_BROWSER_AUTH_REQUIRED')
      const signal = AbortSignal.any([controller.signal, peer.signal, abort.signal])
      const authorize = () => current() && !signal.aborted && connection.admit(req)?.peer === peer && browserOwner()
      deadline = setTimeout(() => { rejection(res, 408, 'REVIEW_REQUEST_TIMEOUT'); abort.abort(); if (!req.complete) req.destroy() }, timeoutMs); deadline.unref?.()
      const url = new URL(req.url, origin)
      if (url.search || url.hash || !url.pathname.startsWith(prefix + '/')) return rejection(res, 404, 'REVIEW_ROUTE_NOT_FOUND')
      const path = url.pathname.slice(prefix.length)
      prune(csrf); prune(previews)
      if (req.method === 'GET' && path === '/') {
        const secret = token(), nonce = randomBytes(18).toString('base64url')
        csrf.set(digest(secret), { peer, expires: now() + csrfLife }); prune(csrf)
        res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8',
          'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'` })
        res.end(renderExternalReviewPage({ prefix, spaceId: service.store.memorySpaceId, csrf: secret, nonce })); return
      }
      if (req.method === 'GET' && path === '/state') {
        const pending = await service.list({ limit: 100 }, contextFactory(), { signal, authorize })
        const history = pending.status === 'ok' && pending.items.length < 100 ? await service.list({ limit: 100, include_resolved: true }, contextFactory(), { signal, authorize }) : null
        if (!authorize()) return rejection(res, 503, 'REVIEW_SERVICE_CHANGED')
        if (pending.status !== 'ok' || history && history.status !== 'ok') return rejection(res, 503, safeCode(pending.reason_code ?? history?.reason_code, 'REVIEW_UNAVAILABLE'))
        const ids = new Set(pending.items.map((item) => item.change_id)), items = [...pending.items, ...(history?.items ?? []).filter((item) => !ids.has(item.change_id))].slice(0, 100)
        reply(res, 200, { api_version: API_VERSION, status: 'ok', coverage: { records: true, persona_anchor: false, growth: false, core: false }, watcher: watcher.status(), items, complete: pending.cursor === null && history?.cursor === null }); return
      }
      if (!['/preview', '/resolve', '/scan'].includes(path)) return rejection(res, 404, 'REVIEW_ROUTE_NOT_FOUND')
      if (req.method !== 'POST') return rejection(res, 405, 'REVIEW_METHOD_NOT_ALLOWED')
      if (req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site') return rejection(res, 403, 'SAME_ORIGIN_REQUIRED')
      const csrfValue = req.headers['x-memory-review-csrf'], csrfKey = typeof csrfValue === 'string' ? digest(csrfValue) : ''
      const lease = csrf.get(csrfKey)
      if (!lease || lease.peer !== peer || lease.expires <= now()) return rejection(res, 403, 'REVIEW_CSRF_REQUIRED')
      const body = await readBody(req, maxBody, signal)
      if (!authorize()) return rejection(res, 503, 'REVIEW_SERVICE_CHANGED')
      if (path === '/scan') {
        assertOnly(body, [])
        const result = await watcher.scanNow({ full: true })
        if (!authorize()) return rejection(res, 503, 'REVIEW_SERVICE_CHANGED')
        reply(res, result.status === 'ok' ? 200 : 503, result); return
      }
      if (path === '/preview') {
        assertOnly(body, ['change_id', 'expected_observed_hash'])
        const result = await service.preview(body, contextFactory(), { signal, authorize })
        if (!authorize()) return rejection(res, 503, 'REVIEW_SERVICE_CHANGED')
        if (result.status !== 'review_required') return rejection(res, result.status === 'conflict' ? 409 : 400, safeCode(result.reason_code, 'REVIEW_UNAVAILABLE'))
        const secret = token()
        previews.set(digest(secret), { peer, csrfKey, expires: now() + previewLife, used: false, preview: result }); prune(previews)
        reply(res, 200, { ...result, preview_nonce: secret }); return
      }
      assertOnly(body, ['preview_nonce', 'action', 'fields', 'restore_revision_id'])
      const approved = typeof body.preview_nonce === 'string' ? previews.get(digest(body.preview_nonce)) : null
      if (!approved || approved.peer !== peer || approved.csrfKey !== csrfKey || approved.expires <= now() || approved.used) return rejection(res, 409, 'REVIEW_PREVIEW_EXPIRED')
      approved.used = true
      const p = approved.preview
      if (!p.allowed_actions.includes(body.action)) return rejection(res, 400, 'REVIEW_ACTION_NOT_ALLOWED')
      if (body.action === 'adopt' && (!Array.isArray(body.fields) || !body.fields.length || new Set(body.fields).size !== body.fields.length || body.fields.some((field) => !Object.hasOwn(p.diff, field) || !['title', 'tags', 'gist', 'detail'].includes(field))) || body.action === 'restore' && !p.trusted_restore_revisions.includes(body.restore_revision_id)) return rejection(res, 400, 'REVIEW_SCOPE_NOT_APPROVED')
      const args = { operation_id: `owner-web-${randomUUID()}`, change_id: p.change_id, action: body.action,
        review_digest: p.review_digest, expected_change_revision: p.change_revision, expected_head_revision_id: p.head_revision_id,
        expected_observed_hash: p.observed_hash, ...(body.action === 'adopt' ? { fields: body.fields } : { restore_revision_id: body.restore_revision_id }) }
      const result = await service.resolve(args, contextFactory(), { signal, authorize })
      if (!authorize()) return rejection(res, 503, 'REVIEW_SERVICE_CHANGED')
      reply(res, result.status === 'committed' ? 200 : result.status === 'conflict' ? 409 : 400, result)
    } catch (error) {
      const code = error instanceof MemoryError ? error.code : 'REVIEW_UNAVAILABLE'
      if (['REVIEW_BODY_TOO_LARGE', 'JSON_BODY_REQUIRED', 'INVALID_REVIEW_JSON', 'INVALID_REVIEW_BODY'].includes(code)) res.shouldKeepAlive = false
      reply(res, code === 'REVIEW_BODY_TOO_LARGE' ? 413 : code === 'OPERATION_CANCELLED' ? 409 : 400, { status: 'rejected', reason_code: safeCode(code, 'REVIEW_UNAVAILABLE') })
    } finally { clearTimeout(deadline); req.off('aborted', onAbort); res.off('close', onClose) }
  }
  const release = web.register({ kind: 'prefix', path: prefix, handler: (req, res) => {
    if (inflight.size >= activeLimit) return rejection(res, 429, 'REVIEW_BUSY')
    const job = handle(req, res); inflight.add(job); job.then(() => inflight.delete(job), () => inflight.delete(job)); return job
  } })
  return { prefix, origin, status: () => ({ active: current(), inflight: inflight.size, previews: previews.size }),
    async dispose() { if (!closed) { closed = true; controller.abort(); release(); csrf.clear(); previews.clear() } await Promise.allSettled([...inflight]) } }
}

/** Explicit host installation; it is not added to any persona/tool automatically. */
export async function installExternalReview(ctx, { service, contextFactory, watcher: suppliedWatcher, watcherOptions = {}, routeOptions = {} } = {}) {
  if (!ctx?.root || typeof ctx.inject !== 'function' || typeof ctx.effect !== 'function') throw new MemoryError('CORDIS_CONTEXT_REQUIRED')
  assertOnly(routeOptions, ['bodyLimit', 'requestTimeoutMs', 'csrfTtlMs', 'previewTtlMs', 'maxInflight', 'now'])
  const key = digest({ root: realpathSync(service.store.root), space: service.store.memorySpaceId })
  let registry = owners.get(ctx.root)
  if (!registry) owners.set(ctx.root, registry = new Map())
  if (registry.has(key)) throw new MemoryError('EXTERNAL_REVIEW_ALREADY_INSTALLED')
  const watcher = suppliedWatcher ?? new MemoryExternalWatcher({ service, contextFactory, ...watcherOptions })
  const status = { active: false, prefix: null, error: 'SERVICES_UNAVAILABLE' }, generations = new Set()
  registry.set(key, status)
  let disposed = false, cleanup = null
  const injection = ctx.inject(['webServer', 'connection'], (child) => {
    const web = raw(child.get('webServer')), connection = raw(child.get('connection'))
    let routes
    try {
      routes = createExternalReviewRoutes({ web, connection, service, contextFactory, watcher, ...routeOptions,
        isCurrent: () => !disposed && raw(child.get('webServer')) === web && raw(child.get('connection')) === connection })
      generations.add(routes); status.active = true; status.prefix = routes.prefix; status.error = null
    } catch { status.active = false; status.error = 'REVIEW_ROUTE_UNAVAILABLE'; return }
    child.effect(() => async () => { status.active = false; generations.delete(routes); await routes.dispose() }, 'memory.external-review.routes()')
  })
  const dispose = () => {
    if (cleanup) return cleanup
    disposed = true; status.active = false
    cleanup = (async () => { await injection.dispose(); await Promise.allSettled([...generations].map((routes) => routes.dispose())); await watcher.dispose(); registry.delete(key) })()
    return cleanup
  }
  ctx.effect(() => dispose, 'memory.external-review.owner()')
  try { await watcher.start() } catch (error) { await dispose(); throw error }
  const route = { get active() { return !disposed && [...generations].some((routes) => routes.status().active) },
    get prefix() { return status.prefix }, get error() { return this.active ? null : status.error ?? 'REVIEW_SERVICE_CHANGED' } }
  return { watcher, route, status: () => ({ route: { active: route.active, prefix: route.prefix, error: route.error }, watcher: watcher.status() }), dispose }
}
