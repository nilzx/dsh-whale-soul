import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { MEMORY_TYPES, MemoryError, assertId, digest, validateRecord } from './contracts.js'
import { normalizeMemorySlotKey } from './slot-policy.js'
import { validateLifecycleMetadata } from './lifecycle-policy.js'

const FILES = ['meta.json', 'gist.md', 'detail.md', 'evidence.jsonl', 'integrity.json']
const DATA_FILES = FILES.slice(0, 4)
const SCOPE = ['memory_space_id', 'record_id', 'persona_id', 'agent_identity_id', 'subject_id']
const HEAD_KEYS = ['schema_version', ...SCOPE, 'record_type', 'canonical_key_hash', 'head_revision_id', 'head_revision', 'generation', 'state', 'change_id', 'revisions']
const REVISION_KEYS = ['revision_id', 'revision', 'parent_revision_id', 'files', 'bundle_hash', 'operation_id', 'evidence_ids', 'asset_files']
const STATES = ['clean', 'quarantined', 'purged']
const HASH = /^[a-f0-9]{64}$/
const MAX_HEAD_BYTES = 16 * 1024 * 1024
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024
const fail = (code) => { throw new MemoryError(code) }
const clone = (value) => JSON.parse(JSON.stringify(value))
const same = (a, b) => digest(a) === digest(b)

function object(value, keys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)) ||
    Object.getOwnPropertySymbols(value).length || Object.values(Object.getOwnPropertyDescriptors(value)).some((entry) => entry.get || entry.set)) fail(code)
}

function ids(value, code) {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string') || new Set(value).size !== value.length) fail(code)
  for (const id of value) { try { assertId(id) } catch { fail(code) } }
  return value
}

function safe(root, target, file = false) {
  if (typeof root !== 'string' || !root || !isAbsolute(root)) fail('UNSAFE_STORAGE_PATH')
  const base = resolve(root), path = resolve(target), rel = relative(base, path)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail('UNSAFE_STORAGE_PATH')
  let current = parse(path).root
  const parts = path.slice(current.length).split(sep).filter(Boolean)
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index])
    let stat
    try { stat = lstatSync(current) } catch (error) { if (error.code === 'ENOENT') continue; fail('UNSAFE_STORAGE_PATH') }
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : file ? !stat.isFile() : !stat.isDirectory())) fail('UNSAFE_STORAGE_PATH')
  }
  return path
}

function headPath(root, spaceId, recordId) {
  if (typeof root !== 'string' || !root || !isAbsolute(root)) fail('UNSAFE_STORAGE_PATH')
  assertId(spaceId, 'memory_space_id'); assertId(recordId, 'record_id')
  return safe(root, join(root, '.administration', 'record-heads', spaceId, `${recordId}.json`), true)
}

function hashes(files) {
  object(files, FILES, 'RECORD_BUNDLE_INVALID')
  let bytes = 0
  const map = {}
  for (const file of FILES) {
    const data = files[file]
    if (!(typeof data === 'string' && data.isWellFormed() || Buffer.isBuffer(data))) fail('RECORD_BUNDLE_INVALID')
    bytes += Buffer.byteLength(data)
    if (bytes > MAX_BUNDLE_BYTES) fail('RECORD_BUNDLE_TOO_LARGE')
    map[file] = digest(data)
  }
  return map
}

function utf8(value) {
  if (typeof value === 'string') return value
  try { return new TextDecoder('utf-8', { fatal: true }).decode(value) } catch { fail('RECORD_BUNDLE_INVALID') }
}

function parseJson(value) {
  try { return JSON.parse(utf8(value)) } catch { fail('RECORD_BUNDLE_INVALID') }
}

function slotHash(meta) {
  if (meta.canonical_key === null || meta.canonical_key === undefined) return null
  if (typeof meta.canonical_key !== 'string' || !meta.canonical_key.trim() || meta.canonical_key.length > 256 || !meta.canonical_key.isWellFormed()) fail('RECORD_BUNDLE_INVALID')
  return digest(normalizeMemorySlotKey(meta.canonical_key))
}

