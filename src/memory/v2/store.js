import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { API_VERSION, CAPABILITIES, CLAIM_KINDS, FORMAT_VERSION, MEMORY_TYPES, MemoryError, RECORD_SCHEMA_VERSION, assertId, assertOnly, digest, failure, stableStringify, text, timestamp, validateRecord } from './contracts.js'
import { TransactionEngine, atomicWrite, readJson } from './transactions.js'
import { getPurgeState, reconcilePurgeState } from './purge-ledger.js'

const DATA_FILES = ['meta.json', 'gist.md', 'detail.md', 'evidence.jsonl']
const PROPOSAL_FIELDS = ['operation_id', 'subject_id', 'content', 'gist', 'title', 'type', 'tags', 'canonical_key', 'provenance_refs', 'claim_kind', 'confidence', 'visibility', 'valid_from', 'valid_to', 'expires_at', 'retention', 'pinned']
const json = (value) => `${JSON.stringify(value, null, 2)}\n`
const clone = (value) => JSON.parse(JSON.stringify(value))

function success(operationId, record, status = 'committed') {
  return { api_version: API_VERSION, operation_id: operationId, status, reason_code: 'OK', affected_ids: [record.record_id], record_id: record.record_id, revision_id: record.revision_id, revision: record.revision, pending: false }
}

function strings(value, label, { max = 32, size = 128 } = {}) {
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== 'string' || !item.trim() || item.length > size)) throw new MemoryError('INVALID_LIST', `Invalid ${label}`)
  return [...new Set(value.map((item) => item.trim()))]
}

export class MemoryStoreV2 {
  constructor({ root, memory_space_id = 'default', evidenceResolver, faultInjector, lockWaitMs = 2000, generationProvider, recoveryGuard } = {}) {
    if (typeof root !== 'string' || !root) throw new MemoryError('INVALID_STORAGE_ROOT')
    this.root = resolve(root)
    this.memorySpaceId = assertId(memory_space_id, 'memory_space_id')
    this.spaceRoot = join(this.root, 'spaces', this.memorySpaceId)
    this.paths = Object.freeze(Object.fromEntries(['records', 'evidence', 'candidates', 'self', 'assets', 'cold', 'quarantine', 'external-changes', 'journal', 'index', 'operations'].map((key) => [key, join(this.spaceRoot, key)])))
    this.evidenceResolver = evidenceResolver
    this.contexts = new WeakSet()
    this.engine = new TransactionEngine({ root: this.spaceRoot, lockRoot: this.root, memorySpaceId: this.memorySpaceId, faultInjector, lockWaitMs, generationProvider, recoveryGuard })
    this.initialized = false
  }

  async initialize() {
    await this.engine.locked(() => {
      const rootManifestPath = join(this.root, 'manifest.json')
      const rootManifest = readJson(rootManifestPath, null)
      if (rootManifest && rootManifest.format_version !== FORMAT_VERSION) throw new MemoryError('UNSUPPORTED_FORMAT_VERSION')
      if (rootManifest && (!Array.isArray(rootManifest.spaces) || rootManifest.spaces.some((id) => typeof id !== 'string'))) throw new MemoryError('INVALID_ROOT_MANIFEST')
      this.engine.resolvePath('manifest.json')
      for (const path of Object.values(this.paths)) mkdirSync(path, { recursive: true, mode: 0o700 })
      const manifestPath = join(this.spaceRoot, 'manifest.json')
      const manifest = readJson(manifestPath, null)
      if (manifest && (manifest.format_version !== FORMAT_VERSION || manifest.memory_space_id !== this.memorySpaceId)) throw new MemoryError('UNSUPPORTED_SPACE_FORMAT')
      const now = new Date().toISOString()
      if (!manifest) atomicWrite(manifestPath, json({ format_version: FORMAT_VERSION, memory_space_id: this.memorySpaceId, revision_watermark: 0, purge_generation: 0, created_at: now, identities: {}, migrations: [] }))
      const spaces = [...new Set([...(rootManifest?.spaces ?? []), this.memorySpaceId])].sort()
      atomicWrite(rootManifestPath, json(rootManifest ? { ...rootManifest, spaces } : { format_version: FORMAT_VERSION, api_version: API_VERSION, record_schema_versions: [RECORD_SCHEMA_VERSION], spaces, created_at: now }))
      this.engine._recover()
      reconcilePurgeState(this.root, this.spaceRoot, atomicWrite)
      this._rebuildIndex()
    })
    this.initialized = true
    return this
  }

