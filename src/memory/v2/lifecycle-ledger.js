import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { MemoryError, assertId, assertOnly, digest } from './contracts.js'
import { validateMaintenanceState } from './lifecycle-policy.js'

const json = (value) => JSON.stringify(value, null, 2) + '\n'
function safe(root, target) {
  if (typeof root !== 'string' || !isAbsolute(root)) throw new MemoryError('UNSAFE_STORAGE_PATH')
  const base = resolve(root), path = resolve(target), rel = relative(base, path)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new MemoryError('UNSAFE_STORAGE_PATH')
  let current = parse(path).root
  for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part)
    try { if (lstatSync(current).isSymbolicLink()) throw new MemoryError('UNSAFE_STORAGE_PATH') } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return path
}
function read(path, fallback = null) { try { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw new MemoryError('MAINTENANCE_STATE_REPAIR_REQUIRED'); return JSON.parse(readFileSync(path, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return fallback; throw new MemoryError('MAINTENANCE_STATE_REPAIR_REQUIRED') } }
function location(root, spaceId) { assertId(spaceId); return safe(root, join(root, '.administration', 'lifecycle', `${spaceId}.json`)) }

export function loadMaintenanceState(root, spaceId) {
  const state = read(location(root, spaceId)), manifest = read(safe(root, join(root, 'manifest.json')))
  if (!state && (manifest?.lifecycle_state_spaces?.includes(spaceId) || existsSync(safe(root, join(root, 'spaces', spaceId, 'index/lifecycle-maintenance.json'))))) throw new MemoryError('MAINTENANCE_STATE_REPAIR_REQUIRED')
  return state ? validateMaintenanceState(state, spaceId) : null
}

export function validateMaintenanceDescriptor(value) {
  assertOnly(value, ['schema_version', 'memory_space_id', 'expected_generation', 'next'])
  if (value.schema_version !== 1 || !Number.isSafeInteger(value.expected_generation) || value.expected_generation < 0) throw new MemoryError('INVALID_MAINTENANCE_DESCRIPTOR')
  assertId(value.memory_space_id); validateMaintenanceState(value.next, value.memory_space_id)
  if (value.next.generation !== value.expected_generation + 1) throw new MemoryError('INVALID_MAINTENANCE_DESCRIPTOR')
  return value
}

export function commitMaintenanceDescriptor(root, spaceRoot, value, write) {
  if (!value) return
  validateMaintenanceDescriptor(value)
  if (resolve(spaceRoot) !== join(resolve(root), 'spaces', value.memory_space_id)) throw new MemoryError('MAINTENANCE_SCOPE_MISMATCH')
  const previous = loadMaintenanceState(root, value.memory_space_id), next = value.next
  const replay = previous && digest(previous) === digest(next)
  if (!replay && (previous?.generation ?? 0) !== value.expected_generation) throw new MemoryError('MAINTENANCE_CAS_CONFLICT')
  if (!replay && previous && (next.initialized_at !== previous.initialized_at || next.baseline_revision_watermark !== previous.baseline_revision_watermark ||
    next.processed_revision_watermark === null && previous.processed_revision_watermark !== null ||
    (next.processed_revision_watermark ?? 0) < (previous.processed_revision_watermark ?? 0) ||
    (Date.parse(next.last_completed_at ?? next.initialized_at) < Date.parse(previous.last_completed_at ?? previous.initialized_at)) ||
    (Date.parse(next.last_checked_at ?? next.initialized_at) < Date.parse(previous.last_checked_at ?? previous.initialized_at)))) throw new MemoryError('MAINTENANCE_WATERMARK_ROLLBACK')
  const manifestPath = safe(root, join(root, 'manifest.json')), manifest = read(manifestPath)
  if (!manifest || !Array.isArray(manifest.spaces) || !manifest.spaces.includes(value.memory_space_id)) throw new MemoryError('INVALID_ROOT_MANIFEST')
  if (!replay) write(location(root, value.memory_space_id), json(next))
  // A durable declaration distinguishes a deleted root ledger from first boot.
  if (!manifest.lifecycle_state_spaces?.includes(value.memory_space_id)) write(manifestPath, json({ ...manifest,
    lifecycle_state_spaces: [...new Set([...(manifest.lifecycle_state_spaces ?? []), value.memory_space_id])].sort() }))
  reconcileMaintenanceState(root, spaceRoot, write)
}

export function reconcileMaintenanceState(root, spaceRoot, write) {
  const spaceId = assertId(spaceRoot.split(/[\\/]/).pop()), state = loadMaintenanceState(root, spaceId)
  if (!state) return null
  const manifest = read(safe(root, join(spaceRoot, 'manifest.json')))
  if (manifest && manifest.revision_watermark < (state.processed_revision_watermark ?? state.baseline_revision_watermark)) throw new MemoryError('MAINTENANCE_WATERMARK_ROLLBACK')
  const path = safe(root, join(spaceRoot, 'index/lifecycle-maintenance.json')), projection = read(path)
  if (digest(projection) !== digest(state)) write(path, json(state))
  return state
}