function validateHead(head) {
  if (![1, 2].includes(head?.schema_version)) fail('RECORD_HEAD_INVALID')
  object(head, head.schema_version === 2 ? [...HEAD_KEYS, 'bundle_location'] : HEAD_KEYS, 'RECORD_HEAD_INVALID')
  if (head.schema_version === 2 && !['records', 'cold'].includes(head.bundle_location)) fail('RECORD_LOCATION_INVALID')
  if (!STATES.includes(head.state) || !MEMORY_TYPES.includes(head.record_type) ||
    head.canonical_key_hash !== null && !HASH.test(head.canonical_key_hash) ||
    !Number.isSafeInteger(head.generation) || head.generation < 1 || !Array.isArray(head.revisions) || !head.revisions.length) fail('RECORD_HEAD_INVALID')
  try { for (const key of [...SCOPE, 'head_revision_id']) assertId(head[key]) } catch { fail('RECORD_HEAD_INVALID') }
  if (head.change_id !== null) { try { assertId(head.change_id) } catch { fail('RECORD_HEAD_INVALID') } }
  if (head.state === 'clean' && head.change_id !== null || head.state === 'quarantined' && head.change_id === null) fail('RECORD_HEAD_INVALID')
  const seen = new Set()
  for (let index = 0; index < head.revisions.length; index++) {
    const revision = head.revisions[index]
    object(revision, REVISION_KEYS, 'RECORD_HEAD_INVALID')
    try { assertId(revision.revision_id); assertId(revision.operation_id) } catch { fail('RECORD_HEAD_INVALID') }
    if (seen.has(revision.revision_id) || revision.revision !== index + 1 || revision.parent_revision_id !== (index ? head.revisions[index - 1].revision_id : null)) fail('RECORD_HEAD_INVALID')
    seen.add(revision.revision_id)
    object(revision.files, FILES, 'RECORD_HEAD_INVALID')
    if (Object.values(revision.files).some((value) => !HASH.test(value)) || !HASH.test(revision.bundle_hash) || digest(revision.files) !== revision.bundle_hash) fail('RECORD_HEAD_INVALID')
    ids(revision.evidence_ids, 'RECORD_HEAD_INVALID'); ids(revision.asset_files, 'RECORD_HEAD_INVALID')
    if (!revision.evidence_ids.length) fail('RECORD_HEAD_INVALID')
  }
  const last = head.revisions.at(-1)
  if (head.head_revision_id !== last.revision_id || head.head_revision !== last.revision || head.generation < last.revision) fail('RECORD_HEAD_INVALID')
  if (Buffer.byteLength(JSON.stringify(head)) > MAX_HEAD_BYTES) fail('RECORD_HEAD_TOO_LARGE')
  return head
}

function scope(head, meta) {
  if (SCOPE.some((key) => head[key] !== meta[key])) fail('RECORD_SCOPE_MISMATCH')
}

function readBundle(files) {
  hashes(files)
  const meta = parseJson(files['meta.json'])
  try { validateRecord(meta) } catch { fail('RECORD_BUNDLE_INVALID') }
  validateLifecycleMetadata(meta)
  const integrity = parseJson(files['integrity.json'])
  object(integrity, ['revision_id', 'files'], 'RECORD_BUNDLE_INVALID')
  object(integrity.files, DATA_FILES, 'RECORD_BUNDLE_INVALID')
  if (integrity.revision_id !== meta.revision_id || DATA_FILES.some((file) => !HASH.test(integrity.files[file]) || digest(files[file]) !== integrity.files[file])) fail('RECORD_HASH_MISMATCH')
  let evidence
  try { evidence = utf8(files['evidence.jsonl']).split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line)) } catch { fail('RECORD_BUNDLE_INVALID') }
  const evidenceIds = evidence.map((entry) => entry?.evidence_id)
  ids(evidenceIds, 'RECORD_BUNDLE_INVALID'); ids(meta.provenance_refs, 'RECORD_BUNDLE_INVALID')
  if (!same([...evidenceIds].sort(), [...meta.provenance_refs].sort())) fail('RECORD_BUNDLE_INVALID')
  const assets = meta.assets ?? []
  ids(assets, 'RECORD_BUNDLE_INVALID')
  slotHash(meta)
  return { meta, gist: utf8(files['gist.md']), detail: utf8(files['detail.md']), evidence }
}