  issueContext({ agent_identity_id, persona_id, subject_id, allowed_subject_ids, capabilities = ['memory.read', 'memory.write'], session_id = null, expires_at = null } = {}) {
    const expiry = timestamp(expires_at ?? new Date(Date.now() + 5 * 60_000).toISOString(), 'context expiry', false)
    if (Date.parse(expiry) > Date.now() + 60 * 60_000) throw new MemoryError('CONTEXT_EXPIRY_TOO_LONG')
    const context = Object.freeze({
      agent_identity_id: assertId(agent_identity_id, 'agent_identity_id'),
      persona_id: assertId(persona_id, 'persona_id'),
      subject_id: assertId(subject_id, 'subject_id'),
      memory_space_id: this.memorySpaceId,
      allowed_subject_ids: Object.freeze(strings(allowed_subject_ids ?? [subject_id], 'allowed_subject_ids')),
      capabilities: Object.freeze(strings(capabilities, 'capabilities').filter((capability) => CAPABILITIES.includes(capability))),
      session_id: session_id === null ? null : assertId(session_id, 'session_id'),
      expires_at: expiry,
    })
    this.contexts.add(context)
    return context
  }

  _authorize(context, capability) {
    if (!this.initialized) throw new MemoryError('NOT_INITIALIZED')
    if (!context || !this.contexts.has(context)) throw new MemoryError('UNTRUSTED_CONTEXT')
    if (context.expires_at && Date.parse(context.expires_at) <= Date.now()) throw new MemoryError('CONTEXT_EXPIRED')
    if (!context.capabilities.includes(capability) && !context.capabilities.includes('memory.manage')) throw new MemoryError('CAPABILITY_DENIED')
    return context
  }

  _manifest() {
    const manifest = readJson(join(this.spaceRoot, 'manifest.json'))
    if (manifest.format_version !== FORMAT_VERSION || manifest.memory_space_id !== this.memorySpaceId) throw new MemoryError('UNSUPPORTED_SPACE_FORMAT')
    return manifest
  }

  _visible(record, context) {
    if (record.memory_space_id !== this.memorySpaceId) return false
    if (context.capabilities.includes('memory.manage')) return true
    if (!context.allowed_subject_ids.includes(record.subject_id)) return false
    if (record.visibility?.kind === 'space') return true
    if (record.agent_identity_id === context.agent_identity_id) return true
    return record.visibility?.kind === 'identities' && record.visibility.identity_ids.includes(context.agent_identity_id)
  }

  _readRecord(id, revisionId = null) {
    const base = `records/${assertId(id, 'record_id')}${revisionId ? `/revisions/${assertId(revisionId, 'revision_id')}` : ''}`
    const dir = this.engine.resolvePath(base)
    const integrity = readJson(join(dir, 'integrity.json'))
    const files = Object.fromEntries(DATA_FILES.map((file) => [file, readFileSync(join(dir, file), 'utf8')]))
    if (DATA_FILES.some((file) => integrity.files?.[file] !== digest(files[file]))) throw new MemoryError('EXTERNAL_CHANGE')
    const meta = validateRecord(JSON.parse(files['meta.json']))
    if (meta.record_id !== id || meta.memory_space_id !== this.memorySpaceId || integrity.revision_id !== meta.revision_id) throw new MemoryError('RECORD_SCOPE_MISMATCH')
    return { meta, gist: files['gist.md'], detail: files['detail.md'], evidence: files['evidence.jsonl'].split('\n').filter(Boolean).map((line) => JSON.parse(line)) }
  }

