import { randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from 'node:fs'
import { join, parse, resolve, sep } from 'node:path'
import { API_VERSION, MemoryError, assertId, assertOnly, digest, failure, stableStringify } from './contracts.js'
import { buildRecordDescriptor, buildRecordStateDescriptor, loadRecordHead, recordBundlePath, recordBundleHash, verifyRecordBundle } from './record-integrity.js'
import { RECORD_FILES, readBundleAt } from './integrity-transaction.js'
import { getPurgeState } from './purge-ledger.js'
import { retentionBlockReason } from './retention.js'
import { recordRetentionAllowed } from './read-policy.js'

const json = (value) => `${JSON.stringify(value, null, 2)}\n`
const clone = (value) => JSON.parse(JSON.stringify(value))
const fail = (code) => { throw new MemoryError(code) }
const allowedFields = ['title', 'tags', 'gist', 'detail']
const metadataFields = new Set(['schema_version', 'record_id', 'revision_id', 'revision', 'memory_space_id', 'subject_id', 'actor_ids', 'persona_id', 'agent_identity_id', 'created_at', 'observed_at', 'updated_at', 'valid_from', 'valid_to', 'expires_at', 'retention', 'claim_kind', 'confidence', 'title', 'type', 'tags', 'canonical_key', 'provenance_refs', 'visibility', 'pinned', 'status', 'supersedes', 'revision_history', 'layers', 'assets', 'asset_metadata_hash', 'legacy', 'external_revision', 'lifecycle'])
const bytes = (value) => Buffer.isBuffer(value) ? value : Buffer.from(value)
const decode = (value) => { try { return new TextDecoder('utf-8', { fatal: true }).decode(value) } catch { fail('INVALID_EXTERNAL_UNICODE') } }
const safeStat = (path) => { try { return lstatSync(path) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
function unsafeStructured(value, depth = 0, budget = { nodes: 0 }) {
  if (++budget.nodes > 20000 || depth > 32) return true
  if (typeof value === 'string') return !value.isWellFormed() || retentionBlockReason(value) !== null
  if (Array.isArray(value)) return value.some((item) => unsafeStructured(item, depth + 1, budget))
  if (value && typeof value === 'object') return Object.entries(value).some(([key, item]) => unsafeStructured(key, depth + 1, budget) || unsafeStructured(item, depth + 1, budget))
  return false
}
function externalFileAllowed(name, data) {
  try {
    const text = decode(data)
    if (retentionBlockReason(text)) return false
    if (name.endsWith('.json')) { try { if (unsafeStructured(JSON.parse(text))) return false } catch {} }
    if (name.endsWith('.jsonl')) for (const line of text.split('\n').filter(Boolean)) { try { if (unsafeStructured(JSON.parse(line))) return false } catch {} }
    return true
  } catch { return false }
}

/** Owner-only review backend. No method is registered as an Agent tool. */
export class MemoryExternalChanges {
  constructor({ store, maxFileBytes = 8 * 1024 * 1024, maxSnapshotBytes = 16 * 1024 * 1024 } = {}) {
    if (!store?.engine || typeof store.issueContext !== 'function') fail('MANAGED_MEMORY_REQUIRED')
    this.store = store
    let ancestor = parse(store.root).root
    for (const part of store.root.slice(ancestor.length).split(sep).filter(Boolean)) {
      ancestor = join(ancestor, part)
      const stat = safeStat(ancestor)
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) fail('UNSAFE_STORAGE_PATH')
    }
    if (![maxFileBytes, maxSnapshotBytes].every((value) => Number.isSafeInteger(value) && value > 0)) fail('INVALID_EXTERNAL_BUDGET')
    this.maxFileBytes = Math.min(maxFileBytes, 8 * 1024 * 1024)
    this.maxSnapshotBytes = Math.min(maxSnapshotBytes, 16 * 1024 * 1024)
  }

  #authorize(ctx, bootstrap = false, signal = null) {
    if (signal?.aborted) fail('OPERATION_CANCELLED')
    if (!bootstrap) return this.store._authorize(ctx, 'memory.manage')
    if (!ctx || !this.store.contexts.has(ctx)) fail('UNTRUSTED_CONTEXT')
    if (!ctx.capabilities.includes('memory.manage')) fail('CAPABILITY_DENIED')
    if (Date.parse(ctx.expires_at) <= Date.now()) fail('CONTEXT_EXPIRED')
    return ctx
  }

  #path(relativePath) { return this.store.engine.resolvePath(relativePath) }
  #read(relativePath) {
    const path = this.#path(relativePath)
    let fd
    try {
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const before = fstatSync(fd)
      if (!before.isFile() || before.nlink !== 1) fail('UNSAFE_EXTERNAL_FILE')
      if (before.size > this.maxFileBytes) fail('EXTERNAL_SNAPSHOT_BUDGET_EXCEEDED')
      const data = readFileSync(fd), after = fstatSync(fd)
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || data.length !== after.size) fail('EXTERNAL_SOURCE_UNSTABLE')
      return data
    } finally { if (fd !== undefined) closeSync(fd) }
  }

  #observe(base) {
    const stat = safeStat(this.#path(base))
    if (!stat) return { missing: true, observed_hash: digest({ missing: true }), files: {}, identity: null }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_EXTERNAL_FILE')
    const read = () => {
      const files = {}, hashes = {}; let total = 0
      for (const name of RECORD_FILES) {
        try { files[name] = this.#read(`${base}/${name}`); total += files[name].length; hashes[name] = digest(files[name]) }
        catch (error) { if (error.code === 'ENOENT') hashes[name] = null; else throw error }
      }
      if (total > this.maxSnapshotBytes) fail('EXTERNAL_SNAPSHOT_BUDGET_EXCEEDED')
      return { files, hashes, observed_hash: digest(hashes) }
    }
    const first = read(), second = read(), after = safeStat(this.#path(base))
    if (!after || after.dev !== stat.dev || after.ino !== stat.ino || first.observed_hash !== second.observed_hash) fail('EXTERNAL_SOURCE_UNSTABLE')
    const safe = Object.entries(second.files).every(([name, data]) => externalFileAllowed(name, data))
    return { ...second, identity: { dev: stat.dev, ino: stat.ino }, missing: false, snapshot_safe: safe }
  }

  #rootFile(name) {
    let current = resolve(this.store.root)
    for (const part of name.split('/')) {
      current = join(current, part)
      const st = safeStat(current)
      if (st?.isSymbolicLink()) fail('UNSAFE_STORAGE_PATH')
    }
    const st = safeStat(current)
    if (!st?.isFile() || st.nlink !== 1 || st.size > 16 * 1024 * 1024) fail('INVALID_STORAGE_JSON')
    return readFileSync(current)
  }

  #head(id) {
    const state = getPurgeState(this.store.root, this.store.memorySpaceId)
    if (state.record_ids.includes(id)) fail('PURGED_CONTENT')
    const head = loadRecordHead(this.store.root, this.store.memorySpaceId, id)
    if (!head) fail('TRUSTED_BASELINE_REQUIRED')
    if (head.state === 'purged') fail('PURGED_CONTENT')
    return head
  }

  #change(id) {
    assertId(id)
    const directory = this.#path('external-changes')
    for (const record of readdirSync(directory, { withFileTypes: true })) {
      if (!record.isDirectory() || record.isSymbolicLink()) continue
      assertId(record.name)
      const path = `external-changes/${record.name}/${id}/manifest.json`
      if (!existsSync(this.#path(path))) continue
      const entry = JSON.parse(decode(this.#read(path)))
      assertOnly(entry, ['schema_version', 'change_id', 'record_id', 'status', 'reason_code', 'change_revision', 'observed_hash', 'baseline_revision_id', 'baseline_generation', 'snapshot_safe', 'file_hashes', 'source_identity', 'created_at', 'purge_generation'])
      if (entry.schema_version !== 1 || entry.record_id !== record.name || entry.change_id !== id || entry.status !== 'review_required' || !['EXTERNAL_CHANGE', 'RECORD_MISSING'].includes(entry.reason_code) ||
        entry.change_revision !== 1 || !Number.isSafeInteger(entry.baseline_generation) || entry.baseline_generation < 1 || typeof entry.snapshot_safe !== 'boolean' ||
        !/^[a-f0-9]{64}$/.test(entry.observed_hash) || id !== `change-${digest({ id: record.name, generation: entry.baseline_generation, hash: entry.observed_hash }).slice(0, 40)}`) fail('EXTERNAL_CHANGE_INVALID')
      assertId(entry.baseline_revision_id)
      return entry
    }
    fail('EXTERNAL_CHANGE_NOT_FOUND')
  }

  #summary(entry) {
    const head = loadRecordHead(this.store.root, this.store.memorySpaceId, entry.record_id)
    let status = 'baseline_required'
    if (head?.state === 'quarantined') status = head.change_id === entry.change_id ? 'review_required' : 'superseded'
    else if (head?.state === 'clean') {
      if (head.head_revision_id === entry.baseline_revision_id) status = 'restored'
      else {
        const current = this.#candidate(head, head.head_revision_id)?.record.meta
        status = current?.external_revision?.change_id === entry.change_id ? current.external_revision.source === 'owner_external_edit' ? 'adopted' : 'restored' : 'superseded'
      }
    }
    return { change_id: entry.change_id, record_id: entry.record_id, status,
      reason_code: entry.reason_code, observed_hash: entry.observed_hash, change_revision: entry.change_revision,
      baseline_revision_id: entry.baseline_revision_id, snapshot_safe: entry.snapshot_safe }
  }

  #candidate(head, revisionId) {
    const candidates = [recordBundlePath(head, revisionId === head.head_revision_id ? null : revisionId), recordBundlePath(head, revisionId)]
    const folder = this.#path(`quarantine/${head.record_id}`)
    if (existsSync(folder)) for (const change of readdirSync(folder, { withFileTypes: true })) {
      if (!change.isDirectory() || change.isSymbolicLink()) continue
      assertId(change.name)
      candidates.push(`quarantine/${head.record_id}/${change.name}/source/revisions/${revisionId}`)
      if (revisionId === head.head_revision_id) candidates.push(`quarantine/${head.record_id}/${change.name}/source`)
    }
    for (const base of candidates) {
      try { const files = Object.fromEntries(RECORD_FILES.map((name) => [name, this.#read(`${base}/${name}`)])); return { files, record: verifyRecordBundle(head, files, revisionId) } }
      catch (error) { if (['EACCES', 'EPERM'].includes(error.code)) throw error }
    }
    return null
  }

  async establishBaseline(args, ctx, { signal = null } = {}) {
    const operationId = args?.operation_id ?? randomUUID()
    try {
      this.#authorize(ctx, true, signal)
      assertOnly(args, ['operation_id', 'dry_run', 'source_quiescent', 'expected_snapshot'])
      if (args.source_quiescent !== true) fail('SOURCE_QUIESCENCE_REQUIRED')
      const rootBytes = this.#rootFile('manifest.json'), manifest = JSON.parse(decode(rootBytes))
      if (manifest.api_version === API_VERSION && args.dry_run === false && args.expected_snapshot) {
        const path = this.#path(`operations/${digest(operationId)}.json`)
        if (existsSync(path)) {
          const receipt = JSON.parse(decode(this.#read(`operations/${digest(operationId)}.json`)))
          if (receipt.operation_id !== operationId || receipt.request_hash !== digest({ action: 'establishIntegrityBaseline', source_snapshot: args.expected_snapshot }) || receipt.result?.reason_code !== 'BASELINE_ESTABLISHED') fail('OPERATION_CONFLICT')
          return { ...receipt.result, replayed: true }
        }
      }
      if (manifest.format_version !== 2 || manifest.api_version !== '1.0.0') fail('BASELINE_REQUIRES_LEGACY_V2_API')
      if (!Array.isArray(manifest.spaces) || manifest.spaces.length !== 1 || manifest.spaces[0] !== this.store.memorySpaceId) fail('MULTISPACE_BASELINE_REQUIRED')
      if (existsSync(join(this.store.root, '.writer.lock')) || existsSync(join(this.store.root, '.writer-recovery.lock'))) fail('WRITER_BUSY')
      if (readdirSync(this.#path('journal')).length) fail('MANAGEMENT_RECOVERY_REQUIRED')
      const descriptors = [], source = { 'root-manifest': digest(rootBytes) }, ids = []
      for (const entry of readdirSync(this.#path('records'), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) fail('UNSAFE_STORAGE_PATH')
        const id = assertId(entry.name)
        if (loadRecordHead(this.store.root, this.store.memorySpaceId, id)) fail('INTEGRITY_BASELINE_EXISTS')
        const files = Object.fromEntries(RECORD_FILES.map((name) => [name, this.#read(`records/${id}/${name}`)]))
        const meta = JSON.parse(decode(files['meta.json']))
        const revisions = []
        for (const revision of readdirSync(this.#path(`records/${id}/revisions`), { withFileTypes: true })) {
          if (!revision.isDirectory() || revision.isSymbolicLink()) fail('UNSAFE_STORAGE_PATH')
          assertId(revision.name)
          const bundle = Object.fromEntries(RECORD_FILES.map((name) => [name, this.#read(`records/${id}/revisions/${revision.name}/${name}`)]))
          revisions.push({ files: bundle, meta: JSON.parse(decode(bundle['meta.json'])) })
        }
        revisions.sort((a, b) => a.meta.revision - b.meta.revision)
        let previousHead = null
        for (const revision of revisions) {
          const descriptor = buildRecordDescriptor({ root: this.store.root, spaceId: this.store.memorySpaceId, meta: revision.meta, files: revision.files, operationId, mode: 'baseline', previousHead })
          descriptors.push(descriptor); previousHead = descriptor.next
          source[`${id}/${revision.meta.revision_id}`] = recordBundleHash(revision.files)
        }
        if (!previousHead || meta.record_id !== id || meta.revision_id !== previousHead.head_revision_id) fail('INTEGRITY_HISTORY_REQUIRED')
        verifyRecordBundle(previousHead, files)
        source[`${id}/current`] = recordBundleHash(files); ids.push(id)
      }
      const snapshot = digest(source)
      this.#authorize(ctx, true)
      if (args.dry_run !== false) return { api_version: API_VERSION, status: 'preview', source_snapshot: snapshot, record_ids: ids, record_count: ids.length, writes: false, source_quiescence: 'owner_declared' }
      if (args.expected_snapshot !== snapshot) fail('BASELINE_SNAPSHOT_CONFLICT')
      const check = () => {
        this.#authorize(ctx, true, signal)
        if (digest(this.#rootFile('manifest.json')) !== source['root-manifest']) fail('BASELINE_SNAPSHOT_CONFLICT')
        for (const [path, hash] of Object.entries(source)) {
          if (path === 'root-manifest') continue
          const [id, revision] = path.split('/')
          const base = revision === 'current' ? `records/${id}` : `records/${id}/revisions/${revision}`
          const files = Object.fromEntries(RECORD_FILES.map((name) => [name, this.#read(`${base}/${name}`)]))
          if (recordBundleHash(files) !== hash) fail('BASELINE_SNAPSHOT_CONFLICT')
        }
      }
      return await this.store.engine.run(operationId, { action: 'establishIntegrityBaseline', source_snapshot: snapshot }, () => {
        check()
        return { changes: [], record_descriptors: descriptors, root_upgrade: { expected_hash: source['root-manifest'], manifest: { ...manifest, api_version: API_VERSION } },
          result: { api_version: API_VERSION, operation_id: operationId, status: 'committed', reason_code: 'BASELINE_ESTABLISHED', record_ids: ids, affected_ids: ids, source_snapshot: snapshot, source_quiescence: 'owner_declared', pending: false } }
      }, { authorize: check })
    } catch (error) { return failure(error, operationId) }
  }

  async scan(args = {}, ctx, { signal = null } = {}) {
    const operationId = args.operation_id ?? randomUUID()
    try {
      this.#authorize(ctx, false, signal)
      assertOnly(args, ['operation_id', 'record_ids', 'capture', 'limit', 'cursor'])
      if (args.capture !== undefined && typeof args.capture !== 'boolean') fail('INVALID_CAPTURE_OPTION')
      const limit = args.limit ?? 100, offset = args.cursor === undefined ? 0 : Number(args.cursor)
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) fail('INVALID_SCAN_BUDGET')
      const ledger = join(this.store.root, '.administration/record-heads', this.store.memorySpaceId)
      const all = args.record_ids ?? [...new Set([
        ...(existsSync(ledger) ? readdirSync(ledger).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)) : []),
        ...this.store._recordIds(),
      ])]
      if (!Array.isArray(all) || all.length > 10000 || new Set(all).size !== all.length) fail('INVALID_RECORD_IDS')
      all.forEach((id) => assertId(id))
      const items = []
      for (const id of [...all].sort().slice(offset, offset + limit)) {
        this.#authorize(ctx, false, signal)
        let head
        try { head = this.#head(id) } catch (error) { items.push({ record_id: id, status: 'unavailable', reason_code: error.code }); continue }
        const located = recordBundlePath(head), current = this.#path(located)
        const base = existsSync(current) ? located : head.change_id ? `quarantine/${id}/${head.change_id}/source` : located
        let observed
        try { observed = this.#observe(base) } catch (error) { items.push({ record_id: id, status: 'unsafe', reason_code: error.code }); continue }
        try { if (head.state === 'clean') { verifyRecordBundle(head, observed.files); items.push({ record_id: id, status: 'clean' }); continue } } catch {}
        if (head.change_id) {
          let previous = null
          try { previous = this.#change(head.change_id) } catch {}
          if (previous && (previous.observed_hash === observed.observed_hash || observed.missing)) { items.push(this.#summary(previous)); continue }
        }
        const item = { record_id: id, status: 'observed', reason_code: observed.missing ? 'RECORD_MISSING' : 'EXTERNAL_CHANGE', observed_hash: observed.observed_hash }
        if (!args.capture) { items.push(item); continue }
        const changeId = `change-${digest({ id, generation: head.generation, hash: observed.observed_hash }).slice(0, 40)}`
        const entry = { schema_version: 1, change_id: changeId, record_id: id, status: 'review_required', reason_code: item.reason_code,
          change_revision: 1, observed_hash: observed.observed_hash, baseline_revision_id: head.head_revision_id, baseline_generation: head.generation,
          snapshot_safe: observed.snapshot_safe === true, file_hashes: observed.hashes ?? Object.fromEntries(RECORD_FILES.map((name) => [name, null])), source_identity: observed.identity, created_at: new Date().toISOString(), purge_generation: getPurgeState(this.store.root, this.store.memorySpaceId).generation }
        const currentHead = head
        const check = () => {
          this.#authorize(ctx, false, signal)
          const fresh = this.#head(id)
          if (fresh.generation !== currentHead.generation) fail('EXTERNAL_HEAD_CONFLICT')
          if (this.#observe(base).observed_hash !== observed.observed_hash) fail('EXTERNAL_SOURCE_UNSTABLE')
        }
        const result = await this.store.managedTransaction(`capture-${digest({ operationId, id }).slice(0, 40)}`, { action: 'captureExternalChange', record_id: id, observed_hash: observed.observed_hash }, ({ manifest, records }) => {
          check()
          const watermark = manifest.revision_watermark + 1
          const changes = [{ path: `external-changes/${id}/${changeId}/manifest.json`, data: json(entry) },
            { path: 'manifest.json', data: json({ ...manifest, revision_watermark: watermark }) },
            { path: 'index/records.json', data: json(this.store._index(records.filter((record) => record.record_id !== id), watermark)) }]
          if (observed.snapshot_safe) for (const [name, data] of Object.entries(observed.files)) changes.push({ path: `quarantine/${id}/${changeId}/snapshot/${name}`, data })
          return { changes, record_descriptors: [buildRecordStateDescriptor({ root: this.store.root, spaceId: this.store.memorySpaceId, recordId: id, state: 'quarantined', changeId, operationId })],
            ...(!observed.missing ? { external_descriptor: { schema_version: 1, action: 'capture', record_id: id, change_id: changeId, source_identity: observed.identity, ...(head.schema_version === 2 ? { bundle_location: head.bundle_location } : {}), ...(base.startsWith('quarantine/') ? { source_change_id: head.change_id } : {}) } } : {}),
            result: { api_version: API_VERSION, status: 'quarantined', change_id: changeId, record_id: id, pending: false, affected_ids: [id] } }
        }, ctx, { authorize: check })
        items.push(result)
      }
      this.#authorize(ctx)
      return { api_version: API_VERSION, status: 'ok', items, cursor: offset + limit < all.length ? String(offset + limit) : null }
    } catch (error) { return failure(error, operationId) }
  }

  async list(args = {}, ctx, { signal = null } = {}) {
    try {
      this.#authorize(ctx, false, signal); assertOnly(args, ['limit', 'cursor', 'include_resolved'])
      const limit = args.limit ?? 100, offset = args.cursor === undefined ? 0 : Number(args.cursor)
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) fail('INVALID_SCAN_BUDGET')
      const rows = []
      for (const record of readdirSync(this.#path('external-changes'), { withFileTypes: true })) {
        if (!record.isDirectory() || record.isSymbolicLink()) continue
        assertId(record.name)
        const purge = getPurgeState(this.store.root, this.store.memorySpaceId)
        if (purge.record_ids.includes(record.name)) continue
        for (const change of readdirSync(this.#path(`external-changes/${record.name}`), { withFileTypes: true })) {
          if (!change.isDirectory() || change.isSymbolicLink()) continue
          if (!/^change-[a-f0-9]{40}$/.test(change.name)) continue
          try {
            const item = this.#summary(this.#change(change.name))
            if (args.include_resolved || !['adopted', 'restored', 'superseded'].includes(item.status)) rows.push(item)
          } catch (error) { rows.push({ change_id: change.name, record_id: record.name, status: 'invalid', reason_code: error instanceof MemoryError ? error.code : 'EXTERNAL_CHANGE_INVALID' }) }
        }
      }
      rows.sort((a, b) => a.change_id.localeCompare(b.change_id)); this.#authorize(ctx)
      return { api_version: API_VERSION, status: 'ok', items: rows.slice(offset, offset + limit), cursor: offset + limit < rows.length ? String(offset + limit) : null }
    } catch (error) { return failure(error) }
  }

  #preview(entry, head) {
    const candidates = head.revisions.slice().reverse().map((revision) => ({ revision_id: revision.revision_id, candidate: this.#candidate(head, revision.revision_id) })).filter((item) => item.candidate)
    const base = candidates[0]
    if (!base) fail('TRUSTED_REVISION_UNAVAILABLE')
    const diff = {}, rejected = []
    if (!entry.snapshot_safe || !recordRetentionAllowed(base.candidate.record)) rejected.push('UNSAFE_EXTERNAL_PAYLOAD')
    else {
      const files = {}; for (const [name, hash] of Object.entries(entry.file_hashes)) if (hash !== null) {
        files[name] = this.#read(`quarantine/${head.record_id}/${entry.change_id}/snapshot/${name}`)
        if (digest(files[name]) !== hash) fail('EXTERNAL_SNAPSHOT_CHANGED')
      }
      if (digest(Object.fromEntries(RECORD_FILES.map((name) => [name, files[name] ? digest(files[name]) : null]))) !== entry.observed_hash) fail('EXTERNAL_SNAPSHOT_CHANGED')
      if (!Object.entries(files).every(([name, data]) => externalFileAllowed(name, data))) fail('UNSAFE_EXTERNAL_PAYLOAD')
      let meta
      try { meta = JSON.parse(decode(files['meta.json'])) } catch { rejected.push('INVALID_EXTERNAL_META') }
      if (meta) {
        for (const key of new Set([...Object.keys(meta), ...Object.keys(base.candidate.record.meta)])) {
          if (['title', 'tags'].includes(key)) continue
          if (stableStringify(meta[key]) !== stableStringify(base.candidate.record.meta[key])) rejected.push(metadataFields.has(key) ? `IMMUTABLE_FIELD:${key}` : 'UNSUPPORTED_METADATA_FIELD')
        }
        for (const field of ['title', 'tags']) if (stableStringify(meta[field]) !== stableStringify(base.candidate.record.meta[field])) diff[field] = { before: base.candidate.record.meta[field], after: meta[field] }
      }
      for (const [field, file] of [['gist', 'gist.md'], ['detail', 'detail.md']]) if (files[file] && decode(files[file]) !== base.candidate.record[field]) diff[field] = { before: base.candidate.record[field], after: decode(files[file]) }
      if (files['evidence.jsonl'] && digest(files['evidence.jsonl']) !== digest(base.candidate.files['evidence.jsonl'])) rejected.push('ORIGINAL_EVIDENCE_EDITED')
      if (RECORD_FILES.some((name) => !files[name])) rejected.push('EXTERNAL_FILE_MISSING')
    }
    const sourceBase = `quarantine/${head.record_id}/${entry.change_id}/source`
    if (existsSync(this.#path(sourceBase)) && this.#observe(sourceBase).observed_hash !== entry.observed_hash) rejected.push('EXTERNAL_SOURCE_CHANGED')
    const digestValue = digest({ record_id: head.record_id, change_id: entry.change_id, head_generation: head.generation,
      head_revision_id: head.head_revision_id, observed_hash: entry.observed_hash, purge_generation: getPurgeState(this.store.root, this.store.memorySpaceId).generation, diff, rejected })
    return { entry, head, base, candidates, diff, rejected, review_digest: digestValue }
  }

  async preview(args, ctx, { signal = null } = {}) {
    try {
      this.#authorize(ctx, false, signal); assertOnly(args, ['change_id', 'expected_observed_hash'])
      const entry = this.#change(args.change_id), head = this.#head(entry.record_id)
      if (head.state !== 'quarantined' || head.change_id !== entry.change_id) fail('EXTERNAL_REVIEW_STALE')
      if (args.expected_observed_hash !== entry.observed_hash) fail('EXTERNAL_OBSERVATION_CONFLICT')
      const data = this.#preview(entry, head)
      if (stableStringify(data.diff).length > 16000) fail('PREVIEW_BUDGET_EXCEEDED')
      this.#authorize(ctx)
      return { api_version: API_VERSION, status: 'review_required', ...this.#summary(entry), review_digest: data.review_digest,
        head_revision_id: head.head_revision_id, head_generation: head.generation, diff: clone(data.diff), rejection_reasons: data.rejected,
        allowed_actions: data.rejected.length || data.base.revision_id !== head.head_revision_id ? ['restore'] : ['adopt', 'restore'],
        trusted_restore_revisions: data.candidates.map((item) => item.revision_id) }
    } catch (error) { return failure(error) }
  }

  async resolve(args, ctx, { signal = null } = {}) {
    const operationId = args?.operation_id ?? randomUUID()
    try {
      this.#authorize(ctx, false, signal)
      assertOnly(args, ['operation_id', 'change_id', 'action', 'review_digest', 'expected_change_revision', 'expected_head_revision_id', 'expected_observed_hash', 'fields', 'restore_revision_id'])
      if (!['adopt', 'restore'].includes(args.action)) fail('INVALID_REVIEW_ACTION')
      const receiptPath = this.#path(`operations/${digest(operationId)}.json`)
      if (existsSync(receiptPath)) {
        const existing = JSON.parse(decode(this.#read(`operations/${digest(operationId)}.json`)))
        const request = { action: 'managed', request: { action: 'resolveExternalChange', args }, actor: ctx.agent_identity_id, subject: ctx.subject_id, persona: ctx.persona_id, space: ctx.memory_space_id }
        if (existing.operation_id !== operationId || existing.request_hash !== digest(request)) fail('OPERATION_CONFLICT')
        if (getPurgeState(this.store.root, this.store.memorySpaceId).record_ids.includes(existing.result.record_id)) return { ...existing.result, status: 'purged', reason_code: 'PURGED_BY_MANAGEMENT', affected_ids: [], replayed: true }
        return { ...existing.result, replayed: true }
      }
      const entry = this.#change(args.change_id), head = this.#head(entry.record_id)
      const data = this.#preview(entry, head)
      const check = () => {
        this.#authorize(ctx, false, signal)
        const fresh = this.#head(entry.record_id)
        if (fresh.state !== 'quarantined' || fresh.change_id !== entry.change_id || fresh.generation !== head.generation || fresh.head_revision_id !== args.expected_head_revision_id ||
          args.expected_change_revision !== entry.change_revision || args.expected_observed_hash !== entry.observed_hash || this.#preview(entry, fresh).review_digest !== args.review_digest) fail('EXTERNAL_REVIEW_CONFLICT')
      }
      check()
      let record, files, mode
      const now = new Date().toISOString()
      if (args.action === 'restore') {
        const chosen = data.candidates.find((item) => item.revision_id === args.restore_revision_id)
        if (!chosen) fail('TRUSTED_REVISION_UNAVAILABLE')
        if (chosen.revision_id === head.head_revision_id) { record = chosen.candidate.record; files = chosen.candidate.files; mode = 'repair' }
        else {
          record = clone(chosen.candidate.record); mode = 'adopt'
          const currentLifecycle = this.#candidate(head, head.head_revision_id)?.record.meta.lifecycle
          if (head.bundle_location === 'cold' && !currentLifecycle) fail('TRUSTED_REVISION_UNAVAILABLE')
          record.meta = { ...record.meta, ...(currentLifecycle ? { status: currentLifecycle.tier === 'active' ? 'active' : 'archived', lifecycle: clone(currentLifecycle) } : {}), revision_id: randomUUID(), revision: head.head_revision + 1, supersedes: head.head_revision_id, updated_at: now,
            external_revision: { protected: true, source: 'owner_restore', change_id: entry.change_id, restored_from: chosen.revision_id } }
        }
      } else {
        if (data.rejected.length || data.base.revision_id !== head.head_revision_id) fail('EXTERNAL_PATCH_NOT_ALLOWED')
        if (!Array.isArray(args.fields) || !args.fields.length || new Set(args.fields).size !== args.fields.length || args.fields.some((field) => !allowedFields.includes(field) || !data.diff[field])) fail('APPROVED_FIELDS_REQUIRED')
        const patch = Object.fromEntries(args.fields.map((field) => [field, data.diff[field].after]))
        const patchText = stableStringify(patch)
        if (patchText.length > 8000 || !patchText.isWellFormed() || retentionBlockReason(patchText)) fail('EXTERNAL_PATCH_NOT_ALLOWED')
        const textValues = Object.values(patch).flatMap((value) => Array.isArray(value) ? value : [value])
        if (textValues.some((value) => typeof value !== 'string' || !value.isWellFormed() || retentionBlockReason(value)) || patch.tags && new Set(patch.tags).size !== patch.tags.length) fail('EXTERNAL_PATCH_NOT_ALLOWED')
        if ('title' in patch && (typeof patch.title !== 'string' || !patch.title.trim() || patch.title.length > 200) || 'tags' in patch && (!Array.isArray(patch.tags) || patch.tags.length > 24 || patch.tags.some((tag) => typeof tag !== 'string' || !tag.trim() || tag.length > 64)) || 'gist' in patch && (typeof patch.gist !== 'string' || !patch.gist.trim() || patch.gist.length > 2000) || 'detail' in patch && (typeof patch.detail !== 'string' || !patch.detail.trim())) fail('EXTERNAL_PATCH_NOT_ALLOWED')
        record = clone(data.base.candidate.record); mode = 'adopt'
        for (const field of args.fields) if (['gist', 'detail'].includes(field)) record[field] = patch[field]; else record.meta[field] = patch[field]
        const evidenceId = `external-${digest({ change: entry.change_id, operationId, patch }).slice(0, 40)}`
        record.evidence = [{ evidence_id: evidenceId, subject_ids: [head.subject_id], session_id: `review-${digest(operationId).slice(0, 40)}`, message_id: entry.change_id,
          observed_at: now, actor_ids: [ctx.agent_identity_id], claim_kind: 'quotation', content: patchText }]
        record.meta = { ...record.meta, revision_id: randomUUID(), revision: head.head_revision + 1, supersedes: head.head_revision_id,
          updated_at: now, observed_at: now, claim_kind: 'quotation', provenance_refs: [evidenceId], actor_ids: [ctx.agent_identity_id],
          external_revision: { protected: true, source: 'owner_external_edit', change_id: entry.change_id, base_revision_id: head.head_revision_id,
            observed_hash: entry.observed_hash, patch_hash: digest(patchText), growth_eligible: false, maturity_eligible: false } }
      }
      if (!files) {
        files = this.store._recordFiles(record)
      }
      const descriptor = buildRecordDescriptor({ root: this.store.root, spaceId: this.store.memorySpaceId, meta: record.meta, files, operationId, mode })
      const publicationId = digest({ operationId, review: args.review_digest }), prefix = `external-changes/${head.record_id}/${entry.change_id}/staged/${publicationId}`
      return await this.store.managedTransaction(operationId, { action: 'resolveExternalChange', args }, ({ manifest, records }) => {
        check()
        const changes = new Map()
        for (const revision of head.revisions) {
          const candidate = this.#candidate(head, revision.revision_id)
          if (!candidate) continue
          for (const [name, value] of Object.entries(candidate.files)) changes.set(`${prefix}/revisions/${revision.revision_id}/${name}`, value)
        }
        for (const [name, value] of Object.entries(files)) { changes.set(`${prefix}/${name}`, value); changes.set(`${prefix}/revisions/${record.meta.revision_id}/${name}`, value) }
        const watermark = manifest.revision_watermark + 1
        changes.set('manifest.json', json({ ...manifest, revision_watermark: watermark }))
        changes.set('index/records.json', json(this.store._index([...records.filter((item) => item.record_id !== head.record_id), record.meta], watermark)))
        if (args.action === 'adopt') for (const evidence of record.evidence) changes.set(`evidence/${evidence.evidence_id}.json`, json(evidence))
        return { changes: [...changes].map(([path, value]) => ({ path, data: value })), record_descriptors: [descriptor],
          external_descriptor: { schema_version: 1, action: 'publish', record_id: head.record_id, change_id: entry.change_id,
            ...(head.schema_version === 2 ? { bundle_location: head.bundle_location } : {}), bundle_hash: recordBundleHash(files), publication_id: publicationId, resolution: { status: args.action === 'adopt' ? 'adopted' : 'restored', operation_id: operationId, revision_id: record.meta.revision_id } },
          result: { api_version: API_VERSION, operation_id: operationId, status: 'committed', reason_code: args.action === 'adopt' ? 'EXTERNAL_ADOPTED' : 'EXTERNAL_RESTORED',
            record_id: head.record_id, revision_id: record.meta.revision_id, revision: record.meta.revision, affected_ids: [head.record_id], pending: false } }
      }, ctx, { authorize: check })
    } catch (error) { return failure(error, operationId) }
  }
}
