import { validateImportedSelfDescriptor, prunePortableSelfArchive, isGrowthSelfPath } from './self-transfer.js'
import { validateSelfDescriptor, decodeSelfSnapshot, filterSelfSnapshot } from './self-integrity.js'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { MemoryError, assertId, assertOnly, digest } from './contracts.js'
import { validatePersonaAnchor, validatePortablePersonaShape } from './persona-ledger.js'
import { validateSessionDescriptor } from './session-bindings.js'
import { validateRecordHead } from './record-integrity.js'

export const PURGE_LEDGER_PATH = '.administration/purge-ledger.json'
const json = (value) => `${JSON.stringify(value, null, 2)}\n`
const referenceKeys = new Set(['record_id', 'record_ids', 'record_refs', 'provenance_refs', 'evidence_refs', 'counterevidence_refs', 'evidence_id', 'source_record_id'])

function parse(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw new MemoryError('PURGE_STATE_REPAIR_REQUIRED')
  }
}

function optionalData(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

function inside(root, target) {
  const rel = relative(root, target)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new MemoryError('UNSAFE_STORAGE_PATH')
  let current = root
  for (const part of ['', ...rel.split(sep)]) {
    if (part) current = join(current, part)
    try { if (lstatSync(current).isSymbolicLink()) throw new MemoryError('UNSAFE_STORAGE_PATH') } catch (error) { if (error?.code !== 'ENOENT') throw error }
  }
  return target
}

export function loadPurgeLedger(root) {
  const ledger = parse(inside(root, join(root, PURGE_LEDGER_PATH)), { schema_version: 1, spaces: {} })
  if (ledger?.schema_version !== 1 || !ledger.spaces || typeof ledger.spaces !== 'object' || Array.isArray(ledger.spaces)) throw new MemoryError('PURGE_STATE_REPAIR_REQUIRED')
  return ledger
}

export function getPurgeState(root, spaceId) {
  const spaces = loadPurgeLedger(root).spaces
  const state = Object.hasOwn(spaces, assertId(spaceId)) ? spaces[spaceId] : null
  if (!state) return { generation: 0, revision_floor: 0, record_ids: [], evidence_ids: [], related_evidence_ids: [], asset_files: [], operations: [], clear_legacy_narratives: false }
  if (!Number.isSafeInteger(state.generation) || state.generation < 0 || !Number.isSafeInteger(state.revision_floor) || state.revision_floor < 0) throw new MemoryError('PURGE_STATE_REPAIR_REQUIRED')
  for (const key of ['record_ids', 'evidence_ids', 'related_evidence_ids', 'operations']) {
    if (!Array.isArray(state[key])) throw new MemoryError('PURGE_STATE_REPAIR_REQUIRED')
    try { state[key].forEach((id) => assertId(id)) } catch { throw new MemoryError('PURGE_STATE_REPAIR_REQUIRED') }
  }
  if (!Array.isArray(state.asset_files) || state.asset_files.some((file) => typeof file !== 'string' || !/^[A-Za-z0-9._-]+$/.test(file))) throw new MemoryError('PURGE_STATE_REPAIR_REQUIRED')
  return state
}

export function validatePortablePurgeState(value) {
  const keys = ['schema_version', 'generation', 'revision_floor', 'record_ids', 'evidence_ids', 'related_evidence_ids', 'asset_files', 'clear_legacy_narratives']
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key)) || value.schema_version !== 1 || !Number.isSafeInteger(value.generation) || value.generation < 0 || !Number.isSafeInteger(value.revision_floor) || value.revision_floor < 0 || typeof value.clear_legacy_narratives !== 'boolean') throw new MemoryError('INVALID_PORTABLE_PURGE_STATE')
  for (const key of ['record_ids', 'evidence_ids', 'related_evidence_ids']) {
    if (!Array.isArray(value[key])) throw new MemoryError('INVALID_PORTABLE_PURGE_STATE')
    value[key].forEach((id) => assertId(id))
  }
  if (!Array.isArray(value.asset_files) || value.asset_files.some((name) => typeof name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(name))) throw new MemoryError('INVALID_PORTABLE_PURGE_STATE')
  return value
}

