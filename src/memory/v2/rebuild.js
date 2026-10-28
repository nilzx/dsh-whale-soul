import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { API_VERSION, FORMAT_VERSION, RECORD_SCHEMA_VERSION, MEMORY_TYPES, CLAIM_KINDS, MemoryError, assertId, assertOnly, digest, validateRecord } from './contracts.js'
import { MemoryStoreV2 } from './store.js'
import { inspectMemoryRoot } from './root-format.js'
import { MemoryTransfer } from './transfer.js'
import { preparePersonaImport, assertPersonaFilesAllowed, personaIdentityProjection } from './persona-ledger.js'
import { exportPurgeState, preparePurgeImport, referencesPurged } from './purge-ledger.js'
import { verifySelfIntegrity } from './self-integrity.js'
import { readSessionBindings } from './session-bindings.js'
import { validateSourceProtection, repairSourceProtectionMarker } from './source-protection.js'
import { atomicWrite } from './transactions.js'

const json = value => `${JSON.stringify(value, null, 2)}\n`
const fail = code => { throw new MemoryError(code) }
const clone = value => JSON.parse(JSON.stringify(value))
const selfPath = /^(?:stability\.json|manifest\.json|evidence\/[A-Za-z0-9._-]+\.json|(?:traits|proposals)\/[A-Za-z0-9._-]+\.json|history\/[A-Za-z0-9._-]+\/[1-9][0-9]*\.json)$/
const dataPath = /^(?:assets\/[A-Za-z0-9._-]+|(?:cold|quarantine|external-changes)\/[A-Za-z0-9._/-]+)$/

