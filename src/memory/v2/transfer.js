import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { API_VERSION, CLAIM_KINDS, FORMAT_VERSION, MEMORY_TYPES, MemoryError, assertId, assertOnly, digest, failure, stableStringify, timestamp, validateRecord } from './contracts.js'
import { readJson } from './transactions.js'
import { exportPurgeState, getPurgeState, preparePurgeImport } from './purge-ledger.js'

const TRANSFER_FORMAT = 'dsh-memory-space'
const TRANSFER_VERSION = 1
const DATA_FILES = ['meta.json', 'gist.md', 'detail.md', 'evidence.jsonl', 'integrity.json']
const ROOTS = ['records', 'evidence', 'candidates', 'self', 'assets', 'cold', 'quarantine', 'external-changes']
const LEGACY_ROOTS = ['entries', 'cold', 'quarantine', 'assets', 'dreams', 'backups', 'external-changes']
const json = (value) => `${JSON.stringify(value, null, 2)}\n`
const copy = (value) => JSON.parse(JSON.stringify(value))
const idPattern = '[A-Za-z0-9][A-Za-z0-9._-]{0,127}'
const recordPath = new RegExp(`^records/(${idPattern})(?:/revisions/(${idPattern}))?/(${DATA_FILES.map((name) => name.replace('.', '\\.')).join('|')})$`)
const assetMetadataPath = /(?:^|\/)assets\/(?:[a-f0-9]{64}|a-[a-f0-9]{20})\.json$/
const assetMetadataFields = ['schema_version', 'id', 'file', 'mime', 'bytes', 'description', 'tags', 'source', 'created_at', 'updated_at', 'uses', 'last_used_at']
const legacyMetaFields = new Set(['schema_version', 'id', 'type', 'title', 'summary', 'tags', 'entities', 'links', 'emotional_weight', 'salience', 'confidence', 'pinned', 'status', 'source', 'user_edited', 'created_at', 'updated_at', 'last_access', 'access_count', 'valid_from', 'valid_to', 'supersedes', 'superseded_by', 'canonical_key', 'layers', 'assets', 'archived_at', 'archive_reason', 'subject_id', 'memory_space_id', 'agent_identity_id', 'persona_id'])

function safePath(path) {
  if (typeof path !== 'string' || !path || path.length > 512 || isAbsolute(path) || path.includes('\\') || path.includes(':') || path.split('/').some((part) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) || part === '.' || part === '..')) throw new MemoryError('UNSAFE_TRANSFER_PATH')
  return path
}

function allowedPath(path) {
  safePath(path)
  if (recordPath.test(path)) return true
  if (new RegExp(`^evidence/${idPattern}\\.json$`).test(path)) return true
  if (new RegExp(`^candidates/${idPattern}\\.json$`).test(path)) return true
  if (/^assets\/(?:[a-f0-9]{64}\.(?:png|jpe?g|webp|gif|json)|a-[a-f0-9]{20}\.json)$/.test(path)) return true
  if (new RegExp(`^self/${idPattern}/(?:manifest\\.json|stability\\.json|(?:traits|proposals)/${idPattern}\\.json|history/${idPattern}/[1-9][0-9]*\\.json)$`).test(path)) return true
  return /^(?:cold|quarantine|external-changes)\//.test(path)
}

function parseJson(data, code = 'INVALID_TRANSFER_JSON') {
  try { return JSON.parse(data.toString('utf8')) } catch { throw new MemoryError(code) }
}

function walk(root, base, limits, output = []) {
  const absolute = join(root, base)
  if (!existsSync(absolute)) return output
  const stat = lstatSync(absolute)
  if (stat.isSymbolicLink()) throw new MemoryError('UNSAFE_TRANSFER_SYMLINK')
  if (stat.isDirectory()) {
    for (const entry of readdirSync(absolute).sort()) walk(root, base ? `${base}/${entry}` : entry, limits, output)
  } else if (stat.isFile()) {
    safePath(base)
    if (stat.size > limits.maxFileBytes) throw new MemoryError('TRANSFER_FILE_TOO_LARGE')
    const data = readFileSync(absolute)
    output.push({ path: base, data, size: data.length, sha256: digest(data) })
    if (output.length > limits.maxFiles || output.reduce((total, file) => total + file.size, 0) > limits.maxBytes) throw new MemoryError('TRANSFER_LIMIT_EXCEEDED')
  } else throw new MemoryError('UNSUPPORTED_TRANSFER_FILE')
  return output
}

function packageFiles(files) {
  return files.map(({ path, data }) => ({ path, encoding: 'base64', size: data.length, sha256: digest(data), data: data.toString('base64') })).sort((a, b) => a.path.localeCompare(b.path))
}