function portable(state) {
  return { schema_version: 1, generation: state.generation, revision_floor: state.revision_floor ?? 0,
    record_ids: [...state.record_ids], evidence_ids: [...state.evidence_ids], related_evidence_ids: [...state.related_evidence_ids],
    asset_files: [...state.asset_files], clear_legacy_narratives: state.clear_legacy_narratives === true }
}

export function exportPurgeState(root, spaceId) { return portable(getPurgeState(root, spaceId)) }

export function preparePurgeImport(root, spaceId, operationId, incomingState) {
  assertId(operationId)
  validatePortablePurgeState(incomingState)
  const current = getPurgeState(root, spaceId)
  const merged = portable(current)
  for (const key of ['record_ids', 'evidence_ids', 'related_evidence_ids', 'asset_files']) merged[key] = [...new Set([...merged[key], ...incomingState[key]])].sort()
  merged.clear_legacy_narratives ||= incomingState.clear_legacy_narratives
  merged.revision_floor = Math.max(merged.revision_floor, incomingState.revision_floor)
  const changed = ['record_ids', 'evidence_ids', 'related_evidence_ids', 'asset_files'].some((key) => JSON.stringify([...current[key]].sort()) !== JSON.stringify(merged[key])) || merged.clear_legacy_narratives !== (current.clear_legacy_narratives === true) || merged.revision_floor !== current.revision_floor
  if (!changed) return { state: merged, descriptor: null }
  merged.generation = current.generation + 1
  const { schema_version, ...scope } = merged
  return { state: merged, descriptor: { operation_id: operationId, memory_space_id: spaceId, ...scope } }
}

export function referencesPurged(value, state) {
  const ids = new Set([...state.record_ids, ...(state.related_evidence_ids ?? []), ...(state.evidence_ids ?? [])])
  const walk = (item, key = '') => {
    if (typeof item === 'string') return referenceKeys.has(key) && ids.has(item)
    if (Array.isArray(item)) return item.some((entry) => typeof entry === 'string' ? referenceKeys.has(key) && ids.has(entry) : walk(entry, key))
    return item && typeof item === 'object' && Object.entries(item).some(([childKey, entry]) => walk(entry, childKey))
  }
  return Boolean(walk(value))
}

export function pathIsPurged(path, state) {
  if (state.clear_legacy_narratives && /(?:^|\/)legacy-v1\/dreams(?:\/|$)/.test(path.replaceAll('\\', '/'))) return true
  const parts = path.replaceAll('\\', '/').split('/')
  const records = new Set(state.record_ids)
  for (let index = 0; index < parts.length - 1; index++) {
    if (['records', 'entries', 'cold', 'external-changes'].includes(parts[index]) && records.has(parts[index + 1])) return true
    if (parts[index] === 'quarantine' && state.record_ids.some((id) => parts[index + 1] === id || parts[index + 1].startsWith(`${id}-`))) return true
    if (parts[index] === 'evidence' && (state.evidence_ids ?? []).includes(parts[index + 1]?.replace(/\.json$/, ''))) return true
    if (parts[index] === 'assets' && (state.asset_files ?? []).includes(parts[index + 1])) return true
  }
  return false
}

function sanitizeSelfManifest(value, exists) {
  let changed = false
  const next = structuredClone(value)
  for (const kind of ['traits', 'proposals']) {
    if (!next[kind] || typeof next[kind] !== 'object') continue
    for (const id of Object.keys(next[kind])) if (!exists(kind, id)) { delete next[kind][id]; changed = true }
  }
  if (next.maintenance && typeof next.maintenance === 'object') {
    for (const key of Object.keys(next.maintenance)) {
      if (!Array.isArray(next.maintenance[key])) continue
      const before = next.maintenance[key]
      const after = before.filter((item) => typeof item === 'string' ? Boolean(next.proposals?.[item]) : Boolean(next.proposals?.[item?.proposal_id]) || String(item?.proposal_id).startsWith('trait:') && Boolean(next.traits?.[String(item.proposal_id).slice(6)]))
      if (before.length !== after.length) { next.maintenance[key] = after; changed = true }
    }
  }
  if (changed && Number.isSafeInteger(next.revision)) next.revision++
  return { changed, value: next }
}