/** The repair worker receives the current contract, never a list of old-version migrations. */
export function getMemoryRebuildSpec() {
  const source = { type: 'object', required: ['source_path'], additionalProperties: false,
    properties: { source_path: { type: 'string', description: 'Existing file path relative to the original memory root.' } } }
  return { apiVersion: API_VERSION, storageFormat: FORMAT_VERSION, recordSchema: RECORD_SCHEMA_VERSION,
    snapshotSchema: { type: 'object', additionalProperties: false, properties: {
      records: { type: 'array', items: { type: 'object', required: ['meta', 'gist', 'detail', 'evidence'], additionalProperties: false,
        properties: { meta: { type: 'object' }, gist: { anyOf: [{ type: 'string' }, source] }, detail: { anyOf: [{ type: 'string' }, source] },
          evidence: { type: 'array', items: { type: 'object' } }, history: { type: 'array', items: { type: 'object' } } } } },
      personas: { type: 'array', items: { type: 'object', required: ['anchor'], properties: { anchor: { type: 'object' },
        files: { type: 'array', items: { type: 'object', required: ['path'], properties: { path: { type: 'string' }, source_path: { type: 'string' }, data: { type: 'string' } } } } } } },
      files: { type: 'array', items: { type: 'object', required: ['path', 'source_path'], additionalProperties: false,
        properties: { path: { type: 'string' }, source_path: { type: 'string' } } } }, unresolvedRecords: { type: 'array', items: { type: 'object', required: ['record_id', 'reason', 'source_paths'], additionalProperties: false, properties: { record_id: { type: 'string' }, reason: { type: 'string' }, source_paths: { type: 'array', items: { type: 'string' } } } } }, purgeState: { type: 'object' }, sessionBindings: { type: 'object' }, sourceProtection: { type: 'object' },
    } },
    hostEnvelope: 'For a root with multiple spaces the host requires {spaces:[{memorySpaceId,snapshot}]}, then rebuilds the first space and appends each remaining space without replacing any existing space.',
    recordMetaTemplate: { schema_version: RECORD_SCHEMA_VERSION, record_id: 'PRESERVE_SOURCE_ID', revision_id: 'PRESERVE_SOURCE_REVISION_ID', revision: 1,
      memory_space_id: 'owner', subject_id: 'COPY_SOURCE_OR_DEFAULT_IDENTITY', actor_ids: [], persona_id: 'COPY_SOURCE_OR_DEFAULT_IDENTITY',
      agent_identity_id: 'COPY_SOURCE_OR_DEFAULT_IDENTITY', created_at: 'COPY_SOURCE_ISO_TIMESTAMP', observed_at: 'COPY_SOURCE_ISO_TIMESTAMP', updated_at: 'COPY_SOURCE_ISO_TIMESTAMP',
      valid_from: null, valid_to: null, expires_at: null, retention: 'long_term', claim_kind: 'legacy', confidence: 0,
      title: 'SOURCE_TITLE', type: 'fact', tags: [], canonical_key: null, provenance_refs: ['source-evidence-id'], visibility: { kind: 'private' },
      pinned: false, status: 'active', supersedes: null, revision_history: [], layers: { gist: true, detail: true, raw: true } },
    evidenceTemplate: { evidence_id: 'PRESERVE_SOURCE_EVIDENCE_ID', subject_ids: ['COPY_RECORD_SUBJECT'], actor_ids: [],
      observed_at: 'COPY_SOURCE_ISO_TIMESTAMP', claim_kind: 'legacy', session_id: null, message_id: null, content: 'SOURCE_TEXT' },
    fields: { types: [...MEMORY_TYPES], claimKinds: [...CLAIM_KINDS],
      history: 'Supply every prior revision with its original meta/gist/detail/evidence, in the same record ID. Current supersedes points to the immediately previous revision ID.',
      evidence: 'Each evidence_id must match meta.provenance_refs exactly. Preserve original content, source, timestamps and subject/actor attribution. Do not invent missing facts.',
      personas: 'Preserve every existing individual anchor, qualification credentials, revoked IDs and growth source files. Use host-provided defaultPersona only when no identity exists.',
      fileReferences: 'Binary data is copied by the host from source_path. File targets are assets, cold, quarantine and external-changes relative to the selected space. Persona files are relative to self/<agent ID>. Text files may use data when structural correction is needed.',
      unresolvedRecords: 'Every known record ID under entries, records or cold/records must appear in records or unresolvedRecords, unless already purged. For an unrecoverable item supply {record_id,reason,source_paths}; the host preserves the raw files under quarantine/repair-fragments/<id>/ and stores the reason only in report.json. This creates no memory prose or replacement fact.',
      continuity: 'Valid source session bindings and source-protection metadata are retained automatically. Supply sessionBindings or sourceProtection only to repair a damaged current structure; preserve root_id and existing session ownership. purgeState retains deletions and must not resurrect discarded memory.',
      derived: 'Do not write manifests, indexes, integrity files, heads, lock files or operation receipts. The host rebuilds derived storage metadata. Existing persona maturity is reconstructed from its preserved credentials.',
      prose: 'Memory prose contains only original memory content. Repair instructions, diagnostics and repair receipts belong outside the memory content.',
    } }
}