export function loadRecordHead(root, spaceId, recordId) {
  const path = headPath(root, spaceId, recordId)
  let bytes
  try {
    const stat = lstatSync(path)
    if (stat.size > MAX_HEAD_BYTES) fail('RECORD_HEAD_TOO_LARGE')
    bytes = readFileSync(path)
  } catch (error) { if (error.code === 'ENOENT') return null; if (error instanceof MemoryError) throw error; fail('RECORD_HEAD_INVALID') }
  let head
  try { head = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { fail('RECORD_HEAD_INVALID') }
  validateHead(head)
  if (head.memory_space_id !== spaceId || head.record_id !== recordId) fail('RECORD_SCOPE_MISMATCH')
  return head
}

export function listRecordHeads(root, spaceId) {
  assertId(spaceId, 'memory_space_id')
  if (typeof root !== 'string' || !root || !isAbsolute(root)) fail('UNSAFE_STORAGE_PATH')
  const folder = safe(root, join(root, '.administration', 'record-heads', spaceId))
  let entries
  try { entries = readdirSync(folder, { withFileTypes: true }) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  const heads = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink() || !entry.isFile()) fail('UNSAFE_STORAGE_PATH')
    if (!entry.name.endsWith('.json')) continue
    const head = loadRecordHead(root, spaceId, assertId(entry.name.slice(0, -5)))
    if (!head) fail('RECORD_HEAD_INVALID')
    heads.push(head)
  }
  return heads
}

export function recordBundleHash(files) { return digest(hashes(files)) }

export function recordBundlePath(head, revisionId = null) {
  validateHead(head)
  const location = head.schema_version === 2 ? head.bundle_location : 'records'
  const base = `${location === 'cold' ? 'cold/records' : 'records'}/${head.record_id}`
  if (revisionId === null) return base
  assertId(revisionId, 'revision_id')
  if (!head.revisions.some((entry) => entry.revision_id === revisionId)) fail('RECORD_CHAIN_CONFLICT')
  return `${base}/revisions/${revisionId}`
}

/** Resolve only a validated root-head location, never a model-supplied root. */
export function locateRecordBundle(store, head, revisionId = null) {
  validateHead(head)
  if (!store || store.memorySpaceId !== head.memory_space_id || typeof store.root !== 'string' ||
    typeof store.spaceRoot !== 'string' || typeof store.engine?.root !== 'string' || typeof store.engine?.resolvePath !== 'function' ||
    resolve(store.spaceRoot) !== resolve(store.root, 'spaces', head.memory_space_id) || resolve(store.engine.root) !== resolve(store.spaceRoot)) fail('RECORD_SCOPE_MISMATCH')
  const base = recordBundlePath(head, revisionId)
  return Object.freeze({ base, directory: store.engine.resolvePath(base) })
}

function checkLifecycleLocation(meta, location) {
  const lifecycle = validateLifecycleMetadata(meta)
  if (location === 'cold' && !['cold', 'archived'].includes(lifecycle?.tier) || location === 'records' && lifecycle?.tier === 'cold') fail('LIFECYCLE_LOCATION_CONFLICT')
}

export function verifyRecordBundle(head, files, revisionId = head?.head_revision_id) {
  validateHead(head)
  assertId(revisionId, 'revision_id')
  const expected = head.revisions.find((entry) => entry.revision_id === revisionId)
  if (!expected) fail('RECORD_CHAIN_CONFLICT')
  const actual = hashes(files)
  if (!same(actual, expected.files) || digest(actual) !== expected.bundle_hash) fail('RECORD_HASH_MISMATCH')
  const record = readBundle(files), { meta } = record
  scope(head, meta)
  if (meta.revision_id !== expected.revision_id || meta.revision !== expected.revision || (meta.supersedes ?? null) !== expected.parent_revision_id ||
    !same([...meta.provenance_refs].sort(), [...expected.evidence_ids].sort()) || !same([...(meta.assets ?? [])].sort(), [...expected.asset_files].sort())) fail('RECORD_CHAIN_CONFLICT')
  if (revisionId === head.head_revision_id && (meta.type !== head.record_type || slotHash(meta) !== head.canonical_key_hash)) fail('RECORD_CHAIN_CONFLICT')
  if (revisionId === head.head_revision_id) checkLifecycleLocation(meta, head.schema_version === 2 ? head.bundle_location : 'records')
  return record
}