function sanitizedMetadata(files) {
  const redactions = []
  const cleaned = files.map((file) => {
    if (!assetMetadataPath.test(file.path)) return file
    let value
    try { value = parseJson(file.data) } catch { return file }
    if (value.schema_version !== 1) throw new MemoryError('UNSUPPORTED_TRANSFER_ASSET_SCHEMA')
    const next = Object.fromEntries(assetMetadataFields.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]))
    if (typeof next.file !== 'string' || !/^[a-f0-9]{64}\.(?:png|jpe?g|webp|gif)$/.test(next.file)) throw new MemoryError('INVALID_TRANSFER_ASSET_REFERENCE')
    const safeSources = ['chat-attachment', 'user-file', 'user-url', 'file', 'synthetic', 'legacy-local-file', 'legacy-remote-url', 'legacy-unknown']
    if (!safeSources.includes(next.source)) {
      const source = typeof next.source === 'string' ? next.source : ''
      next.source = /^(?:https?:)?\/\//i.test(source) ? 'legacy-remote-url' : /^(?:[A-Za-z]:[\\/]|[\\/]|~[\\/])/.test(source) ? 'legacy-local-file' : 'legacy-unknown'
    }
    if (stableStringify(next) === stableStringify(value)) return file
    redactions.push({ path: file.path, reason_code: 'ASSET_SOURCE_METADATA_REDACTED', fields: Object.keys(value).filter((key) => !assetMetadataFields.includes(key) || stableStringify(value[key]) !== stableStringify(next[key])) })
    const data = Buffer.from(json(next))
    return { ...file, data, size: data.length, sha256: digest(data) }
  })
  return { files: cleaned, redactions }
}

