import { homedir } from 'node:os'
import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

/** Resolve the configured root once so linked storage keeps its directory link. */
export function resolveMemoryStorageRoot(value) {
  const root = resolve(value)
  try { return realpathSync(root) } catch (error) {
    if (error.code !== 'ENOENT' || dirname(root) === root) throw error
    return join(resolveMemoryStorageRoot(dirname(root)), basename(root))
  }
}

/** Resolve the DSH data home without importing DSH-internal helper packages. */
export function resolveDshHome() {
  const configured = process.env.DSH_HOME?.trim()
  return configured ? resolve(configured) : join(homedir(), '.dsh')
}

/** Expand only the two portable tilde forms used by plugin configuration. */
export function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return value
}

export function resolveMemoryRoot(config = {}) {
  const configuredRoot = config.memoryRoot ?? config.root
  if (typeof configuredRoot === 'string' && configuredRoot.trim()) {
    const value = expandHome(configuredRoot.trim())
    return resolveMemoryStorageRoot(isAbsolute(value) ? value : resolve(process.cwd(), value))
  }
  return resolveMemoryStorageRoot(join(resolveDshHome(), 'whale-soul', 'memory'))
}

/** Asset routes use the actual storage space, independent of persona display. */
export function resolveMemoryAssetRoot(config = {}) {
  const root = resolveMemoryRoot(config)
  if (Number(config.memoryFormat) !== 2) return root
  const space = config.memorySpaceId ?? 'owner'
  if (typeof space !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(space)) throw new Error('Invalid memory space')
  return join(root, 'spaces', space)
}
