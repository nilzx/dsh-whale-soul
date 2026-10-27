import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, parse, resolve } from 'node:path'
import { FORMAT_VERSION, RECORD_SCHEMA_VERSION, API_VERSION, MemoryError, assertId, digest } from './contracts.js'
import { loadRecordHead } from './record-integrity.js'

const legacyMarkers = new Set(['entries', 'topics', 'dreams', 'assets', 'cold', 'quarantine', 'external-changes', 'index.json', 'index.md', 'state.json', 'write-observations.json'])
const ambiguousLegacy = new Set(['assets', 'cold', 'quarantine', 'backups', 'external-changes'])
const coordination = /^(?:\.writer(?:-recovery)?\.lock|\.(?:lock-candidate|retired-lock)-[a-f0-9-]{36})$/
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
function stat(path) {
  try { return lstatSync(path) } catch (error) {
    if (error.code === 'ENOENT') return null
    if (error.code === 'ENOTDIR') throw new MemoryError('INVALID_STORAGE_ROOT')
    if (['EACCES', 'EPERM'].includes(error.code)) throw new MemoryError('STORAGE_ACCESS_DENIED')
    throw error
  }
}
function safeStat(path) {
  const absolute = resolve(path), parts = []
  for (let current = absolute; current !== parse(current).root; current = dirname(current)) parts.push(current)
  for (const current of parts.reverse()) if (stat(current)?.isSymbolicLink()) throw new MemoryError('UNSAFE_STORAGE_PATH')
  return stat(absolute)
}
function readManifest(path, code) {
  const value = safeStat(path)
  if (!value) return null
  if (!value.isFile()) throw new MemoryError(code)
  try { return { value: JSON.parse(readFileSync(path, 'utf8')) } } catch (error) {
    if (['EACCES', 'EPERM'].includes(error.code)) throw new MemoryError('STORAGE_ACCESS_DENIED')
    throw new MemoryError(code)
  }
}
function validIds(values) {
  if (!Array.isArray(values) || new Set(values).size !== values.length) return false
  try { values.forEach((id) => assertId(id)); return true } catch { return false }
}
function validateCoordination(root, name) {
  const base = join(root, name), value = safeStat(base)
  if (!value?.isDirectory()) throw new MemoryError('MEMORY_ROOT_NOT_EMPTY')
  // A competing publisher may still be creating its atomic owner file. Only
  // the exact lock protocol's metadata names are accepted, never user data.
  const names = readdirSync(base)
  if (names.some((entry) => !/^owner\.json(?:\.tmp-[a-f0-9-]{36})?$/.test(entry))) throw new MemoryError('MEMORY_ROOT_NOT_EMPTY')
  for (const entry of names) {
    const path = join(base, entry)
    const file = safeStat(path)
    if (!file?.isFile()) throw new MemoryError('MEMORY_ROOT_NOT_EMPTY')
    if (entry !== 'owner.json' && file.size === 0) continue
    let owner
    try { owner = JSON.parse(readFileSync(path, 'utf8')) } catch { throw new MemoryError('LOCK_RECOVERY_REQUIRED') }
    if (!plain(owner) || Object.keys(owner).some((key) => !['token', 'pid', 'hostname', 'acquired_at'].includes(key)) || !/^[a-f0-9-]{36}$/.test(owner.token) || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.hostname !== 'string' || typeof owner.acquired_at !== 'string') throw new MemoryError('LOCK_RECOVERY_REQUIRED')
    if (name.startsWith('.lock-candidate-') && name !== `.lock-candidate-${owner.token}`) throw new MemoryError('LOCK_RECOVERY_REQUIRED')
  }
}
function administrationCoordination(root) {
  const base = join(root, '.administration'), directory = safeStat(base)
  if (!directory?.isDirectory()) throw new MemoryError('MEMORY_ROOT_RECOVERY_REQUIRED')
  const names = readdirSync(base)
  if (!names.length) return true
  if (names.length !== 1 || names[0] !== 'repair.lock') throw new MemoryError('MEMORY_ROOT_RECOVERY_REQUIRED')
  const gate = join(base, 'repair.lock')
  if (!safeStat(gate)?.isDirectory()) throw new MemoryError('MEMORY_ROOT_RECOVERY_REQUIRED')
  const files = readdirSync(gate)
  if (files.length !== 1 || files[0] !== 'owner.json') throw new MemoryError('MEMORY_ROOT_RECOVERY_REQUIRED')
  const owner = readManifest(join(gate, 'owner.json'), 'MEMORY_ROOT_RECOVERY_REQUIRED')?.value
  if (!plain(owner) || Object.keys(owner).some((key) => !['pid', 'hostname', 'token', 'acquired_at'].includes(key)) || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.hostname !== 'string' || !owner.hostname || owner.hostname.length > 255 || /[\0\r\n]/.test(owner.hostname)) throw new MemoryError('MEMORY_ROOT_RECOVERY_REQUIRED')
  try { assertId(owner.token, 'management token') } catch { throw new MemoryError('MEMORY_ROOT_RECOVERY_REQUIRED') }
  if (owner.acquired_at !== undefined && (typeof owner.acquired_at !== 'string' || !Number.isFinite(Date.parse(owner.acquired_at)))) throw new MemoryError('MEMORY_ROOT_RECOVERY_REQUIRED')
  return true
}
function checkRecordSchemas(spaceRoot, root, spaceId) {
  const records = join(spaceRoot, 'records'), folder = safeStat(records)
  if (!folder) return
  if (!folder.isDirectory()) throw new MemoryError('MEMORY_SPACE_RECOVERY_REQUIRED')
  const check = (path, recordId, revisionId = null) => {
    const file = safeStat(path)
    if (!file) return
    if (!file.isFile()) throw new MemoryError('MEMORY_SPACE_RECOVERY_REQUIRED')
    let meta
    try { meta = JSON.parse(readFileSync(path, 'utf8')) } catch (error) {
      if (error instanceof SyntaxError) return // Existing integrity diagnostics handle malformed records.
      if (['EACCES', 'EPERM'].includes(error.code)) throw new MemoryError('STORAGE_ACCESS_DENIED')
      throw error
    }
    if (plain(meta) && meta.schema_version !== undefined && meta.schema_version !== RECORD_SCHEMA_VERSION) {
      const head = loadRecordHead(root, spaceId, recordId)
      const revision = head?.revisions.find((entry) => entry.revision_id === (revisionId ?? head.head_revision_id))
      if (revision && revision.files['meta.json'] !== digest(readFileSync(path))) return
      throw new MemoryError('UNSUPPORTED_RECORD_SCHEMA')
    }
  }
  for (const entry of readdirSync(records, { withFileTypes: true })) {
    const base = join(records, entry.name), value = safeStat(base)
    if (!value?.isDirectory()) continue
    check(join(base, 'meta.json'), entry.name)
    const revisions = join(base, 'revisions'), history = safeStat(revisions)
    if (!history) continue
    if (!history.isDirectory()) throw new MemoryError('MEMORY_SPACE_RECOVERY_REQUIRED')
    for (const revision of readdirSync(revisions)) check(join(revisions, revision, 'meta.json'), entry.name, revision)
  }
}