export function commitPurgeDescriptor(root, spaceRoot, descriptor, write) {
  if (!descriptor) return
  const spaceId = assertId(descriptor.memory_space_id)
  if (resolve(spaceRoot) !== resolve(root, 'spaces', spaceId)) throw new MemoryError('PURGE_SPACE_MISMATCH')
  assertId(descriptor.operation_id)
  for (const key of ['record_ids', 'evidence_ids', 'related_evidence_ids']) {
    if (!Array.isArray(descriptor[key])) throw new MemoryError('INVALID_PURGE_DESCRIPTOR')
    descriptor[key].forEach((id) => assertId(id))
  }
  if (!Array.isArray(descriptor.asset_files) || descriptor.asset_files.some((file) => typeof file !== 'string' || !/^[A-Za-z0-9._-]+$/.test(file))) throw new MemoryError('INVALID_PURGE_DESCRIPTOR')
  const ledger = loadPurgeLedger(root)
  const previous = getPurgeState(root, spaceId)
  if (previous.operations.includes(descriptor.operation_id)) return
  if (descriptor.generation !== previous.generation + 1) throw new MemoryError('PURGE_GENERATION_CONFLICT')
  const union = (key) => [...new Set([...(previous[key] ?? []), ...descriptor[key]])].sort()
  ledger.spaces[spaceId] = {
    generation: descriptor.generation, revision_floor: Math.max(previous.revision_floor ?? 0, descriptor.revision_floor ?? 0),
    record_ids: union('record_ids'), evidence_ids: union('evidence_ids'), related_evidence_ids: union('related_evidence_ids'),
    asset_files: union('asset_files'), operations: [...previous.operations, descriptor.operation_id],
    clear_legacy_narratives: previous.clear_legacy_narratives === true || descriptor.clear_legacy_narratives === true,
  }
  mkdirSync(join(root, '.administration'), { recursive: true, mode: 0o700 })
  write(inside(root, join(root, PURGE_LEDGER_PATH)), json(ledger))
}

function walkFiles(root, callback, prefix = '') {
  if (!existsSync(root)) return
  for (const child of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, child.name)
    const name = prefix + child.name
    if (child.isSymbolicLink()) throw new MemoryError('UNSAFE_STORAGE_PATH')
    if (child.isDirectory()) walkFiles(path, callback, `${name}/`)
    else callback(path, name)
  }
}

function managedJournal(name, spaceId) { return name.split('/').includes(spaceId) && /(?:^|\/)journal\/[^/]+\/prepared\.json$/.test(name) }
function validateJournal(value) {
  try {
    assertOnly(value, ['transaction_id','operation_id','receipt_key','generation','changes','purge_descriptor','persona_descriptor','persona_descriptors','session_descriptor','record_descriptors','record_imports','self_descriptors','self_imports','external_descriptor','root_upgrade','receipt'])
    assertId(value.transaction_id);assertId(value.operation_id)
    if (!/^[a-f0-9]{64}$/.test(value.receipt_key) || !Number.isSafeInteger(value.generation) || value.generation < 0 || !Array.isArray(value.changes)) throw new Error()
    for (const change of value.changes) {
      assertOnly(change,['path','data'])
      if (typeof change.path !== 'string' || isAbsolute(change.path) || change.path.includes('\\') || change.path.split('/').some((part)=>!part||part==='.'||part==='..')) throw new Error()
      if (change.data !== null && (typeof change.data !== 'string' || Buffer.from(change.data,'base64').toString('base64') !== change.data)) throw new Error()
    }
    if (value.session_descriptor) validateSessionDescriptor(value.session_descriptor)
    for (const descriptor of value.self_imports ?? []) validateImportedSelfDescriptor(descriptor)
    for (const descriptor of value.self_descriptors ?? []) validateSelfDescriptor(descriptor)
    for (const descriptor of value.persona_descriptors ?? (value.persona_descriptor ? [value.persona_descriptor] : [])) { assertOnly(descriptor,['expected_revision','anchor']);validatePersonaAnchor(descriptor.anchor) }
    for (const descriptor of value.record_descriptors ?? []) { assertOnly(descriptor,['expected_generation','next']);validateRecordHead(descriptor.next);if(!Number.isSafeInteger(descriptor.expected_generation)||descriptor.expected_generation<0)throw new Error() }
    for (const descriptor of value.record_imports ?? []) { assertOnly(descriptor,['expected_generation','next']);validateRecordHead(descriptor.next);if(descriptor.expected_generation!==0)throw new Error() }
    if (value.operation_id.startsWith('persona-batch-')) {
      assertOnly(value.receipt,['operation_id','request_hash','result'])
      assertOnly(value.receipt.result,['status','event_evidence_id','item_ids'])
      if (value.receipt.operation_id !== value.operation_id || !/^[a-f0-9]{64}$/.test(value.receipt.request_hash) || value.receipt.result.status !== 'recorded' || !/^event-[a-f0-9]{40}$/.test(value.receipt.result.event_evidence_id) || !Array.isArray(value.receipt.result.item_ids) || value.receipt.result.item_ids.some((id)=>!/^item-[a-f0-9]{40}$/.test(id))) throw new Error()
    }
    return value
  } catch { throw new MemoryError('MANAGED_JOURNAL_REPAIR_REQUIRED') }
}

