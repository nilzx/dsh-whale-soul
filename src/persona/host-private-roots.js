import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path'
import { homedir } from 'node:os'
import { canonicalProtectionPath } from './protection.js'

const original = (value) => value?.[Symbol.for('cordis.original')] ?? value
const fail = (code) => Object.assign(new Error(`persona private roots: ${code}`), { code })

/** Resolve only trusted deployment paths; never inspect credential values or private backend fields.
 * Custom adapters are host functions ({kind,name,service,ctx}) =>
 * {roots:[{path,kind:'directory'|'file'}], token?, isCurrent?} or {fileless:true,token?,isCurrent?}.
 * Returning undefined declines an adapter. A mounted unknown provider is refused.
 */
export function createHostPrivateRoots(ctx, bindings = {}) {
  const { resolveDshHome, LocalCredentialProvider, resolveCredentialSpec, SessionPersistencePlugin,
    StorageJsonPlugin, JsonStorageBackend, storageBackendServiceKey, LocalAttachmentStore, adapters = [] } = bindings
  if (typeof ctx?.get !== 'function' || typeof resolveDshHome !== 'function' ||
    typeof LocalCredentialProvider !== 'function' || typeof resolveCredentialSpec !== 'function' ||
    typeof JsonStorageBackend !== 'function' || typeof storageBackendServiceKey !== 'function' ||
    typeof LocalAttachmentStore !== 'function' || !Array.isArray(adapters) || adapters.some((fn) => typeof fn !== 'function')) {
    throw fail('TRUSTED_PRIVATE_ROOT_BINDINGS_REQUIRED')
  }
  const liveFibers = (plugin) => [...(ctx.registry?.get(plugin)?.fibers ?? [])].filter((fiber) => fiber.state === 2)
  const ownerFiber = (service, candidates) => {
    const seen = new Set()
    for (let fiber = original(service)?.ctx?.fiber; fiber && !seen.has(fiber); fiber = fiber.parent?.fiber) {
      if (candidates.includes(fiber)) return fiber
      seen.add(fiber)
    }
    return null
  }
  const read = () => {
    const roots = [], identities = [], checks = [], owners = []
    const add = (path, kind) => {
      if (!['file', 'directory'].includes(kind)) throw fail('INVALID_PRIVATE_ROOT_KIND')
      const normalized = canonicalProtectionPath(path), toHome = relative(normalized, canonicalProtectionPath(homedir()))
      if (kind === 'directory' && (toHome === '' || toHome !== '..' && !toHome.startsWith(`..${sep}`) && !isAbsolute(toHome))) throw fail('PRIVATE_ROOT_TOO_BROAD')
      const logical = resolvePath(path)
      roots.push(Object.freeze({ path: normalized, kind, anchor: join(canonicalProtectionPath(dirname(logical)), basename(logical)) }))
    }
    const custom = (kind, name, service) => {
      for (const adapter of adapters) {
        const result = adapter({ kind, name, service, ctx })
        if (result === undefined) continue
        if (!result || typeof result.then === 'function' || result.fileless !== true && (!Array.isArray(result.roots) || !result.roots.length)) throw fail('INVALID_PRIVATE_ROOT_ADAPTER')
        if (result.fileless === true && result.roots?.length) throw fail('INVALID_PRIVATE_ROOT_ADAPTER')
        for (const root of result.roots ?? []) add(root.path, root.kind)
        identities.push(result.token ?? adapter)
        if (result.isCurrent !== undefined && typeof result.isCurrent !== 'function') throw fail('INVALID_PRIVATE_ROOT_ADAPTER')
        if (result.isCurrent) checks.push(result.isCurrent)
        return
      }
      throw fail(`PRIVATE_ROOT_ADAPTER_REQUIRED_${kind.toUpperCase()}`)
    }
    const profile = original(ctx.get('profileContext'))
    identities.push(profile)
    add(resolveDshHome(profile?.home), 'directory')
    const credentials = original(ctx.get('credentials'))
    identities.push(credentials)
    if (credentials?.ctx?.fiber) owners.push(credentials.ctx.fiber)
    if (credentials && Object.getPrototypeOf(credentials) === LocalCredentialProvider.prototype) add(resolveCredentialSpec(credentials.config).filename, 'file')
    else if (credentials) custom('credentials', 'credentials', credentials)

    const sessions = original(ctx.get('sessionPersistence'))
    identities.push(sessions)
    if (sessions) {
      const fiber = ownerFiber(sessions, liveFibers(SessionPersistencePlugin))
      if (fiber) { identities.push(fiber); owners.push(fiber); add(fiber.config.root, 'directory') }
      else custom('sessions', 'sessionPersistence', sessions)
    }
    const storage = original(ctx.get('storage'))
    identities.push(storage)
    if (storage) for (const name of [...storage.backend.names()].sort()) {
      const backend = original(storage.backend.get(name)); identities.push(name, backend)
      const key = storageBackendServiceKey(name)
      const fiber = Object.getPrototypeOf(backend) === JsonStorageBackend.prototype && liveFibers(StorageJsonPlugin)
        .find((fiber) => original(fiber.ctx.get(key)) === backend)
      if (fiber) { identities.push(fiber); owners.push(fiber); add(fiber.config.root, 'directory') }
      else custom('storage', name, backend)
    }
    const attachments = original(ctx.get('attachments'))
    identities.push(attachments)
    if (attachments?.ctx?.fiber) owners.push(attachments.ctx.fiber)
    if (attachments && Object.getPrototypeOf(attachments) === LocalAttachmentStore.prototype &&
      basename(attachments.root) === 'v1' && basename(dirname(attachments.root)) === 'attachments') {
      // root is a public AttachmentStore-local API. Its versioned root also
      // identifies this configured provider's home/cache without a private field.
      const home = dirname(dirname(attachments.root))
      add(join(home, 'attachments'), 'directory'); add(join(home, 'cache', 'attachments'), 'directory')
    } else if (attachments) custom('attachments', 'attachments', attachments)
    const sorted = [...new Map(roots.map((root) => [`${root.kind}:${root.path}:${root.anchor}`, root])).values()]
      .sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind))
    return { roots: sorted, identities, checks, owners }
  }
  let latest
  const resolve = () => {
    const snapshot = read(), signature = JSON.stringify(snapshot.roots)
    return latest = Object.freeze({ roots: Object.freeze(snapshot.roots),
      isCurrent() {
        try {
          const now = read()
          return signature === JSON.stringify(now.roots) && now.identities.length === snapshot.identities.length &&
            now.identities.every((value, index) => value === snapshot.identities[index]) && snapshot.checks.every((check) => check() === true) && now.checks.every((check) => check() === true)
        } catch { return false }
      },
    })
  }
  resolve.subscribe = (invalidate, isCurrent = () => latest?.isCurrent()) => {
    if (typeof invalidate !== 'function' || typeof ctx.on !== 'function') throw fail('PRIVATE_ROOT_LIFECYCLE_REQUIRED')
    const changed = () => { if (!isCurrent()) invalidate() }
    const disposers = [ctx.on('internal/service', (name) => {
      if (['credentials', 'sessionPersistence', 'storage', 'attachments', 'profileContext'].includes(name) || name.startsWith('storage.backend.')) changed()
    }, { global: true }), ctx.on('loader/config-update', changed, { global: true }),
    ctx.on('internal/update', function(_config, _noSave, next) {
      try { if (read().owners.includes(this)) invalidate() } catch { invalidate() }
      return next()
    }, { global: true })]
    return () => disposers.forEach((dispose) => dispose())
  }
  return resolve
}