/** Read-only bootstrap classification; never migrates or adopts existing data. */
export function inspectMemoryRoot(root, memorySpaceId) {
  root = resolve(root); assertId(memorySpaceId, 'memory_space_id')
  const rootStat = safeStat(root)
  if (!rootStat) return { kind: 'new', rootManifest: null, spaceManifest: null }
  if (!rootStat.isDirectory()) throw new MemoryError('INVALID_STORAGE_ROOT')
  const names = readdirSync(root), rootFile = readManifest(join(root, 'manifest.json'), 'INVALID_ROOT_MANIFEST')
  // Reject linked space parents before deciding that a missing manifest is a
  // recoverable orphan. No lock or directory has been created at this point.
  safeStat(join(root, 'spaces', memorySpaceId))
  if (!rootFile) {
    if (names.some((name) => legacyMarkers.has(name) && !ambiguousLegacy.has(name))) throw new MemoryError('LEGACY_MIGRATION_REQUIRED', 'Legacy memory found. Stop legacy writers and use the local owner migration CLI with a separate destination root.')
    if (names.some((name) => ambiguousLegacy.has(name))) throw new MemoryError('MEMORY_ROOT_FORMAT_REQUIRED')
    const adminOnly = names.includes('.administration') && administrationCoordination(root)
    const dataNames = names.filter((name) => !coordination.test(name) && !(adminOnly && name === '.administration'))
    if (dataNames.length) throw new MemoryError(dataNames.some((name) => ['spaces', '.administration'].includes(name)) ? 'MEMORY_ROOT_RECOVERY_REQUIRED' : 'MEMORY_ROOT_NOT_EMPTY')
    names.filter((name) => coordination.test(name)).forEach((name) => validateCoordination(root, name))
    return { kind: 'new', rootManifest: null, spaceManifest: null }
  }
  const manifest = rootFile.value
  if (!plain(manifest)) throw new MemoryError('INVALID_ROOT_MANIFEST')
  if (manifest.format_version !== FORMAT_VERSION) throw new MemoryError('UNSUPPORTED_FORMAT_VERSION')
  if (!validIds(manifest.spaces)) throw new MemoryError('INVALID_ROOT_MANIFEST')
  if (manifest.api_version === undefined || manifest.api_version === '1.0.0') throw new MemoryError('INTEGRITY_BASELINE_REQUIRED')
  if (manifest.api_version === '1.1.0') throw new MemoryError('SELF_INTEGRITY_UPGRADE_REQUIRED', 'Preserve this root and use the local owner upgrade-self command with a separate destination root. Existing unanchored self growth is not adopted automatically.')
  if (manifest.api_version !== API_VERSION) throw new MemoryError('UNSUPPORTED_API_VERSION')
  if (manifest.record_schema_versions !== undefined && (!Array.isArray(manifest.record_schema_versions) || !manifest.record_schema_versions.length || manifest.record_schema_versions.some((version) => version !== RECORD_SCHEMA_VERSION))) throw new MemoryError('UNSUPPORTED_RECORD_SCHEMA')
  if (names.some((name) => legacyMarkers.has(name))) throw new MemoryError('MIXED_MEMORY_ROOT', 'Mixed legacy and v2 memory found. Preserve this root and use an explicit owner recovery workflow; do not delete manifests.')
  const spaceRoot = join(root, 'spaces', memorySpaceId), spaceStat = safeStat(spaceRoot), listed = manifest.spaces.includes(memorySpaceId)
  if (!listed) {
    if (spaceStat) throw new MemoryError('MEMORY_SPACE_RECOVERY_REQUIRED')
    return { kind: 'new-space', rootManifest: manifest, spaceManifest: null }
  }
  if (!spaceStat?.isDirectory()) throw new MemoryError('MEMORY_SPACE_RECOVERY_REQUIRED')
  const spaceFile = readManifest(join(spaceRoot, 'manifest.json'), 'INVALID_SPACE_MANIFEST')
  if (!spaceFile) throw new MemoryError('MEMORY_SPACE_RECOVERY_REQUIRED')
  const space = spaceFile.value
  if (!plain(space)) throw new MemoryError('INVALID_SPACE_MANIFEST')
  if (space.format_version !== FORMAT_VERSION || space.memory_space_id !== memorySpaceId) throw new MemoryError('UNSUPPORTED_SPACE_FORMAT')
  if (!Number.isSafeInteger(space.revision_watermark) || space.revision_watermark < 0 || !Number.isSafeInteger(space.purge_generation ?? 0) || (space.purge_generation ?? 0) < 0) throw new MemoryError('INVALID_SPACE_MANIFEST')
  checkRecordSchemas(spaceRoot, root, memorySpaceId)
  return { kind: 'v2', rootManifest: manifest, spaceManifest: space }
}