function previous(root, spaceId, recordId, provided) {
  headPath(root, spaceId, recordId)
  const head = provided === undefined ? loadRecordHead(root, spaceId, recordId) : provided
  if (head !== null) {
    validateHead(head)
    if (head.memory_space_id !== spaceId || head.record_id !== recordId) fail('RECORD_SCOPE_MISMATCH')
  }
  return head
}

function nextGeneration(head) {
  const generation = (head?.generation ?? 0) + 1
  if (!Number.isSafeInteger(generation)) fail('RECORD_GENERATION_CONFLICT')
  return generation
}

export function buildRecordDescriptor({ root, spaceId, meta, files, operationId, mode = 'append', state = 'clean', changeId = null, previousHead, bundleLocation } = {}) {
  assertId(operationId, 'operation_id'); assertId(spaceId, 'memory_space_id')
  if (!['append', 'baseline', 'repair', 'adopt'].includes(mode) || !STATES.includes(state)) fail('RECORD_STATE_CONFLICT')
  const record = readBundle(files)
  if (!meta || typeof meta !== 'object' || Array.isArray(meta) || !same(meta, record.meta)) fail('RECORD_BUNDLE_INVALID')
  const old = previous(root, spaceId, meta.record_id, previousHead)
  if (bundleLocation !== undefined && !['records', 'cold'].includes(bundleLocation)) fail('RECORD_LOCATION_INVALID')
  const oldLocation = old?.schema_version === 2 ? old.bundle_location : 'records'
  const location = bundleLocation ?? oldLocation
  if (meta.memory_space_id !== spaceId) fail('RECORD_SCOPE_MISMATCH')
  if (old) scope(old, meta)
  if (old?.state === 'purged') fail('RECORD_STATE_CONFLICT')
  if (mode === 'repair') {
    if (!old || state !== 'clean' || changeId !== null) fail('RECORD_STATE_CONFLICT')
    if (location !== oldLocation) fail('RECORD_LOCATION_CONFLICT')
    checkLifecycleLocation(meta, location)
    verifyRecordBundle(old, files)
    return { expected_generation: old.generation, next: { ...clone(old), generation: nextGeneration(old), state: 'clean', change_id: null } }
  }
  if (state !== 'clean' || changeId !== null || mode === 'adopt' && old?.state !== 'quarantined' || mode !== 'adopt' && old && old.state !== 'clean') fail('RECORD_STATE_CONFLICT')
  if (mode === 'baseline' && old?.revisions.some((entry) => entry.revision_id === meta.revision_id)) {
    if (location !== oldLocation) fail('RECORD_LOCATION_CONFLICT')
    if (old.revisions.find((entry) => entry.revision_id === meta.revision_id).revision !== meta.revision) fail('RECORD_CHAIN_CONFLICT')
    verifyRecordBundle(old, files, meta.revision_id)
    return { expected_generation: old.generation, next: clone(old) }
  }
  checkLifecycleLocation(meta, location)
  if (meta.revision !== (old?.head_revision ?? 0) + 1 || (meta.supersedes ?? null) !== (old?.head_revision_id ?? null) || old?.revisions.some((entry) => entry.revision_id === meta.revision_id)) fail('RECORD_CHAIN_CONFLICT')
  const fileHashes = hashes(files)
  const revision = { revision_id: meta.revision_id, revision: meta.revision, parent_revision_id: meta.supersedes ?? null,
    files: fileHashes, bundle_hash: digest(fileHashes), operation_id: operationId,
    evidence_ids: [...meta.provenance_refs].sort(), asset_files: [...(meta.assets ?? [])].sort() }
  const schema = old?.schema_version === 2 || bundleLocation !== undefined || meta.lifecycle !== undefined ? 2 : 1
  const next = { schema_version: schema, ...(schema === 2 ? { bundle_location: location } : {}), ...Object.fromEntries(SCOPE.map((key) => [key, meta[key]])), record_type: meta.type, canonical_key_hash: slotHash(meta),
    head_revision_id: meta.revision_id, head_revision: meta.revision, generation: nextGeneration(old), state, change_id: changeId,
    revisions: [...clone(old?.revisions ?? []), revision] }
  validateHead(next)
  return { expected_generation: old?.generation ?? 0, next }
}