  _records() {
    const records = []
    const warnings = []
    for (const dir of readdirSync(this.paths.records, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue
      try { records.push(this._readRecord(assertId(dir.name)).meta) } catch (error) { warnings.push({ record_id: dir.name, reason_code: error.code ?? 'INVALID_RECORD' }) }
    }
    return { records, warnings }
  }

  _index(records, watermark) {
    return { format_version: FORMAT_VERSION, memory_space_id: this.memorySpaceId, revision_watermark: watermark, records: records.map((meta) => ({ record_id: meta.record_id, revision_id: meta.revision_id, revision: meta.revision, title: meta.title, type: meta.type, subject_id: meta.subject_id, status: meta.status, tags: meta.tags })).sort((a, b) => a.record_id.localeCompare(b.record_id)) }
  }

  _rebuildIndex() {
    const { records, warnings } = this._records()
    atomicWrite(join(this.paths.index, 'records.json'), json(this._index(records, this._manifest().revision_watermark)))
    return { count: records.length, warnings }
  }

  _recordChanges(record) {
    const files = {
      'meta.json': json(record.meta), 'gist.md': record.gist, 'detail.md': record.detail,
      'evidence.jsonl': record.evidence.map((item) => JSON.stringify(item)).join('\n') + '\n',
    }
    files['integrity.json'] = json({ revision_id: record.meta.revision_id, files: Object.fromEntries(DATA_FILES.map((file) => [file, digest(files[file])])) })
    const bases = [`records/${record.meta.record_id}`, `records/${record.meta.record_id}/revisions/${record.meta.revision_id}`]
    return bases.flatMap((base) => Object.entries(files).map(([file, data]) => ({ path: `${base}/${file}`, data })))
  }

  async _evidence(refs, context, subjectId) {
    const ids = strings(refs, 'provenance_refs')
    ids.forEach((id) => assertId(id, 'evidence id'))
    if (!ids.length || typeof this.evidenceResolver !== 'function') throw new MemoryError('EVIDENCE_REQUIRED')
    const result = []
    for (const id of ids) {
      if (getPurgeState(this.root, this.memorySpaceId).related_evidence_ids.includes(id)) throw new MemoryError('EVIDENCE_PURGED')
      const source = await this.evidenceResolver(id, context)
      this._authorize(context, 'memory.write')
      if (!source || source.allow_persist !== true) throw new MemoryError('EVIDENCE_NOT_ALLOWED')
      if (source.evidence_id !== id) throw new MemoryError('EVIDENCE_SCOPE_MISMATCH')
      const subjects = source.subject_ids ?? [source.subject_id]
      if (!subjects.includes(subjectId)) throw new MemoryError('EVIDENCE_SCOPE_MISMATCH')
      const evidence = {
        evidence_id: id, subject_ids: strings(subjects, 'evidence subjects'),
        session_id: assertId(source.session_id, 'evidence session'),
        message_id: assertId(source.message_id, 'evidence message'),
        observed_at: timestamp(source.observed_at, 'evidence time', false),
        actor_ids: strings(source.actor_ids, 'evidence actors'),
        claim_kind: source.claim_kind,
        content: text(source.content, 'evidence content', { max: 8000 }),
      }
      if (!CLAIM_KINDS.includes(evidence.claim_kind) || evidence.claim_kind === 'legacy') throw new MemoryError('INVALID_EVIDENCE_KIND')
      const existing = readJson(join(this.paths.evidence, `${id}.json`), null)
      if (existing && stableStringify(existing) !== stableStringify(evidence)) throw new MemoryError('EVIDENCE_CONFLICT')
      result.push(evidence)
    }
    return result
  }

  _visibility(value, context) {
    const visibility = value ?? { kind: 'private' }
    if (!visibility || !['private', 'space', 'identities'].includes(visibility.kind)) throw new MemoryError('INVALID_VISIBILITY')
    if (visibility.kind === 'private') return { kind: 'private' }
    this._authorize(context, 'memory.share')
    return visibility.kind === 'space' ? { kind: 'space' } : { kind: 'identities', identity_ids: strings(visibility.identity_ids, 'visibility identities') }
  }

  async _proposal(args, context, previous = null) {
    const subjectId = assertId(args.subject_id ?? previous?.meta.subject_id ?? context.subject_id, 'subject_id')
    if (!context.allowed_subject_ids.includes(subjectId) && !context.capabilities.includes('memory.manage')) throw new MemoryError('SUBJECT_DENIED')
    const evidence = await this._evidence(args.provenance_refs, context, subjectId)
    this._authorize(context, 'memory.write')
    const content = text(args.content, 'content')
    const gist = text(args.gist ?? content.slice(0, 2000), 'gist', { max: 2000 })
    const kind = args.claim_kind ?? (new Set(evidence.map((item) => item.claim_kind)).size === 1 ? evidence[0].claim_kind : 'inference')
    if (!CLAIM_KINDS.includes(kind) || kind === 'legacy') throw new MemoryError('INVALID_CLAIM_KIND')
    if (kind !== 'inference' && evidence.some((item) => item.claim_kind !== kind)) throw new MemoryError('CLAIM_KIND_CONFLICT')
    const type = args.type ?? previous?.meta.type ?? 'fact'
    if (!MEMORY_TYPES.includes(type)) throw new MemoryError('INVALID_RECORD_KIND')
    const validFrom = timestamp(args.valid_from === undefined ? previous?.meta.valid_from : args.valid_from, 'valid_from')
    const validTo = timestamp(args.valid_to === undefined ? previous?.meta.valid_to : args.valid_to, 'valid_to')
    const expiresAt = timestamp(args.expires_at === undefined ? previous?.meta.expires_at : args.expires_at, 'expires_at')
    if (validFrom && validTo && Date.parse(validTo) < Date.parse(validFrom)) throw new MemoryError('INVALID_TIME_RANGE')
    if (args.retention && !['temporary', 'long_term'].includes(args.retention)) throw new MemoryError('UNSUPPORTED_RETENTION')
    const retention = args.retention ?? previous?.meta.retention ?? (expiresAt ? 'temporary' : 'long_term')
    if (retention === 'temporary' && !expiresAt) throw new MemoryError('EXPIRY_REQUIRED')
    const now = new Date().toISOString()
    const old = previous?.meta
    const meta = {
      schema_version: RECORD_SCHEMA_VERSION, record_id: old?.record_id ?? randomUUID(), revision_id: randomUUID(), revision: (old?.revision ?? 0) + 1,
      memory_space_id: this.memorySpaceId, subject_id: subjectId,
      actor_ids: [...new Set(evidence.flatMap((item) => item.actor_ids))],
      persona_id: context.persona_id, agent_identity_id: context.agent_identity_id,
      created_at: old?.created_at ?? now, observed_at: evidence.map((item) => item.observed_at).sort()[0], updated_at: now,
      valid_from: validFrom, valid_to: validTo, expires_at: expiresAt, retention,
      claim_kind: kind, confidence: args.confidence === undefined ? 0.8 : Number(args.confidence),
      title: text(args.title ?? content.slice(0, 160), 'title', { max: 200 }), type,
      tags: strings(args.tags ?? old?.tags ?? [], 'tags', { max: 24, size: 64 }),
      canonical_key: args.canonical_key === undefined ? old?.canonical_key ?? null : text(args.canonical_key, 'canonical_key', { max: 256 }),
      provenance_refs: evidence.map((item) => item.evidence_id), visibility: this._visibility(args.visibility ?? old?.visibility, context),
      pinned: args.pinned === undefined ? old?.pinned === true : args.pinned === true, status: 'active', supersedes: old?.revision_id ?? null,
      revision_history: old ? [...(old.revision_history ?? []), { revision_id: old.revision_id, revision: old.revision, superseded_at: now, reason: args.reason }] : [],
      layers: { gist: true, detail: true, raw: true },
    }
    if (!Number.isFinite(meta.confidence) || meta.confidence < 0 || meta.confidence > 1) throw new MemoryError('INVALID_CONFIDENCE')
    validateRecord(meta)
    return { meta, gist, detail: content, evidence }
  }

  _commitChanges(record) {
    const manifest = this._manifest()
    const watermark = manifest.revision_watermark + 1
    const existing = this._records().records.filter((item) => item.record_id !== record.meta.record_id)
    return [
      ...this._recordChanges(record),
      ...record.evidence.map((item) => ({ path: `evidence/${item.evidence_id}.json`, data: json(item) })),
      { path: 'manifest.json', data: json({ ...manifest, revision_watermark: watermark }) },
      { path: 'index/records.json', data: json(this._index([...existing, record.meta], watermark)) },
    ]
  }

  async proposeMemory(args, context) {
    const operationId = args?.operation_id ?? randomUUID()
    try {
      this._authorize(context, 'memory.write')
      assertOnly(args, PROPOSAL_FIELDS)
      return await this.engine.run(operationId, { action: 'proposeMemory', args, actor: context.agent_identity_id, subject: context.subject_id, persona: context.persona_id, space: context.memory_space_id }, async () => {
        this._authorize(context, 'memory.write')
        const record = await this._proposal(args, context)
        this._authorize(context, 'memory.write')
        return { changes: this._commitChanges(record), result: success(operationId, record.meta, record.meta.retention === 'temporary' ? 'temporary' : 'committed') }
      }, { authorize: () => this._authorize(context, 'memory.write') })
    } catch (error) { return failure(error, operationId) }
  }

  async reviseMemory(args, context) {
    const operationId = args?.operation_id ?? randomUUID()
    try {
      this._authorize(context, 'memory.write')
      assertOnly(args, [...PROPOSAL_FIELDS, 'record_id', 'expected_revision', 'reason'])
      assertId(args.record_id, 'record_id')
      text(args.reason, 'revision reason', { max: 500 })
      if (!Number.isSafeInteger(args.expected_revision)) throw new MemoryError('EXPECTED_REVISION_REQUIRED')
      return await this.engine.run(operationId, { action: 'reviseMemory', args, actor: context.agent_identity_id, subject: context.subject_id, persona: context.persona_id, space: context.memory_space_id }, async () => {
        this._authorize(context, 'memory.write')
        const previous = this._readRecord(args.record_id)
        if (!this._visible(previous.meta, context) || (previous.meta.agent_identity_id !== context.agent_identity_id && !context.capabilities.includes('memory.manage'))) throw new MemoryError('RECORD_DENIED')
        if ((previous.meta.external_revision?.protected === true || previous.meta.legacy?.user_edited === true) && !context.capabilities.includes('memory.manage')) throw new MemoryError('PROTECTED_REVISION')
        if (previous.meta.revision !== args.expected_revision) throw new MemoryError('REVISION_CONFLICT')
        const record = await this._proposal(args, context, previous)
        this._authorize(context, 'memory.write')
        return { changes: this._commitChanges(record), result: success(operationId, record.meta) }
      }, { authorize: () => this._authorize(context, 'memory.write') })
    } catch (error) { return failure(error, operationId) }
  }

  async queryMemory(args, context) {
    try {
      this._authorize(context, 'memory.read')
      assertOnly(args, ['record_id', 'query', 'subject_id', 'depth', 'at', 'include_inactive', 'limit'])
      if (args.query !== undefined && typeof args.query !== 'string') throw new MemoryError('INVALID_QUERY')
      if (args.subject_id !== undefined) assertId(args.subject_id, 'subject_id')
      if (!args.record_id && !String(args.query ?? '').trim()) this._authorize(context, 'memory.list')
      if (args.record_id) assertId(args.record_id, 'record_id')
      const depth = args.depth ?? 'gist'
      if (!['index', 'gist', 'detail', 'raw'].includes(depth)) throw new MemoryError('INVALID_DEPTH')
      if (depth === 'raw') this._authorize(context, 'memory.raw')
      if (args.include_inactive) this._authorize(context, 'memory.manage')
      const at = args.at === undefined ? Date.now() : Date.parse(timestamp(args.at, 'query time', false))
      const query = String(args.query ?? '').trim().toLowerCase()
      return await this.engine.read(() => {
        this._authorize(context, 'memory.read')
        this._manifest()
        const { records, warnings } = this._records()
        const matches = records.filter((meta) => {
          if (!this._visible(meta, context)) return false
          if (args.record_id && meta.record_id !== args.record_id) return false
          if (args.subject_id && meta.subject_id !== args.subject_id) return false
          if (!args.include_inactive && meta.status !== 'active') return false
          if ((meta.valid_from && Date.parse(meta.valid_from) > at) || (meta.valid_to && Date.parse(meta.valid_to) <= at) || (meta.expires_at && Date.parse(meta.expires_at) <= at)) return false
          const record = this._readRecord(meta.record_id)
          return !query || `${meta.title}\n${record.gist}\n${meta.tags.join(' ')}`.toLowerCase().includes(query)
        }).slice(0, Math.min(10, Math.max(1, Number(args.limit) || 5)))
        const items = matches.map((meta) => {
          const record = this._readRecord(meta.record_id)
          return { meta: clone(meta), ...(depth !== 'index' ? { gist: record.gist } : {}), ...(['detail', 'raw'].includes(depth) ? { detail: record.detail } : {}), ...(depth === 'raw' ? { evidence: record.evidence } : {}) }
        })
        this._authorize(context, 'memory.read')
        return { api_version: API_VERSION, operation_id: null, status: 'ok', reason_code: items.length ? 'OK' : 'NO_MATCH', items, warnings: context.capabilities.includes('memory.manage') ? warnings : warnings.map(({ reason_code }) => ({ reason_code })), revision_watermark: this._manifest().revision_watermark }
      })
    } catch (error) { return failure(error) }
  }

  async rebuildIndex(context) {
    try { this._authorize(context, 'memory.manage'); return await this.engine.read(() => { this._authorize(context, 'memory.manage'); return { status: 'ok', ...this._rebuildIndex() } }) } catch (error) { return failure(error) }
  }

  async managedTransaction(operationId, request, build, context) {
    this._authorize(context, 'memory.manage')
    return this.engine.run(operationId, { action: 'managed', request, actor: context.agent_identity_id, subject: context.subject_id, persona: context.persona_id, space: context.memory_space_id }, async () => {
      this._authorize(context, 'memory.manage')
      const result = await build({ store: this, manifest: this._manifest(), records: this._records().records })
      this._authorize(context, 'memory.manage')
      return result
    }, { authorize: () => this._authorize(context, 'memory.manage') })
  }

  async managedRead(context, read) {
    this._authorize(context, 'memory.manage')
    return this.engine.read(async () => {
      this._authorize(context, 'memory.manage')
      const result = await read({ store: this, manifest: this._manifest(), records: this._records().records })
      this._authorize(context, 'memory.manage')
      return result
    })
  }
}

export default MemoryStoreV2