function opaqueFile(file) {
  if (/^(?:quarantine|external-changes)\//.test(file.path)) return true
  if (assetMetadataPath.test(file.path)) {
    try { const value = parseJson(file.data); return value.schema_version !== 1 || typeof value.file !== 'string' || !/^[a-f0-9]{64}\.(?:png|jpe?g|webp|gif)$/.test(value.file) } catch { return true }
  }
  if (!file.path.startsWith('cold/')) return false
  const path = file.path.replace(/^cold\/legacy-v1\//, '')
  if (/^(?:entries|cold)\/[^/]+\/(?:gist\.md|detail\.md|raw\.jsonl)$/.test(path) || /^dreams\/\d{4}-\d{2}-\d{2}\.md$/.test(path) || /^assets\/[a-f0-9]{64}\.(?:png|jpe?g|webp|gif)$/.test(path)) return false
  if (/^entries\/[^/]+\/meta\.json$/.test(path)) {
    try {
      const meta = parseJson(file.data)
      return Object.keys(meta).some((key) => !legacyMetaFields.has(key)) || ![undefined, 'user', 'agent', 'import', 'inferred'].includes(meta.source)
    } catch { return true }
  }
  if (path === 'state.json') {
    try {
      const state = parseJson(file.data)
      return state.last_error !== null || Object.keys(state).some((key) => !['schema_version', 'created_at', 'last_maintained_at', 'last_dream_at', 'writes_since_maintenance', 'total_writes', 'last_error'].includes(key))
    } catch { return true }
  }
  return true
}

function exportPolicy(opaqueHandling, omittedFiles = [], redactions = []) {
  return { opaque_handling: opaqueHandling, omitted_files: omittedFiles, metadata_redactions: redactions, historical_content: 'not_semantically_redacted' }
}

export function validateTransferPurgeState(state, generation) {
  assertOnly(state, ['schema_version', 'generation', 'revision_floor', 'record_ids', 'evidence_ids', 'related_evidence_ids', 'asset_files', 'clear_legacy_narratives'])
  if (state.schema_version !== 1) throw new MemoryError('UNSUPPORTED_TRANSFER_PURGE_SCHEMA')
  if (!Number.isSafeInteger(state.generation) || state.generation < 0 || state.generation !== generation || !Number.isSafeInteger(state.revision_floor) || state.revision_floor < 0 || typeof state.clear_legacy_narratives !== 'boolean') throw new MemoryError('INVALID_TRANSFER_PURGE_STATE')
  for (const key of ['record_ids', 'evidence_ids', 'related_evidence_ids', 'asset_files']) {
    if (!Array.isArray(state[key]) || state[key].length > 100_000 || new Set(state[key]).size !== state[key].length) throw new MemoryError('INVALID_TRANSFER_PURGE_STATE')
    for (const value of state[key]) {
      if (key === 'asset_files') {
        if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(value)) throw new MemoryError('INVALID_TRANSFER_PURGE_STATE')
      } else assertId(value, key)
    }
  }
  if (state.generation === 0 && (state.revision_floor !== 0 || state.clear_legacy_narratives || ['record_ids', 'evidence_ids', 'related_evidence_ids', 'asset_files'].some((key) => state[key].length))) throw new MemoryError('INVALID_TRANSFER_PURGE_STATE')
  return state
}

function packageArchive(store, manifest, files, policy = exportPolicy('none'), purgeState) {
  const archive = {
    transfer_format: TRANSFER_FORMAT, transfer_version: TRANSFER_VERSION, storage_format_version: FORMAT_VERSION,
    memory_space_id: store.memorySpaceId, revision_watermark: manifest.revision_watermark,
    purge_generation: manifest.purge_generation ?? 0,
    ...(purgeState ? { purge_state: copy(purgeState) } : {}),
    manifest: { created_at: manifest.created_at, identities: copy(manifest.identities ?? {}), migrations: copy(manifest.migrations ?? []), export_policy: policy },
    files: packageFiles(files),
  }
  return { ...archive, checksum: digest(archive) }
}

function validateFiles(files, spaceId) {
  const map = new Map(files.map((file) => [file.path, file]))
  const records = []
  for (const file of files) {
    if (!allowedPath(file.path)) throw new MemoryError('UNSUPPORTED_TRANSFER_PATH')
    if (assetMetadataPath.test(file.path) && !opaqueFile(file)) {
      if (sanitizedMetadata([file]).redactions.length) throw new MemoryError('UNSANITIZED_TRANSFER_METADATA')
      const value = parseJson(file.data), base = file.path.slice(0, file.path.lastIndexOf('/') + 1)
      if (!map.has(base + value.file)) throw new MemoryError('TRANSFER_MISSING_ASSET')
    } else if (assetMetadataPath.test(file.path) && file.path.startsWith('assets/')) throw new MemoryError('INVALID_TRANSFER_ASSET_METADATA')
    const match = recordPath.exec(file.path)
    if (match) {
      const base = file.path.slice(0, -match[3].length)
      if (!map.has(`${base}meta.json`) || !map.has(`records/${match[1]}/meta.json`)) throw new MemoryError('TRANSFER_ORPHAN_LAYER')
    }
    if (match && match[3] === 'meta.json') {
      const meta = validateRecord(parseJson(file.data))
      if (meta.record_id !== match[1] || (match[2] && meta.revision_id !== match[2]) || meta.memory_space_id !== spaceId) throw new MemoryError('TRANSFER_SCOPE_MISMATCH')
      if (!map.has(`records/${meta.record_id}/revisions/${meta.revision_id}/meta.json`)) throw new MemoryError('TRANSFER_MISSING_REVISION')
      for (const previous of meta.revision_history ?? []) {
        assertId(previous.revision_id, 'revision_id')
        if (!map.has(`records/${meta.record_id}/revisions/${previous.revision_id}/meta.json`)) throw new MemoryError('TRANSFER_MISSING_REVISION')
      }
      const base = file.path.slice(0, -'meta.json'.length)
      const integrityFile = map.get(`${base}integrity.json`)
      if (!integrityFile) throw new MemoryError('TRANSFER_MISSING_LAYER')
      const integrity = parseJson(integrityFile.data)
      if (integrity.revision_id !== meta.revision_id) throw new MemoryError('TRANSFER_INTEGRITY_MISMATCH')
      for (const name of DATA_FILES.filter((name) => name !== 'integrity.json')) {
        const layer = map.get(base + name)
        if (!layer || integrity.files?.[name] !== digest(layer.data)) throw new MemoryError('TRANSFER_INTEGRITY_MISMATCH')
      }
      const evidence = map.get(base + 'evidence.jsonl').data.toString('utf8').split('\n').filter(Boolean).map((line) => parseJson(Buffer.from(line)))
      for (const ref of meta.provenance_refs) {
        const item = map.get(`evidence/${ref}.json`)
        if (!item) throw new MemoryError('TRANSFER_MISSING_EVIDENCE')
        const source = parseJson(item.data)
        if (source.evidence_id !== ref || !evidence.some((value) => value.evidence_id === ref && stableStringify(value) === stableStringify(source))) throw new MemoryError('TRANSFER_EVIDENCE_MISMATCH')
      }
      if (!match[2]) records.push(meta)
    }
    if (/^evidence\/.+\.json$/.test(file.path)) {
      const value = parseJson(file.data)
      if (file.path !== `evidence/${assertId(value.evidence_id)}.json` || !CLAIM_KINDS.includes(value.claim_kind) || !Array.isArray(value.subject_ids) || !value.subject_ids.length || typeof value.content !== 'string') throw new MemoryError('INVALID_TRANSFER_EVIDENCE')
      value.subject_ids.forEach((id) => assertId(id))
      if (!Array.isArray(value.actor_ids)) throw new MemoryError('INVALID_TRANSFER_EVIDENCE')
      value.actor_ids.forEach((id) => assertId(id))
      timestamp(value.observed_at, 'evidence observed_at', false)
      if (value.claim_kind !== 'legacy') { assertId(value.session_id); assertId(value.message_id) }
      else if (value.session_id !== null || value.message_id !== null) throw new MemoryError('FABRICATED_LEGACY_SOURCE')
    }
    if (/^(?:self|candidates)\/.+\.json$/.test(file.path)) {
      const value = parseJson(file.data)
      if (value.schema_version !== 1) throw new MemoryError('UNSUPPORTED_TRANSFER_SCHEMA')
      const identity = /^self\/([^/]+)\//.exec(file.path)?.[1]
      if (identity && value.agent_identity_id !== identity) throw new MemoryError('TRANSFER_SELF_IDENTITY_MISMATCH')
      if (identity && typeof value.persona_id !== 'string') throw new MemoryError('TRANSFER_SELF_IDENTITY_MISMATCH')
      if (/^self\/[^/]+\/manifest\.json$/.test(file.path)) {
        for (const kind of ['traits', 'proposals']) {
          if (!value[kind] || typeof value[kind] !== 'object' || Array.isArray(value[kind])) throw new MemoryError('INVALID_TRANSFER_SELF_MANIFEST')
          for (const [id, hash] of Object.entries(value[kind])) {
            assertId(id)
            const entry = map.get(`self/${identity}/${kind}/${id}.json`)
            if (!entry || digest(parseJson(entry.data)) !== hash) throw new MemoryError('TRANSFER_SELF_INTEGRITY_MISMATCH')
          }
        }
      }
    }
    if (/^assets\/[a-f0-9]{64}\.(?:png|jpe?g|webp|gif)$/.test(file.path) && file.sha256 !== file.path.split('/')[1].split('.')[0]) throw new MemoryError('TRANSFER_ASSET_HASH_MISMATCH')
  }
  return records
}

export function validateTransferArchive(archive, { maxFiles = 10_000, maxBytes = 64 * 1024 * 1024, maxFileBytes = 8 * 1024 * 1024 } = {}) {
  assertOnly(archive, ['transfer_format', 'transfer_version', 'storage_format_version', 'memory_space_id', 'revision_watermark', 'purge_generation', 'purge_state', 'manifest', 'files', 'checksum'])
  if (archive.transfer_format !== TRANSFER_FORMAT || archive.transfer_version !== TRANSFER_VERSION || archive.storage_format_version !== FORMAT_VERSION) throw new MemoryError('UNSUPPORTED_TRANSFER_FORMAT')
  assertId(archive.memory_space_id, 'memory_space_id')
  if (!Number.isSafeInteger(archive.revision_watermark) || archive.revision_watermark < 0 || !Number.isSafeInteger(archive.purge_generation) || archive.purge_generation < 0) throw new MemoryError('INVALID_TRANSFER_WATERMARK')
  if (archive.purge_state !== undefined) {
    validateTransferPurgeState(archive.purge_state, archive.purge_generation)
    if (archive.revision_watermark < archive.purge_state.revision_floor) throw new MemoryError('INVALID_TRANSFER_PURGE_STATE')
  }
  else if (archive.purge_generation !== 0) throw new MemoryError('MISSING_TRANSFER_PURGE_STATE')
  assertOnly(archive.manifest, ['created_at', 'identities', 'migrations', 'export_policy'])
  timestamp(archive.manifest.created_at, 'manifest created_at', false)
  if (!archive.manifest.identities || typeof archive.manifest.identities !== 'object' || Array.isArray(archive.manifest.identities) || !Array.isArray(archive.manifest.migrations)) throw new MemoryError('INVALID_TRANSFER_MANIFEST')
  const policy = archive.manifest.export_policy
  if (policy !== undefined) {
    assertOnly(policy, ['opaque_handling', 'omitted_files', 'metadata_redactions', 'historical_content'])
    if (!['none', 'omitted', 'reviewed', 'preserved_local'].includes(policy.opaque_handling) || !Array.isArray(policy.omitted_files) || !Array.isArray(policy.metadata_redactions) || policy.historical_content !== 'not_semantically_redacted') throw new MemoryError('INVALID_TRANSFER_POLICY')
    policy.omitted_files.forEach(safePath)
  }
  if (!Array.isArray(archive.files) || archive.files.length > maxFiles) throw new MemoryError('TRANSFER_LIMIT_EXCEEDED')
  const paths = new Set(), files = []
  let total = 0
  for (const file of archive.files) {
    assertOnly(file, ['path', 'encoding', 'size', 'sha256', 'data'])
    if (!allowedPath(file.path)) throw new MemoryError('UNSUPPORTED_TRANSFER_PATH')
    if (paths.has(file.path)) throw new MemoryError('DUPLICATE_TRANSFER_PATH')
    paths.add(file.path)
    if (file.encoding !== 'base64' || typeof file.data !== 'string' || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > maxFileBytes || file.data.length > Math.ceil(maxFileBytes / 3) * 4 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new MemoryError('INVALID_TRANSFER_FILE')
    total += file.size
    if (total > maxBytes) throw new MemoryError('TRANSFER_LIMIT_EXCEEDED')
    const data = Buffer.from(file.data, 'base64')
    if (data.length !== file.size || data.toString('base64') !== file.data || digest(data) !== file.sha256) throw new MemoryError('TRANSFER_CHECKSUM_MISMATCH')
    files.push({ path: file.path, data, size: data.length, sha256: file.sha256 })
  }
  const { checksum, ...payload } = archive
  if (typeof checksum !== 'string' || digest(payload) !== checksum) throw new MemoryError('TRANSFER_CHECKSUM_MISMATCH')
  const records = validateFiles(files, archive.memory_space_id)
  if (files.some(opaqueFile) && !['reviewed', 'preserved_local'].includes(policy?.opaque_handling)) throw new MemoryError('OPAQUE_REVIEW_REQUIRED')
  return { files, records, bytes: total }
}

function legacySnapshot(root, limits) {
  if (lstatSync(root).isSymbolicLink() || !lstatSync(join(root, 'entries')).isDirectory()) throw new MemoryError('INVALID_LEGACY_ROOT')
  if (existsSync(join(root, 'manifest.json'))) {
    const manifest = readJson(join(root, 'manifest.json'))
    if (manifest.format_version !== undefined) throw new MemoryError('UNSUPPORTED_LEGACY_FORMAT')
  }
  const files = []
  for (const name of LEGACY_ROOTS) walk(root, name, limits, files)
  if (existsSync(join(root, 'state.json'))) walk(root, 'state.json', limits, files)
  return { files, checksum: digest(files.map(({ path, sha256, size }) => ({ path, sha256, size }))) }
}

/** Host-only transfer service. Context objects and guards never come from model arguments. */
export class MemoryTransfer {
  #store
  #limits
  #importGuard
  #beforeSourceRecheck

  constructor({ store, importGuard, beforeSourceRecheck, maxFiles = 10_000, maxBytes = 64 * 1024 * 1024, maxFileBytes = 8 * 1024 * 1024 }) {
    if (typeof store?.managedRead !== 'function' || typeof store?.managedTransaction !== 'function') throw new MemoryError('MANAGED_MEMORY_REQUIRED')
    this.#store = store
    this.#limits = { maxFiles, maxBytes, maxFileBytes }
    this.#importGuard = importGuard
    this.#beforeSourceRecheck = beforeSourceRecheck
  }

  async exportSpace(args, context) {
    try {
      assertOnly(args ?? {}, ['opaque_policy'])
      if (args?.opaque_policy !== undefined && !['omit', 'include_reviewed'].includes(args.opaque_policy)) throw new MemoryError('UNSUPPORTED_OPAQUE_POLICY')
      return await this.#store.managedRead(context, ({ manifest }) => {
        const files = []
        for (const name of ROOTS) walk(this.#store.spaceRoot, name, this.#limits, files)
        const sanitized = sanitizedMetadata(files)
        const opaque = sanitized.files.filter(opaqueFile).map((file) => file.path)
        if (opaque.length && args?.opaque_policy === undefined) return { api_version: API_VERSION, status: 'review_required', reason_code: 'OPAQUE_REVIEW_REQUIRED', opaque_files: opaque }
        const selected = args?.opaque_policy === 'omit' ? sanitized.files.filter((file) => !opaque.includes(file.path)) : sanitized.files
        const policy = exportPolicy(!opaque.length ? 'none' : args.opaque_policy === 'omit' ? 'omitted' : 'reviewed', args?.opaque_policy === 'omit' ? opaque : [], sanitized.redactions)
        const state = exportPurgeState(this.#store.root, this.#store.memorySpaceId)
        const archive = packageArchive(this.#store, manifest, selected, policy, state)
        validateTransferArchive(archive, this.#limits)
        return { api_version: API_VERSION, status: 'ok', archive, record_ids: [...new Set(files.map((file) => recordPath.exec(file.path)).filter((match) => match && !match[2] && match[3] === 'meta.json').map((match) => match[1]))] }
      })
    } catch (error) { return failure(error) }
  }

  async #guard(manifest, archive, decoded, purgeState) {
    const args = { store: this.#store, manifest, archive, files: decoded.files, record_ids: decoded.records.map((meta) => meta.record_id), purge_state: purgeState }
    if (this.#importGuard) {
      if (await this.#importGuard(args) === false) throw new MemoryError('IMPORT_GUARD_REJECTED')
      return
    }
    const ledger = readJson(join(this.#store.root, '.administration', 'purge-ledger.json'), null)
    if ((manifest.purge_generation ?? 0) > 0 || archive.purge_generation > 0 || (ledger?.spaces?.[this.#store.memorySpaceId]?.generation ?? 0) > 0) throw new MemoryError('IMPORT_GUARD_REQUIRED')
  }

  async #import(archive, operationId, context, { recheckSource } = {}) {
    const decoded = validateTransferArchive(archive, this.#limits)
    if (archive.memory_space_id !== this.#store.memorySpaceId) throw new MemoryError('TRANSFER_SPACE_MISMATCH')
    return this.#store.managedTransaction(operationId, { action: 'importSpace', checksum: archive.checksum, identity_mode: 'preserve' }, async ({ manifest, records }) => {
      const { state, descriptor } = archive.purge_state === undefined
        ? { state: getPurgeState(this.#store.root, this.#store.memorySpaceId), descriptor: null }
        : preparePurgeImport(this.#store.root, this.#store.memorySpaceId, operationId, archive.purge_state)
      await this.#guard(manifest, archive, decoded, state)
      const changes = []
      for (const file of decoded.files) {
        const target = this.#store.engine.resolvePath(file.path)
        if (existsSync(target)) {
          if (!lstatSync(target).isFile() || digest(readFileSync(target)) !== file.sha256) throw new MemoryError('IMPORT_FILE_CONFLICT')
        } else changes.push({ path: file.path, data: file.data })
      }
      for (const [id, value] of Object.entries(archive.manifest.identities)) {
        assertId(id, 'identity')
        if (manifest.identities?.[id] !== undefined && stableStringify(manifest.identities[id]) !== stableStringify(value)) throw new MemoryError('IMPORT_IDENTITY_CONFLICT')
      }
      const watermark = changes.length || descriptor ? Math.max(manifest.revision_watermark, archive.revision_watermark, state.revision_floor) + 1 : manifest.revision_watermark
      const merged = [...records.filter((meta) => !state.record_ids.includes(meta.record_id) && !decoded.records.some((item) => item.record_id === meta.record_id)), ...decoded.records]
      const importedBefore = (manifest.transfers ?? []).some((item) => item.checksum === archive.checksum)
      if (changes.length || !importedBefore || descriptor) {
        changes.push({ path: 'manifest.json', data: json({ ...manifest, revision_watermark: watermark, purge_generation: state.generation,
          identities: { ...manifest.identities, ...archive.manifest.identities },
          migrations: [...(manifest.migrations ?? []), ...archive.manifest.migrations.filter((entry) => !(manifest.migrations ?? []).some((old) => digest(old) === digest(entry)))],
          transfers: [...(manifest.transfers ?? []).filter((item) => item.checksum !== archive.checksum), { checksum: archive.checksum, identity_mode: 'preserve' }],
        }) })
        changes.push({ path: 'index/records.json', data: json(this.#store._index(merged, watermark)) })
      }
      if (recheckSource) await recheckSource()
      return { changes, ...(descriptor ? { purge_descriptor: descriptor } : {}), result: { api_version: API_VERSION, operation_id: operationId, status: changes.length ? 'committed' : 'unchanged', reason_code: 'OK', imported_files: decoded.files.length, record_ids: decoded.records.map((meta) => meta.record_id), checksum: archive.checksum, revision_watermark: watermark, purge_generation: state.generation, pending: false } }
    }, context)
  }

  async importSpace(args, context) {
    const operationId = args?.operation_id ?? randomUUID()
    try {
      this.#store._authorize(context, 'memory.manage')
      assertOnly(args, ['operation_id', 'archive', 'identity_mode', 'accept_purge_state'])
      if (args.identity_mode !== 'preserve') throw new MemoryError('EXPLICIT_IDENTITY_MODE_REQUIRED')
      if (args.accept_purge_state !== undefined && typeof args.accept_purge_state !== 'boolean') throw new MemoryError('INVALID_PURGE_STATE_ACCEPTANCE')
      if (args.archive?.purge_state !== undefined && args.accept_purge_state !== true) throw new MemoryError('PURGE_STATE_ACCEPTANCE_REQUIRED')
      return await this.#import(args.archive, operationId, context)
    } catch (error) { return failure(error, operationId) }
  }

  async migrateV1(args, context) {
    const operationId = args?.operation_id ?? randomUUID()
    try {
      this.#store._authorize(context, 'memory.manage')
      assertOnly(args, ['operation_id', 'source_root', 'source_quiescent', 'expected_snapshot', 'dry_run', 'identity', 'opaque_policy'])
      if (args.opaque_policy !== undefined && !['preserve_local', 'omit'].includes(args.opaque_policy)) throw new MemoryError('UNSUPPORTED_OPAQUE_POLICY')
      if (args.source_quiescent !== true) throw new MemoryError('SOURCE_QUIESCENCE_REQUIRED')
      if (typeof args.source_root !== 'string' || !isAbsolute(args.source_root)) throw new MemoryError('INVALID_LEGACY_ROOT')
      const source = resolve(args.source_root), destination = this.#store.root
      if ([relative(source, destination), relative(destination, source)].some((path) => path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path)))) throw new MemoryError('OVERLAPPING_MIGRATION_ROOTS')
      const snapshot = legacySnapshot(source, this.#limits)
      const identity = { subject_id: 'legacy-subject', agent_identity_id: 'legacy-agent', persona_id: 'legacy-persona', ...args.identity }
      assertOnly(identity, ['subject_id', 'agent_identity_id', 'persona_id'])
      Object.values(identity).forEach((value) => assertId(value))
      const map = new Map(snapshot.files.map((file) => [file.path, file.data]))
      const warnings = [], files = [], recordIds = []
      for (const file of snapshot.files) files.push({ ...file, path: file.path.startsWith('quarantine/') ? `quarantine/legacy-v1/${file.path.slice(11)}` : `cold/legacy-v1/${file.path}` })
      const ids = [...new Set(snapshot.files.map((file) => /^entries\/([^/]+)\//.exec(file.path)?.[1]).filter(Boolean))]
      for (const id of ids) {
        try {
          assertId(id)
          const meta = parseJson(map.get(`entries/${id}/meta.json`) ?? Buffer.alloc(0), 'INVALID_LEGACY_META')
          if (meta.schema_version !== undefined && meta.schema_version !== 1) throw new MemoryError('UNSUPPORTED_LEGACY_SCHEMA')
          const recordIdentity = Object.fromEntries(Object.keys(identity).map((key) => [key, typeof meta[key] === 'string' ? assertId(meta[key], key) : identity[key]]))
          const created = timestamp(meta.created_at, 'legacy created_at', false), updated = timestamp(meta.updated_at, 'legacy updated_at', false)
          const gist = (map.get(`entries/${id}/gist.md`)?.toString('utf8') ?? meta.summary ?? meta.title ?? id)
          const detail = map.get(`entries/${id}/detail.md`)?.toString('utf8') ?? ''
          const raw = map.get(`entries/${id}/raw.jsonl`)?.toString('utf8') ?? ''
          if (raw) try { raw.split('\n').filter(Boolean).forEach((line) => JSON.parse(line)) } catch { warnings.push({ record_id: id, reason_code: 'INVALID_LEGACY_RAW_RETAINED' }) }
          const sourceHash = digest(snapshot.files.filter((file) => file.path.startsWith(`entries/${id}/`)).map(({ path, sha256 }) => ({ path, sha256 })))
          const evidenceId = `legacy-evidence-${sourceHash.slice(0, 32)}`
          const evidence = { evidence_id: evidenceId, claim_kind: 'legacy', source: 'legacy', observed_at: created, subject_ids: [recordIdentity.subject_id], actor_ids: [], session_id: null, message_id: null,
            content: raw || 'Legacy entry without active raw; original files remain in cold/legacy-v1.',
            legacy_source: `cold/legacy-v1/entries/${id}`, legacy_format: raw ? 'raw-jsonl' : 'metadata-only' }
          const record = { meta: {
            schema_version: 2, record_id: id, revision_id: `legacy-${sourceHash.slice(0, 40)}`, revision: 1,
            memory_space_id: this.#store.memorySpaceId, ...recordIdentity, actor_ids: [], created_at: created, observed_at: created, updated_at: updated,
            valid_from: timestamp(meta.valid_from, 'legacy valid_from'), valid_to: timestamp(meta.valid_to, 'legacy valid_to'), expires_at: null, retention: 'long_term',
            claim_kind: 'legacy', confidence: typeof meta.confidence === 'number' && meta.confidence >= 0 && meta.confidence <= 1 ? meta.confidence : 0,
            title: typeof meta.title === 'string' ? meta.title.slice(0, 200) : id, type: MEMORY_TYPES.includes(meta.type) ? meta.type : 'fact',
            tags: Array.isArray(meta.tags) ? meta.tags.filter((tag) => typeof tag === 'string') : [], canonical_key: typeof meta.canonical_key === 'string' ? meta.canonical_key : null,
            provenance_refs: [evidenceId], visibility: { kind: 'private' }, pinned: meta.pinned === true,
            status: ['archived', 'superseded'].includes(meta.status) ? meta.status : meta.superseded_by ? 'superseded' : 'active', supersedes: null, revision_history: [],
            layers: { gist: map.has(`entries/${id}/gist.md`), detail: map.has(`entries/${id}/detail.md`), raw: map.has(`entries/${id}/raw.jsonl`) },
            ...(meta.user_edited === true ? { external_revision: { protected: true, source: 'legacy_user_edit' } } : {}),
            legacy: { source: typeof meta.source === 'string' ? meta.source : 'unknown', user_edited: meta.user_edited === true, supersedes: meta.supersedes ?? null, superseded_by: meta.superseded_by ?? null,
              links: Array.isArray(meta.links) ? copy(meta.links) : [], assets: Array.isArray(meta.assets) ? copy(meta.assets) : [], entities: Array.isArray(meta.entities) ? copy(meta.entities) : [],
              salience: meta.salience && typeof meta.salience === 'object' ? copy(meta.salience) : null, emotional_weight: meta.emotional_weight ?? null, access_count: meta.access_count ?? null, last_access: meta.last_access ?? null, archived_at: meta.archived_at ?? null,
              observed_time_basis: 'entry_created_at', identity_assignment: Object.fromEntries(Object.keys(identity).map((key) => [key, typeof meta[key] === 'string' ? 'preserved' : args.identity ? 'host_declared' : 'unknown_placeholder'])) },
          }, gist, detail, evidence: [evidence] }
          validateRecord(record.meta)
          files.push(...this.#store._recordChanges(record).map((change) => ({ path: change.path, data: Buffer.from(change.data) })))
          files.push({ path: `evidence/${evidenceId}.json`, data: Buffer.from(json(evidence)) })
          recordIds.push(id)
        } catch (error) {
          if (error.code === 'UNSUPPORTED_LEGACY_SCHEMA') throw error
          warnings.push({ record_id: id, reason_code: error.code ?? 'INVALID_LEGACY_ENTRY_RETAINED' })
        }
      }
      for (const file of snapshot.files.filter((file) => file.path.startsWith('assets/'))) {
        if (assetMetadataPath.test(file.path)) {
          let metadata
          try { metadata = parseJson(file.data) } catch { warnings.push({ path: file.path, reason_code: 'INVALID_LEGACY_ASSET_METADATA_RETAINED' }); continue }
          if (metadata.schema_version !== 1) throw new MemoryError('UNSUPPORTED_TRANSFER_ASSET_SCHEMA')
          if (opaqueFile(file)) { warnings.push({ path: file.path, reason_code: 'INVALID_LEGACY_ASSET_METADATA_RETAINED' }); continue }
          files.push(file)
        } else if (/^assets\/[a-f0-9]{64}\.(?:png|jpe?g|webp|gif)$/.test(file.path)) files.push(file)
        else warnings.push({ path: file.path, reason_code: 'UNKNOWN_LEGACY_ASSET_RETAINED' })
      }
      const manifest = await this.#store.managedRead(context, ({ manifest }) => manifest)
      const migration = { source_format: 1, snapshot_hash: snapshot.checksum, record_ids: recordIds, source_quiescence: 'host_declared_and_finally_rechecked' }
      let sourceState = {}
      if (map.has('state.json')) {
        try { sourceState = parseJson(map.get('state.json')) } catch { warnings.push({ path: 'state.json', reason_code: 'INVALID_LEGACY_STATE_RETAINED' }) }
        if (sourceState.schema_version !== undefined && sourceState.schema_version !== 1) throw new MemoryError('UNSUPPORTED_LEGACY_SCHEMA')
      }
      const sourceCreated = typeof sourceState.created_at === 'string' && Number.isFinite(Date.parse(sourceState.created_at)) ? timestamp(sourceState.created_at, 'source created_at', false) : manifest.created_at
      const sanitized = sanitizedMetadata(files)
      const opaque = sanitized.files.filter(opaqueFile).map((file) => file.path)
      const selected = args.opaque_policy === 'omit' ? sanitized.files.filter((file) => !opaque.includes(file.path)) : sanitized.files
      const policy = exportPolicy(!opaque.length ? 'none' : args.opaque_policy === 'omit' ? 'omitted' : 'preserved_local', args.opaque_policy === 'omit' ? opaque : [], sanitized.redactions)
      const archive = packageArchive(this.#store, { created_at: sourceCreated, revision_watermark: 0, purge_generation: 0, identities: {}, migrations: [migration] }, selected, policy)
      validateTransferArchive(archive, this.#limits)
      const summary = { api_version: API_VERSION, operation_id: operationId, status: 'ok', source_snapshot: snapshot.checksum, source_quiescence: 'host_declared', record_ids: recordIds, files: selected.length, warnings, opaque_files: opaque, metadata_redactions: sanitized.redactions }
      if (args.dry_run === true) return summary
      if (opaque.length && args.opaque_policy === undefined) throw new MemoryError('OPAQUE_REVIEW_REQUIRED')
      if (!args.expected_snapshot) throw new MemoryError('SOURCE_SNAPSHOT_REQUIRED')
      if (args.expected_snapshot !== snapshot.checksum) throw new MemoryError('SOURCE_CHANGED')
      const result = await this.#import(archive, operationId, context, { recheckSource: async () => {
        await this.#beforeSourceRecheck?.({ source_root: source, snapshot_hash: snapshot.checksum })
        if (legacySnapshot(source, this.#limits).checksum !== snapshot.checksum) throw new MemoryError('SOURCE_CHANGED')
      } })
      return { ...result, source_snapshot: snapshot.checksum, warnings }
    } catch (error) { return failure(error, operationId) }
  }
}
