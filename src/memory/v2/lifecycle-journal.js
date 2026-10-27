import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { MemoryError, assertId, assertOnly, digest } from './contracts.js'
import { LIFECYCLE_CAPABILITY } from './lifecycle-policy.js'
import { loadRecordHead, recordBundlePath, validateRecordHead, verifyRecordBundle } from './record-integrity.js'

const FILES = ['meta.json', 'gist.md', 'detail.md', 'evidence.jsonl', 'integrity.json']
const HASH = /^[a-f0-9]{64}$/
const MAX_BYTES = 64 * 1024 * 1024
const json = (value) => JSON.stringify(value, null, 2) + '\n'
function identity(path) { try { const stat = lstatSync(path); return { dev: stat.dev, ino: stat.ino, directory: stat.isDirectory(), symlink: stat.isSymbolicLink() } } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
const sameIdentity = (a, b) => a?.directory && !a.symlink && a.dev === b?.dev && a.ino === b?.ino
const same = (a, b) => digest(a) === digest(b)

/** Complete, bounded current/history capture. Unknown files require owner review. */
export function readLifecycleTree(engine, base, head) {
  validateRecordHead(head)
  const expected = new Set([...FILES, ...head.revisions.flatMap((revision) => FILES.map((file) => `revisions/${revision.revision_id}/${file}`))])
  const output = {}; let totalBytes = 0
  const walk = (prefix = '') => {
    const path = engine.resolvePath(`${base}${prefix ? `/${prefix}` : ''}`)
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new MemoryError('UNSAFE_STORAGE_PATH')
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory() && !entry.isSymbolicLink() && (name === 'revisions' || head.revisions.some((revision) => name === `revisions/${revision.revision_id}`))) walk(name)
      else {
        const file = engine.resolvePath(`${base}/${name}`), value = lstatSync(file)
        if (!expected.has(name) || !value.isFile() || value.isSymbolicLink() || value.nlink !== 1) throw new MemoryError('UNEXPECTED_RECORD_FILES')
        output[name] = readFileSync(file)
        totalBytes += output[name].length
        if (totalBytes > MAX_BYTES) throw new MemoryError('LIFECYCLE_BUNDLE_TOO_LARGE')
      }
    }
  }
  walk()
  if (Object.keys(output).length !== expected.size || [...expected].some((name) => !Object.hasOwn(output, name))) throw new MemoryError('INTEGRITY_HISTORY_REQUIRED')
  verifyRecordBundle(head, Object.fromEntries(FILES.map((file) => [file, output[file]])))
  for (const revision of head.revisions) verifyRecordBundle(head, Object.fromEntries(FILES.map((file) => [file, output[`revisions/${revision.revision_id}/${file}`]])), revision.revision_id)
  return output
}