export function validateManagedPurgeArtifacts(root, spaceId) {
  for (const category of ['exports', 'backups']) walkFiles(join(root, category), (path, name) => {
    if (managedJournal(name, spaceId)) { validateJournal(optionalData(path)); return }
    if (!path.endsWith('.json')) return
    const archive = optionalData(path)
    if (archive?.snapshot_format === 'dsh-persona-self') { decodeSelfSnapshot(archive);filterSelfSnapshot(root,spaceId,archive,[]);return }
    if (archive?.self_integrity_state && archive.memory_space_id === spaceId) prunePortableSelfArchive(archive,[])
    if (archive?.transfer_format !== 'dsh-memory-space' || archive.memory_space_id !== spaceId) return
    const { checksum, ...payload } = archive
    if (!Array.isArray(archive.files) || checksum !== digest(payload)) throw new MemoryError('MANAGED_ARCHIVE_REPAIR_REQUIRED')
    if (archive.persona_state !== undefined) {
      try { validatePortablePersonaShape(archive.persona_state, spaceId) } catch { throw new MemoryError('MANAGED_ARCHIVE_REPAIR_REQUIRED') }
    }
    for (const file of archive.files) {
      if (typeof file.data !== 'string' || file.encoding !== 'base64') throw new MemoryError('MANAGED_ARCHIVE_REPAIR_REQUIRED')
      const data = Buffer.from(file.data, 'base64')
      if (data.length !== file.size || digest(data) !== file.sha256) throw new MemoryError('MANAGED_ARCHIVE_REPAIR_REQUIRED')
      if (/^self\/.+\/manifest\.json$/.test(file.path)) {
        try { JSON.parse(data.toString('utf8')) } catch { throw new MemoryError('MANAGED_ARCHIVE_REPAIR_REQUIRED') }
      }
    }
  })
}