export function buildRecordStateDescriptor({ root, spaceId, recordId, state, changeId = null, operationId, previousHead } = {}) {
  assertId(operationId, 'operation_id')
  const old = previous(root, spaceId, recordId, previousHead)
  if (!old || !STATES.includes(state) || old.state === 'purged' || state === 'clean' && old.state !== 'clean') fail('RECORD_STATE_CONFLICT')
  const next = { ...clone(old), generation: nextGeneration(old), state, change_id: changeId }
  validateHead(next)
  return { expected_generation: old.generation, next }
}

export function commitRecordDescriptor(root, spaceRoot, descriptor, write) {
  object(descriptor, ['expected_generation', 'next'], 'RECORD_HEAD_INVALID')
  const next = validateHead(descriptor.next)
  if (typeof write !== 'function' || !Number.isSafeInteger(descriptor.expected_generation) || descriptor.expected_generation < 0) fail('RECORD_HEAD_INVALID')
  if (typeof root !== 'string' || !isAbsolute(root) || typeof spaceRoot !== 'string' || !isAbsolute(spaceRoot)) fail('UNSAFE_STORAGE_PATH')
  const expectedSpace = resolve(root, 'spaces', next.memory_space_id)
  if (resolve(spaceRoot) !== expectedSpace) fail('RECORD_SCOPE_MISMATCH')
  safe(root, expectedSpace)
  const old = loadRecordHead(root, next.memory_space_id, next.record_id)
  if (old && same(old, next)) return
  if ((old?.generation ?? 0) !== descriptor.expected_generation || next.generation !== descriptor.expected_generation + 1) fail('RECORD_GENERATION_CONFLICT')
  if (!old) {
    if (next.revisions.length !== 1 || next.state !== 'clean') fail('RECORD_CHAIN_CONFLICT')
  } else {
    scope(old, next)
    if (old.state === 'purged') fail('RECORD_STATE_CONFLICT')
    const prefix = next.revisions.slice(0, old.revisions.length)
    if (!same(prefix, old.revisions)) fail('RECORD_CHAIN_CONFLICT')
    const appended = next.revisions.length - old.revisions.length
    if (![0, 1].includes(appended) || appended === 1 && next.state !== 'clean') fail('RECORD_CHAIN_CONFLICT')
    if (!appended && (next.head_revision_id !== old.head_revision_id || next.head_revision !== old.head_revision || next.record_type !== old.record_type || next.canonical_key_hash !== old.canonical_key_hash)) fail('RECORD_CHAIN_CONFLICT')
    if (!appended && (next.schema_version === 2 ? next.bundle_location : 'records') !== (old.schema_version === 2 ? old.bundle_location : 'records')) fail('RECORD_LOCATION_CONFLICT')
  }
  const path = headPath(root, next.memory_space_id, next.record_id)
  const result = write(path, `${JSON.stringify(next, null, 2)}\n`)
  if (result && typeof result.then === 'function') { Promise.resolve(result).catch(() => {}); fail('TRUSTED_SYNC_WRITER_REQUIRED') }
  headPath(root, next.memory_space_id, next.record_id)
}

/** Install a host-approved portable anchor without selecting a winning revision. */
export function commitImportedRecordHead(root, spaceRoot, descriptor, write) {
  object(descriptor, ['expected_generation', 'next'], 'RECORD_HEAD_INVALID')
  const next = validateHead(descriptor.next)
  if (descriptor.expected_generation !== 0 || typeof write !== 'function') fail('RECORD_HEAD_INVALID')
  if (typeof root !== 'string' || !isAbsolute(root) || typeof spaceRoot !== 'string' || !isAbsolute(spaceRoot)) fail('UNSAFE_STORAGE_PATH')
  if (resolve(spaceRoot) !== resolve(root, 'spaces', next.memory_space_id)) fail('RECORD_SCOPE_MISMATCH')
  safe(root, spaceRoot)
  const old = loadRecordHead(root, next.memory_space_id, next.record_id)
  if (old) {
    if (same(old, next)) return
    fail('RECORD_IMPORT_CONFLICT')
  }
  const path = headPath(root, next.memory_space_id, next.record_id)
  const result = write(path, `${JSON.stringify(next, null, 2)}\n`)
  if (result && typeof result.then === 'function') { Promise.resolve(result).catch(() => {}); fail('TRUSTED_SYNC_WRITER_REQUIRED') }
  headPath(root, next.memory_space_id, next.record_id)
}

export { validateHead as validateRecordHead }