export function validateLifecycleDescriptor(value) {
  assertOnly(value, ['schema_version', 'operation_id', 'record_id', 'source_identity', 'previous_head', 'record_descriptor', 'source_hashes', 'target_files'])
  if (value.schema_version !== 1) throw new MemoryError('INVALID_LIFECYCLE_DESCRIPTOR')
  assertId(value.operation_id); assertId(value.record_id)
  validateRecordHead(value.previous_head); validateRecordHead(value.record_descriptor?.next)
  assertOnly(value.record_descriptor, ['expected_generation', 'next'])
  assertOnly(value.source_identity, ['dev', 'ino'])
  const previous = value.previous_head, next = value.record_descriptor.next
  if (previous.record_id !== value.record_id || next.record_id !== value.record_id || ['memory_space_id', 'persona_id', 'agent_identity_id', 'subject_id'].some((key) => previous[key] !== next[key]) ||
    !same(previous.revisions, next.revisions.slice(0, -1)) ||
    previous.state !== 'clean' || next.state !== 'clean' || value.record_descriptor.expected_generation !== previous.generation ||
    next.generation !== previous.generation + 1 || next.head_revision !== previous.head_revision + 1 ||
    (previous.bundle_location ?? 'records') === next.bundle_location || !['records', 'cold'].includes(next.bundle_location)) throw new MemoryError('INVALID_LIFECYCLE_DESCRIPTOR')
  if (!value.source_identity || !Number.isSafeInteger(value.source_identity.dev) || !Number.isSafeInteger(value.source_identity.ino)) throw new MemoryError('INVALID_LIFECYCLE_DESCRIPTOR')
  if (!value.source_hashes || !value.target_files || typeof value.source_hashes !== 'object' || typeof value.target_files !== 'object') throw new MemoryError('INVALID_LIFECYCLE_DESCRIPTOR')
  const sourceNames = [...FILES, ...previous.revisions.flatMap((revision) => FILES.map((file) => `revisions/${revision.revision_id}/${file}`))].sort()
  const targetNames = [...FILES, ...next.revisions.flatMap((revision) => FILES.map((file) => `revisions/${revision.revision_id}/${file}`))].sort()
  if (!same(Object.keys(value.source_hashes).sort(), sourceNames) || Object.values(value.source_hashes).some((hash) => !HASH.test(hash)) || !same(Object.keys(value.target_files).sort(), targetNames)) throw new MemoryError('INVALID_LIFECYCLE_DESCRIPTOR')
  if (FILES.some((file) => value.source_hashes[file] !== previous.revisions.at(-1).files[file]) || previous.revisions.some((revision) => FILES.some((file) => value.source_hashes[`revisions/${revision.revision_id}/${file}`] !== revision.files[file]))) throw new MemoryError('RECORD_CHAIN_CONFLICT')
  let bytes = 0
  const decoded = Object.fromEntries(targetNames.map((name) => {
    const encoded = value.target_files[name]
    if (typeof encoded !== 'string') throw new MemoryError('INVALID_LIFECYCLE_DESCRIPTOR')
    const data = Buffer.from(encoded, 'base64'); bytes += data.length
    if (data.toString('base64') !== encoded || bytes > MAX_BYTES) throw new MemoryError('INVALID_LIFECYCLE_DESCRIPTOR')
    return [name, data]
  }))
  verifyRecordBundle(next, Object.fromEntries(FILES.map((file) => [file, decoded[file]])))
  for (const revision of next.revisions) verifyRecordBundle(next, Object.fromEntries(FILES.map((file) => [file, decoded[`revisions/${revision.revision_id}/${file}`]])), revision.revision_id)
  // Every prior revision is immutable; the prior current bytes also survive in history.
  for (const revision of previous.revisions) for (const file of FILES) if (digest(decoded[`revisions/${revision.revision_id}/${file}`]) !== revision.files[file]) throw new MemoryError('RECORD_CHAIN_CONFLICT')
  return decoded
}

