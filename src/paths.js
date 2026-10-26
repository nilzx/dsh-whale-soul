import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

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
    return isAbsolute(value) ? resolve(value) : resolve(process.cwd(), value)
  }
  return join(resolveDshHome(), 'whale-soul', 'memory')
}
