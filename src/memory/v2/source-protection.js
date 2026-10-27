import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { MemoryError, assertId, assertOnly, digest } from './contracts.js'

const FILE = '.administration/source-protection.json'
const fail = () => { throw new MemoryError('SOURCE_PROTECTION_REPAIR_REQUIRED') }
const clone = value => JSON.parse(JSON.stringify(value))
function read(path, maxBytes = 256 * 1024) {
  if (realpathSync(path) !== resolve(path)) fail()
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes || stat.isSymbolicLink()) fail()
  return readFileSync(path)
}
/** Local paths are authority, never part of portable memory archives. */
export function validateSourceProtection(value) {
  try {
    assertOnly(value, ['schema_version', 'generation', 'sources'])
    if (value.schema_version !== 1 || !Number.isSafeInteger(value.generation) || value.generation < 1 || !Array.isArray(value.sources) || !value.sources.length || value.sources.length > 128) fail()
    const roots = new Set()
    for (const item of value.sources) {
      assertOnly(item, ['canonical_root', 'source_snapshot', 'operation_id'])
      if (typeof item.canonical_root !== 'string' || !isAbsolute(item.canonical_root) || resolve(item.canonical_root) !== item.canonical_root || item.canonical_root === resolve('/') || item.canonical_root.length > 4096 || /[\0\r\n]/.test(item.canonical_root) || !/^[a-f0-9]{64}$/.test(item.source_snapshot) || roots.has(item.canonical_root)) fail()
      assertId(item.operation_id); roots.add(item.canonical_root)
      if (existsSync(item.canonical_root) && realpathSync(item.canonical_root) !== item.canonical_root) fail()
    }
    return clone(value)
  } catch { fail() }
}
export function validateSourceProtectionDescriptor(value) {
  try {
    assertOnly(value, ['expected_generation', 'next'])
    const next = validateSourceProtection(value.next)
    if (!Number.isSafeInteger(value.expected_generation) || value.expected_generation < 0 || next.generation !== value.expected_generation + 1) fail()
    return { expected_generation: value.expected_generation, next }
  } catch { fail() }
}
function raw(root) { const path = join(root, FILE); return existsSync(path) ? validateSourceProtection(JSON.parse(read(path))) : null }
function pending(root) {
  const result = [], spaces = join(root, 'spaces')
  if (!existsSync(spaces)) return result
  for (const space of readdirSync(spaces)) {
    assertId(space); const journal = join(spaces, space, 'journal')
    if (!existsSync(journal)) continue
    const entries = readdirSync(journal); if (entries.length > 128) fail()
    for (const id of entries) {
      assertId(id); const path = join(journal, id), commit = join(path, 'COMMIT')
      if (!existsSync(commit)) continue
      const transaction = JSON.parse(read(join(path, 'prepared.json'), 96 * 1024 * 1024))
      if (!transaction.source_protection_descriptor) continue
      if (transaction.transaction_id !== id || read(commit).toString() !== id || transaction.operation_id !== transaction.receipt?.operation_id || transaction.receipt_key !== digest(transaction.operation_id) || !/^[a-f0-9]{64}$/.test(transaction.receipt.request_hash) || !Array.isArray(transaction.changes)) fail()
      result.push(validateSourceProtectionDescriptor(transaction.source_protection_descriptor).next)
    }
  }
  return result
}
/** Include committed pending restrictions before Runtime initialization can redo. */
export function sourceProtectionSnapshot(root) {
  try {
    root = resolve(root)
    const manifestPath = join(root, 'manifest.json'), descriptorPath = join(root, FILE)
    const manifestBytes = existsSync(manifestPath) ? read(manifestPath) : null
    const manifest = manifestBytes ? JSON.parse(manifestBytes) : null, current = raw(root), futures = pending(root)
    if (manifest?.source_protection_required !== undefined && manifest.source_protection_required !== true) fail()
    if (manifest?.source_protection_required && !current && !futures.length) fail()
    const roots = [...new Set([current, ...futures].filter(Boolean).flatMap(state => state.sources.map(item => item.canonical_root)))].sort()
    const ordered = [current, ...futures].filter(Boolean).sort((a,b) => a.generation - b.generation)
    const effective = new Map()
    for (const state of ordered) for (const item of state.sources) effective.set(item.canonical_root, item)
    const fingerprint = digest({ generation: Math.max(0, ...ordered.map(state => state.generation)), sources: [...effective.values()].sort((a,b) => a.canonical_root.localeCompare(b.canonical_root)) })
    return { roots, state: current, fingerprint, required: !!manifest?.source_protection_required }
  } catch { fail() }
}
export function prepareSourceProtection(root, source, snapshot, operationId, inheritedSources = []) {
  const current = sourceProtectionSnapshot(root).state
  const entries = new Map([...(current?.sources ?? []), ...inheritedSources].map(item => [item.canonical_root, item]))
  entries.set(source, { canonical_root: source, source_snapshot: snapshot, operation_id: operationId })
  const sources = [...entries.values()].sort((a,b) => a.canonical_root.localeCompare(b.canonical_root))
  return validateSourceProtectionDescriptor({ expected_generation: current?.generation ?? 0, next: { schema_version: 1, generation: (current?.generation ?? 0) + 1, sources } })
}
export function commitSourceProtection(root, descriptor, write, checkpoint = () => {}) {
  const { expected_generation, next } = validateSourceProtectionDescriptor(descriptor), current = raw(root)
  // Never let an older redo remove a local source restriction.
  if (current && current.generation >= next.generation) {
    if (next.sources.some(item => !current.sources.some(old => old.canonical_root === item.canonical_root))) fail()
  } else {
    if ((current?.generation ?? 0) !== expected_generation || current?.sources.some(item => !next.sources.some(value => value.canonical_root === item.canonical_root))) fail()
    write(join(root, FILE), JSON.stringify(next, null, 2))
  }
  checkpoint('after_source_protection')
  const path = join(root, 'manifest.json'), manifest = JSON.parse(read(path))
  if (manifest.source_protection_required !== true) write(path, JSON.stringify({ ...manifest, source_protection_required: true }, null, 2))
  checkpoint('after_source_protection_marker')
}
export function repairSourceProtectionMarker(root, write) {
  const snapshot = sourceProtectionSnapshot(root)
  if (snapshot.state && !snapshot.required) {
    const path = join(root, 'manifest.json'), manifest = JSON.parse(read(path)); write(path, JSON.stringify({ ...manifest, source_protection_required: true }, null, 2))
  }
}
