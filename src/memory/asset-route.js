import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'

const registrations = new WeakMap()
const original = Symbol.for('cordis.original')
const MAX_ASSET_BYTES = 8 * 1024 * 1024
const FILE = /^([a-f0-9]{64})\.(png|jpe?g|webp|gif)$/
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }

function canonicalRoot(root) {
  try { return realpathSync(root) } catch { return resolve(root) }
}

/** Route namespaces separate stores; they do not grant access. */
export function assetNamespace(root) {
  return createHash('sha256').update(canonicalRoot(root)).digest('hex').slice(0, 32)
}

export function assetPath(root, file) {
  if (!FILE.test(String(file))) return null
  return `/whale-soul-assets/${assetNamespace(root)}/${encodeURIComponent(file)}`
}

function plain(res, status, message, extra = {}) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...extra })
  res.end(message)
}

function assetHandler(root, prefix, connection) {
  return (req, res) => {
    try {
      const admission = connection.admit(req)
      if (admission?.rejection === 401 || admission?.rejection === 403) {
        plain(res, admission.rejection, admission.rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      if (admission?.peer?.principal?.kind !== 'owner' || admission.peer.signal?.aborted !== false) {
        plain(res, 403, 'forbidden')
        return
      }
    } catch {
      plain(res, 503, 'asset authentication unavailable')
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      plain(res, 405, 'method not allowed', { allow: 'GET, HEAD' })
      return
    }
    let descriptor
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (!url.pathname.startsWith(`${prefix}/`)) { plain(res, 404, 'asset not found'); return }
      const file = decodeURIComponent(url.pathname.slice(prefix.length + 1))
      const match = FILE.exec(file)
      if (!match) { plain(res, 404, 'asset not found'); return }
      const directory = join(root, 'assets')
      if (!lstatSync(directory).isDirectory()) { plain(res, 404, 'asset not found'); return }
      const path = join(directory, file)
      if (!lstatSync(path).isFile()) { plain(res, 404, 'asset not found'); return }
      descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const stat = fstatSync(descriptor)
      if (!stat.isFile() || stat.size > MAX_ASSET_BYTES) { plain(res, 404, 'asset not found'); return }
      const bytes = readFileSync(descriptor)
      if (createHash('sha256').update(bytes).digest('hex') !== match[1]) {
        plain(res, 404, 'asset not found')
        return
      }
      res.writeHead(200, {
        'content-type': MIME[match[2]],
        'content-length': bytes.length,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      })
      res.end(req.method === 'HEAD' ? undefined : bytes)
    } catch (error) {
      if (!res.writableEnded) plain(res, error instanceof URIError || ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error?.code) ? 404 : 500, 'asset not found')
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
    }
  }
}

/** Retain one route per server and canonical store, independent of preset lifetime. */
export function retainAssetRoute(webService, connectionService, root) {
  const web = webService?.[original] ?? webService
  const connection = connectionService?.[original] ?? connectionService
  if (!web || typeof web.register !== 'function' || typeof connection?.admit !== 'function') return null
  const canonical = canonicalRoot(root)
  const namespace = assetNamespace(canonical)
  let routes = registrations.get(web)
  if (!routes) registrations.set(web, routes = new Map())
  let record = routes.get(namespace)
  if (record && (record.root !== canonical || record.connection !== connection)) {
    throw new Error('asset route namespace or authentication owner conflict')
  }
  if (!record) {
    const prefix = `/whale-soul-assets/${namespace}`
    const dispose = web.register({ kind: 'prefix', path: prefix, handler: assetHandler(canonical, prefix, connection) })
    record = { root: canonical, connection, references: new Set(), dispose }
    routes.set(namespace, record)
  }
  const reference = Symbol('asset-route-reference')
  record.references.add(reference)
  return () => {
    if (!record.references.delete(reference) || record.references.size !== 0) return
    record.dispose()
    routes.delete(namespace)
    if (routes.size === 0) registrations.delete(web)
  }
}

/** Optional dependencies activate together and are re-bound on service replacement. */
export function registerAssetRoutes(ctx, store) {
  const status = { active: false, namespace: assetNamespace(store.root), error: null }
  const activate = (child) => {
    try {
      const web = typeof child.get === 'function' ? child.get('webServer') : undefined
      const connection = typeof child.get === 'function' ? child.get('connection') : undefined
      const release = retainAssetRoute(web, connection, store.root)
      if (!release) return
      status.active = true
      status.error = null
      child.effect(() => () => { release(); status.active = false }, 'whale-soul.memory.asset-route()')
    } catch {
      status.active = false
      status.error = 'asset_route_registration_failed'
    }
  }
  if (typeof ctx.inject === 'function') ctx.inject(['webServer', 'connection'], activate)
  else activate(ctx)
  return status
}