function filterArchive(archive, state, write, path) {
  if (archive?.transfer_format !== 'dsh-memory-space' || !Array.isArray(archive.files)) return false
  const self = archive.self_integrity_state ? prunePortableSelfArchive(archive,[...state.evidence_ids,...state.related_evidence_ids]) : null
  let retained = archive.files.filter((entry) => {
    if (pathIsPurged(entry.path, state)) return false
    if (/^(?:self|candidates|cold\/legacy-self)\//.test(entry.path) && entry.path.endsWith('.json')) {
      let value
      try { value = JSON.parse(Buffer.from(entry.data, 'base64').toString('utf8')) } catch { throw new MemoryError('MANAGED_ARCHIVE_REPAIR_REQUIRED') }
      if (referencesPurged(value, state)) return false
    }
    return true
  })
  let metadataChanged = false
  const retainedPaths = new Set(retained.map((entry) => entry.path))
  retained = retained.map((entry) => {
    if (self && isGrowthSelfPath(entry.path)) return entry
    const match = /^self\/([^/]+)\/manifest\.json$/.exec(entry.path)
    if (!match) return entry
    const value = JSON.parse(Buffer.from(entry.data, 'base64').toString('utf8'))
    const cleaned = sanitizeSelfManifest(value, (kind, id) => retainedPaths.has(`self/${match[1]}/${kind}/${id}.json`))
    if (!cleaned.changed) return entry
    metadataChanged = true
    const data = Buffer.from(json(cleaned.value))
    return { ...entry, data: data.toString('base64'), size: data.length, sha256: digest(data) }
  })
  if (self) {
    const before = digest(retained)
    retained = [...retained.filter(entry=>!isGrowthSelfPath(entry.path)),...self.files].sort((a,b)=>a.path.localeCompare(b.path))
    if (digest(retained)!==before || digest(self.state)!==digest(archive.self_integrity_state)) metadataChanged = true
  }
  if (!metadataChanged && retained.length === archive.files.length && archive.purge_generation >= state.generation) return false
  const cleaned = { ...archive, revision_watermark: Math.max(archive.revision_watermark, state.revision_floor), purge_generation: state.generation, purge_state: portable(state), files: retained }
  if (self) cleaned.self_integrity_state = self.state
  if (cleaned.integrity_state) cleaned.integrity_state = { ...cleaned.integrity_state,
    heads: cleaned.integrity_state.heads.filter((head) => !state.record_ids.includes(head.record_id)),
    omitted_pending_ids: cleaned.integrity_state.omitted_pending_ids.filter((id) => !state.record_ids.includes(id)) }
  delete cleaned.checksum
  cleaned.checksum = digest(cleaned)
  write(path, json(cleaned))
  return true
}