/** Materialize a host-authorized, current-format snapshot in an empty staging root. */
export async function rebuildMemorySnapshot({ root, sourceRoot, memorySpaceId = 'owner', snapshot = {}, operationId = `memory-rebuild-${randomUUID()}`, appendSpace = false } = {}) {
  root = resolve(root); sourceRoot = resolve(sourceRoot); assertId(memorySpaceId); assertId(operationId)
  if ([relative(sourceRoot, root), relative(root, sourceRoot)].some(path => path === '' || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))) fail('REBUILD_ROOTS_MUST_BE_SEPARATE')
  if (typeof appendSpace !== 'boolean') fail('INVALID_REBUILD_APPEND_OPTION')
  if (appendSpace) {
    if (!existsSync(root) || inspectMemoryRoot(root, memorySpaceId).kind !== 'new-space') fail('REBUILD_SPACE_ALREADY_EXISTS')
  } else if (existsSync(root) && readdirSync(root).length) fail('REBUILD_TARGET_NOT_EMPTY')
  assertOnly(snapshot, ['records', 'personas', 'files', 'unresolvedRecords', 'purgeState', 'sessionBindings', 'sourceProtection'])
  const records = snapshot.records ?? [], personas = snapshot.personas ?? [], files = snapshot.files ?? [], unresolved = snapshot.unresolvedRecords ?? []
  if (![records, personas, files, unresolved].every(Array.isArray)) fail('INVALID_REBUILD_SNAPSHOT')
  const knownRecords = new Map()
  for (const base of ['entries', `spaces/${memorySpaceId}/records`, `spaces/${memorySpaceId}/cold/records`]) {
    const folder = join(sourceRoot, base)
    if (!existsSync(folder)) continue
    for (const entry of readdirSync(folder, { withFileTypes: true })) if (entry.isDirectory()) knownRecords.set(entry.name, [...(knownRecords.get(entry.name) ?? []), `${base}/${entry.name}`])
  }
  const expectedIdentityIds = new Set()
  try { const value = JSON.parse(readFileSync(join(sourceRoot, '.administration/persona-ledger.json'), 'utf8')); for (const anchor of Object.values(value.spaces?.[memorySpaceId] ?? {})) if (typeof anchor.agent_identity_id === 'string') expectedIdentityIds.add(anchor.agent_identity_id) } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
  const selfDirectory = join(sourceRoot, 'spaces', memorySpaceId, 'self')
  if (existsSync(selfDirectory)) for (const entry of readdirSync(selfDirectory, { withFileTypes: true })) if (entry.isDirectory()) expectedIdentityIds.add(entry.name)
  const identityIds = new Set(personas.map(item => item.anchor?.agent_identity_id))
  if ([...expectedIdentityIds].some(id => !identityIds.has(id)) || identityIds.size !== personas.length) fail('REBUILD_IDENTITY_REQUIRED')
  let sourceBytes = 0
  const sourceData = reference => {
    if (typeof reference !== 'string' || !reference || isAbsolute(reference) || reference.includes('\\') || reference.split('/').some(part => !part || part === '..' || part === '.')) fail('UNSAFE_REBUILD_SOURCE')
    let path = sourceRoot
    if (lstatSync(path).isSymbolicLink()) fail('UNSAFE_REBUILD_SOURCE')
    for (const part of reference.split('/')) { path = join(path, part); if (lstatSync(path).isSymbolicLink()) fail('UNSAFE_REBUILD_SOURCE') }
    if (!lstatSync(path).isFile()) fail('INVALID_REBUILD_SOURCE')
    const bytes = readFileSync(path); sourceBytes += bytes.length
    if (sourceBytes > 256 * 1024 * 1024) fail('REBUILD_LIMIT_EXCEEDED')
    return bytes
  }
  const sourceFiles = reference => {
    if (typeof reference !== 'string' || !reference || isAbsolute(reference) || reference.includes('\\') || reference.split('/').some(part => !part || part === '..' || part === '.')) fail('UNSAFE_REBUILD_SOURCE')
    const path = join(sourceRoot, reference), stat = lstatSync(path)
    if (stat.isSymbolicLink()) fail('UNSAFE_REBUILD_SOURCE')
    if (stat.isFile()) return [reference]
    if (!stat.isDirectory()) fail('INVALID_REBUILD_SOURCE')
    return readdirSync(path).flatMap(name => sourceFiles(`${reference}/${name}`))
  }
  const text = value => {
    if (typeof value === 'string') return value
    assertOnly(value, ['source_path'])
    try { return new TextDecoder('utf-8', { fatal: true }).decode(sourceData(value.source_path)) } catch (error) { if (error instanceof MemoryError) throw error; fail('INVALID_REBUILD_TEXT') }
  }
  const changes = new Map(), current = [], recordIds = new Set()
  const add = (path, data) => {
    if (changes.has(path) && digest(changes.get(path)) !== digest(data)) fail('REBUILD_FILE_CONFLICT')
    changes.set(path, data)
  }
  const store = await new MemoryStoreV2({ root, memory_space_id: memorySpaceId }).initialize()
  for (const input of records) {
    assertOnly(input, ['meta', 'gist', 'detail', 'evidence', 'history'])
    const meta = clone(input.meta); validateRecord(meta)
    if (meta.memory_space_id !== memorySpaceId || recordIds.has(meta.record_id)) fail('REBUILD_RECORD_SCOPE_CONFLICT')
    recordIds.add(meta.record_id)
    const history = input.history ?? []
    if (!Array.isArray(history)) fail('INVALID_REBUILD_HISTORY')
    const base = `${meta.lifecycle?.tier === 'cold' ? 'cold/' : ''}records/${meta.record_id}`
    const materialize = entry => {
      const record = { meta: clone(entry.meta), gist: text(entry.gist), detail: text(entry.detail), evidence: clone(entry.evidence) }
      validateRecord(record.meta)
      if (!Array.isArray(record.evidence) || record.meta.record_id !== meta.record_id || record.meta.memory_space_id !== memorySpaceId) fail('REBUILD_RECORD_SCOPE_CONFLICT')
      const bundle = store._recordFiles(record)
      for (const [file, data] of Object.entries(bundle)) add(`${base}/revisions/${record.meta.revision_id}/${file}`, data)
      for (const item of record.evidence) add(`evidence/${assertId(item.evidence_id)}.json`, json(item))
      return { record, bundle }
    }
    for (const item of history) { assertOnly(item, ['meta', 'gist', 'detail', 'evidence']); materialize(item) }
    const built = materialize(input)
    for (const [file, data] of Object.entries(built.bundle)) add(`${base}/${file}`, data)
    current.push(built.record.meta)
  }
  for (const input of files) {
    assertOnly(input, ['path', 'source_path'])
    if (typeof input.path !== 'string' || !dataPath.test(input.path) || input.path.split('/').some(part => !part || part === '.' || part === '..') || /^cold\/records\//.test(input.path)) fail('UNSUPPORTED_REBUILD_TARGET')
    add(input.path, sourceData(input.source_path))
  }
  for (const input of personas) {
    assertOnly(input, ['anchor', 'files'])
    const id = assertId(input.anchor.agent_identity_id)
    for (const file of input.files ?? []) {
      assertOnly(file, ['path', 'source_path', 'data'])
      if (!selfPath.test(file.path) || (file.source_path === undefined) === (file.data === undefined)) fail('UNSUPPORTED_REBUILD_TARGET')
      // This projection is regenerated from the imported persona anchor.
      if (file.path === 'stability.json') continue
      add(`self/${id}/${file.path}`, file.source_path === undefined ? text(file.data) : sourceData(file.source_path))
    }
  }
  const portableAnchors = personas.map(({ anchor }) => { const value = clone(anchor); delete value.management_resets; return value })
  const portablePersona = { schema_version: Math.max(1, ...portableAnchors.map(anchor => anchor.schema_version)), anchors: portableAnchors }
  let purgeState = snapshot.purgeState
  let originalPurge
  try { originalPurge = exportPurgeState(sourceRoot, memorySpaceId) } catch (error) { if (purgeState === undefined) throw error }
  if (purgeState === undefined) purgeState = originalPurge
  else if (originalPurge) for (const key of ['record_ids', 'evidence_ids', 'related_evidence_ids', 'asset_files']) if (originalPurge[key].some(id => !purgeState[key]?.includes(id))) fail('REBUILD_PURGE_STATE_REQUIRED')
  const unresolvedIds = new Set()
  let unresolvedCount = 0
  for (const item of unresolved) {
    assertOnly(item, ['record_id', 'reason', 'source_paths'])
    if (typeof item.record_id !== 'string' || !item.record_id || unresolvedIds.has(item.record_id) || recordIds.has(item.record_id) || typeof item.reason !== 'string' || !item.reason.trim() || !Array.isArray(item.source_paths)) fail('INVALID_UNRESOLVED_RECORD')
    unresolvedIds.add(item.record_id)
    if (purgeState.record_ids.includes(item.record_id)) continue
    const sources = [...new Set([...(knownRecords.get(item.record_id) ?? []), ...item.source_paths].flatMap(sourceFiles))].sort()
    if (!sources.length) fail('UNRESOLVED_RECORD_SOURCE_REQUIRED')
    const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item.record_id) ? item.record_id : `fragment-${digest(item.record_id).slice(0, 40)}`
    const base = `quarantine/repair-fragments/${safeId}`, preserved = []
    for (const source_path of sources) {
      const data = sourceData(source_path), name = basename(source_path).replace(/[^A-Za-z0-9._-]/g, '_')
      const path = `${base}/source/${digest(source_path).slice(0, 20)}-${name}`
      add(path, data); preserved.push({ source_path, path, sha256: digest(data), bytes: data.length })
    }
    add(`${base}/report.json`, json({ schema_version: 1, record_id: item.record_id, reason: item.reason, files: preserved })); unresolvedCount++
  }
  if ([...knownRecords.keys()].some(id => !recordIds.has(id) && !unresolvedIds.has(id) && !purgeState.record_ids.includes(id))) fail('REBUILD_RECORD_COVERAGE_REQUIRED')
  const ctx = store.issueContext({ persona_id: 'memory-repair', agent_identity_id: 'memory-repair', subject_id: 'memory-repair', capabilities: ['memory.manage'] })
  await store.managedTransaction(operationId, { action: 'rebuildCurrentMemory', source_snapshot: digest(snapshot) }, async ({ manifest }) => {
    const persona = await preparePersonaImport(root, memorySpaceId, operationId, portablePersona)
    const purge = preparePurgeImport(root, memorySpaceId, operationId, purgeState)
    if (current.some(meta => purge.state.record_ids.includes(meta.record_id) || referencesPurged(meta, purge.state))) fail('REBUILD_REVOKED_RECORD')
    for (const file of changes.keys()) if (/^evidence\/(.+)\.json$/.test(file) && [...purge.state.evidence_ids, ...purge.state.related_evidence_ids].includes(file.slice(9, -5))) fail('REBUILD_REVOKED_EVIDENCE')
    assertPersonaFilesAllowed([...changes].map(([path, data]) => ({ path, data: Buffer.isBuffer(data) ? data : Buffer.from(data) })), persona.anchors)
    const watermark = Math.max(manifest.revision_watermark, purge.state.revision_floor, ...current.map(meta => meta.revision)) + 1
    add('manifest.json', json({ ...manifest, revision_watermark: watermark, purge_generation: purge.state.generation,
      identities: Object.fromEntries(persona.anchors.map(anchor => [anchor.agent_identity_id, personaIdentityProjection(anchor)])) }))
    add('index/records.json', json(store._index(current, watermark)))
    return { changes: [...changes].map(([path, data]) => ({ path, data })), persona_descriptors: persona.descriptors,
      ...(purge.descriptor ? { purge_descriptor: purge.descriptor } : {}), result: { status: 'rebuilt' } }
  }, ctx)
  const preserveAdministration = (name, supplied, validate) => {
    const path = join(sourceRoot, '.administration', name)
    const target = join(root, '.administration', name)
    if (appendSpace && supplied === undefined && existsSync(target)) {
      if (name === 'session-bindings.json') validate(root)
      else validate(JSON.parse(readFileSync(target, 'utf8')))
      return
    }
    let bytes = supplied === undefined ? null : Buffer.from(json(supplied))
    if (!bytes && existsSync(path)) bytes = sourceData(`.administration/${name}`)
    if (bytes) {
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      if (name === 'source-protection.json') validate(value)
      atomicWrite(join(root, '.administration', name), bytes)
      if (name === 'session-bindings.json') validate(root)
    }
  }
  preserveAdministration('session-bindings.json', snapshot.sessionBindings, readSessionBindings)
  preserveAdministration('source-protection.json', snapshot.sourceProtection, validateSourceProtection)
  repairSourceProtectionMarker(root, atomicWrite)
  for (const id of recordIds) store._readRecord(id)
  for (const id of identityIds) verifySelfIntegrity(root, memorySpaceId, id)
  const verified = await new MemoryTransfer({ store, maxFiles: 20_000, maxBytes: 256 * 1024 * 1024, maxFileBytes: 128 * 1024 * 1024 }).exportSpace({ opaque_policy: 'include_reviewed' }, ctx)
  if (verified.status !== 'ok') fail(verified.reason_code ?? 'REBUILD_VALIDATION_FAILED')
  return { status: 'rebuilt', recordCount: records.length, personaCount: personas.length, unresolvedCount, recordIds: [...recordIds], identities: [...identityIds] }
}