/** Atomic detach retains originals; exclusive destination publication never overwrites foreign bytes. */
export function applyLifecycleTransition(engine, value, write, checkpoint = () => {}) {
  const targetFiles = validateLifecycleDescriptor(value), previous = value.previous_head, next = value.record_descriptor.next
  if (previous.memory_space_id !== engine.memorySpaceId) throw new MemoryError('RECORD_SCOPE_MISMATCH')
  const rootManifestPath = join(engine.lockRoot, 'manifest.json'), rootManifest = JSON.parse(readFileSync(rootManifestPath, 'utf8'))
  if (rootManifest.lifecycle_capabilities !== undefined && (!Array.isArray(rootManifest.lifecycle_capabilities) || rootManifest.lifecycle_capabilities.some((item) => item !== LIFECYCLE_CAPABILITY))) throw new MemoryError('UNSUPPORTED_LIFECYCLE_CAPABILITY')
  if (!rootManifest.lifecycle_capabilities?.includes(LIFECYCLE_CAPABILITY)) write(rootManifestPath, json({ ...rootManifest, lifecycle_capabilities: [LIFECYCLE_CAPABILITY] }))
  const base = `cold/transitions/${value.record_id}/${value.operation_id}`, sourceBase = recordBundlePath(previous), targetBase = recordBundlePath(next)
  const source = engine.resolvePath(sourceBase), savedBase = `${base}/source`, saved = engine.resolvePath(savedBase), target = engine.resolvePath(targetBase)
  const decisionPath = engine.resolvePath(`${base}/decision.json`), ownershipPath = engine.resolvePath(`${base}/publication.json`)
  const decision = () => { try { return JSON.parse(readFileSync(decisionPath, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return null; throw new MemoryError('LIFECYCLE_RECOVERY_REQUIRED') } }
  if (decision()?.status === 'conflict') return 'conflict'
  const head = loadRecordHead(engine.lockRoot, engine.memorySpaceId, value.record_id)
  if (same(head, next) && decision()?.status === 'published') {
    const actual = readLifecycleTree(engine, targetBase, next)
    if (!same(Object.fromEntries(Object.entries(actual).map(([name, data]) => [name, digest(data)])), Object.fromEntries(Object.entries(targetFiles).map(([name, data]) => [name, digest(data)])))) throw new MemoryError('LIFECYCLE_RECOVERY_REQUIRED')
    return 'published'
  }
  if (!same(head, previous) && !same(head, next)) throw new MemoryError('RECORD_HEAD_CONFLICT')
  const conflict = (reason) => {
    // Preserve a recreated source and the detached original independently.
    if (!existsSync(source) && sameIdentity(identity(saved), value.source_identity)) renameSync(saved, source)
    write(decisionPath, json({ schema_version: 1, status: 'conflict', reason_code: reason, record_id: value.record_id }))
    return 'conflict'
  }
  if (!existsSync(saved)) {
    if (!sameIdentity(identity(source), value.source_identity)) return conflict('SOURCE_IDENTITY_CHANGED')
    if (existsSync(target)) return conflict('DESTINATION_EXISTS')
    mkdirSync(dirname(saved), { recursive: true, mode: 0o700 })
    checkpoint('before_lifecycle_detach', { record_id: value.record_id })
    renameSync(source, saved)
    checkpoint('after_lifecycle_detach', { record_id: value.record_id })
  }
  if (!sameIdentity(identity(saved), value.source_identity)) return conflict('CAPTURE_IDENTITY_CHANGED')
  try {
    const captured = readLifecycleTree(engine, savedBase, previous)
    if (!same(Object.fromEntries(Object.entries(captured).map(([name, data]) => [name, digest(data)])), value.source_hashes)) return conflict('SOURCE_CHANGED')
  } catch (error) { if (error.code === 'UNSAFE_STORAGE_PATH') throw error; return conflict('SOURCE_CHANGED') }
  if (existsSync(source)) return conflict('SOURCE_RECREATED')
  let ownership = null
  try { ownership = JSON.parse(readFileSync(ownershipPath, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw new MemoryError('LIFECYCLE_RECOVERY_REQUIRED') }
  if (existsSync(target)) {
    if (ownership?.operation_id !== value.operation_id || !sameIdentity(identity(target), ownership)) return conflict('DESTINATION_CHANGED')
  } else {
    if (ownership) return conflict('DESTINATION_REMOVED')
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    try { mkdirSync(target, { mode: 0o700 }) } catch (error) { if (error.code === 'EEXIST') return conflict('DESTINATION_EXISTS'); throw error }
    const own = identity(target)
    write(ownershipPath, json({ operation_id: value.operation_id, dev: own.dev, ino: own.ino }))
    checkpoint('after_lifecycle_publication_owner', { record_id: value.record_id })
  }
  for (const [name, data] of Object.entries(targetFiles)) {
    const path = engine.resolvePath(`${targetBase}/${name}`)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    let fd
    try {
      fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
      writeFileSync(fd, data); fsyncSync(fd)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || digest(readFileSync(path)) !== digest(data)) return conflict('DESTINATION_CHANGED')
    } finally { if (fd !== undefined) closeSync(fd) }
  }
  const published = readLifecycleTree(engine, targetBase, next)
  if (!same(Object.fromEntries(Object.entries(published).map(([name, data]) => [name, digest(data)])), Object.fromEntries(Object.entries(targetFiles).map(([name, data]) => [name, digest(data)])))) return conflict('DESTINATION_CHANGED')
  checkpoint('after_lifecycle_publish', { record_id: value.record_id })
  write(decisionPath, json({ schema_version: 1, status: 'published', record_id: value.record_id }))
  return 'published'
}