export function reconcilePurgeState(root, spaceRoot, write) {
  const spaceId = assertId(spaceRoot.split(/[\\/]/).pop())
  const state = getPurgeState(root, spaceId)
  if (!state.generation) return { removed_paths: [], sanitized_archives: [] }
  const removed = []
  const unresolved = []
  const remove = (relativePath) => {
    const path = inside(root, resolve(spaceRoot, relativePath))
    if (existsSync(path)) { rmSync(path, { recursive: true, force: true }); removed.push(relativePath) }
  }
  for (const id of state.record_ids) for (const prefix of ['records', 'cold', 'external-changes']) remove(`${prefix}/${id}`)
  for (const id of state.evidence_ids ?? []) remove(`evidence/${id}.json`)
  for (const file of state.asset_files ?? []) remove(`assets/${file}`)
  if (state.clear_legacy_narratives) remove('cold/legacy-v1/dreams')
  // Derived self data can be formed again from fresh evidence. Only the old
  // references are revoked; a deterministic trait path is not banned forever.
  for (const prefix of ['self', 'candidates', 'dreams', 'external-changes', 'cold', 'quarantine']) {
    walkFiles(join(spaceRoot, prefix), (path, relativePath) => {
      const full = `${prefix}/${relativePath}`
      if (pathIsPurged(full, state)) { rmSync(path, { force: true }); removed.push(full); return }
      if (!path.endsWith('.json') || path.endsWith('/manifest.json')) return
      const value = optionalData(path)
      if (!value) { unresolved.push(full); return }
      if (referencesPurged(value, state)) { rmSync(path, { force: true }); removed.push(full) }
    })
  }
  const selfRoot = join(spaceRoot, 'self')
  if (existsSync(selfRoot)) for (const dir of readdirSync(selfRoot, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const path = join(selfRoot, dir.name, 'manifest.json')
    const manifest = optionalData(path)
    if (!manifest) continue
    const cleaned = sanitizeSelfManifest(manifest, (kind, id) => existsSync(join(selfRoot, dir.name, kind, `${assertId(id)}.json`)))
    if (cleaned.changed) write(path, json(cleaned.value))
  }
  const manifestPath = join(spaceRoot, 'manifest.json')
  const manifest = parse(manifestPath)
  if (manifest && ((manifest.purge_generation ?? 0) < state.generation || (manifest.revision_watermark ?? 0) < state.revision_floor)) {
    write(manifestPath, json({ ...manifest, purge_generation: state.generation, revision_watermark: Math.max(manifest.revision_watermark ?? 0, state.revision_floor) }))
  }
  const indexPath = join(spaceRoot, 'index/records.json')
  const index = optionalData(indexPath)
  if (!index && existsSync(indexPath)) rmSync(indexPath, { force: true })
  if (index && Array.isArray(index.records)) {
    const records = index.records.filter((record) => !state.record_ids.includes(record.record_id))
    if (records.length !== index.records.length || (index.revision_watermark ?? 0) < state.revision_floor) write(indexPath, json({ ...index, records, revision_watermark: Math.max(index.revision_watermark ?? 0, state.revision_floor) }))
  }
  const sanitized = []
  for (const category of ['exports', 'backups']) {
    walkFiles(join(root, category), (path, name) => {
      const scoped = name.split('/').includes(spaceId)
      if (managedJournal(name, spaceId)) {
        const transaction = validateJournal(optionalData(path))
        const changes = filterRecoveryChanges(transaction.changes, state, manifest, { filterDerived: false })
        if (digest(changes) !== digest(transaction.changes)) { write(path, json({ ...transaction, changes })); sanitized.push(`${category}/${name}`) }
        return
      }
      if (scoped && pathIsPurged(name, state)) { rmSync(path, { force: true }); removed.push(`${category}/${name}`); return }
      if (scoped && /(?:^|\/)index\//.test(name)) { rmSync(path, { force: true }); removed.push(`${category}/${name}`); return }
      if (path.endsWith('.json')) {
        const archive = optionalData(path)
        if (archive?.snapshot_format === 'dsh-persona-self') {
          try { const next=filterSelfSnapshot(root,spaceId,archive,[...state.evidence_ids,...state.related_evidence_ids]);if(next){write(path,json(next));sanitized.push(`${category}/${name}`)} } catch { unresolved.push(`${category}/${name}`) }
          return
        }
        if (archive?.transfer_format === 'dsh-memory-space' && archive.memory_space_id === spaceId) {
          try { if (filterArchive(archive, state, write, path)) sanitized.push(`${category}/${name}`) } catch { unresolved.push(`${category}/${name}`) }
        }
        else if (scoped && /(?:^|\/)(?:self|candidates|dreams|external-changes|cold|quarantine)\//.test(name) && !name.endsWith('/manifest.json') && referencesPurged(archive, state)) { rmSync(path, { force: true }); removed.push(`${category}/${name}`) }
        else if (scoped && name.endsWith('write-observations.json') && archive?.entries) {
          const next = { ...archive, entries: { ...archive.entries } }
          let changed = false
          for (const id of state.record_ids) if (Object.hasOwn(next.entries, id)) { delete next.entries[id]; changed = true }
          if (changed) write(path, json(next))
        }
      }
    })
  }
  return { removed_paths: removed, sanitized_archives: sanitized, unresolved_paths: unresolved }
}

export function filterRecoveryChanges(changes, state, currentManifest, { filterDerived = false } = {}) {
  if (!state.generation) return changes
  return changes.flatMap((change) => {
    if (change.data === null) return [change]
    if (pathIsPurged(change.path, state)) return []
    if (/^(self|candidates)\//.test(change.path) && change.path.endsWith('.json') && !change.path.endsWith('/manifest.json')) {
      const value = JSON.parse(Buffer.from(change.data, 'base64').toString('utf8'))
      if (referencesPurged(value, state)) return []
    }
    if (change.path === 'manifest.json') {
      const value = JSON.parse(Buffer.from(change.data, 'base64').toString('utf8'))
      return [{ ...change, data: Buffer.from(json({ ...value, purge_generation: Math.max(value.purge_generation ?? 0, state.generation), revision_watermark: Math.max(value.revision_watermark ?? 0, currentManifest?.revision_watermark ?? 0, state.revision_floor ?? 0), identities: { ...(value.identities ?? {}), ...(currentManifest?.identities ?? {}) } })).toString('base64') }]
    }
    if (change.path === 'index/records.json') {
      const value = JSON.parse(Buffer.from(change.data, 'base64').toString('utf8'))
      if (!Array.isArray(value.records)) return []
      return [{ ...change, data: Buffer.from(json({ ...value, records: value.records.filter((record) => !state.record_ids.includes(record.record_id)), revision_watermark: Math.max(value.revision_watermark ?? 0, state.revision_floor ?? 0) })).toString('base64') }]
    }
    if (filterDerived && change.path.startsWith('index/')) return []
    return [change]
  })
}
