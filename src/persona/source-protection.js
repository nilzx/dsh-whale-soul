import { sourceProtectionSnapshot } from '../memory/v2/source-protection.js'

/** Compose local migration-source authority with trusted host-private paths. */
export function protectMigrationSources(resolvePrivateRoots, root) {
  const resolve = () => {
    const base = resolvePrivateRoots(), local = sourceProtectionSnapshot(root)
    const roots = [...base.roots, ...local.roots.map(path => Object.freeze({ path, anchor: path, kind: 'directory' }))]
    return Object.freeze({ roots: Object.freeze(roots), isCurrent() {
      try { return base.isCurrent() && sourceProtectionSnapshot(root).fingerprint === local.fingerprint } catch { return false }
    } })
  }
  resolve.subscribe = (...args) => resolvePrivateRoots.subscribe(...args)
  return resolve
}
