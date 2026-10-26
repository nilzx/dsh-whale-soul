import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { API_VERSION, MemoryError, assertId, assertOnly, digest, text, timestamp } from './contracts.js'
import { retentionBlockReason } from './retention.js'
import { getPurgeState } from './purge-ledger.js'

const json = (value) => `${JSON.stringify(value, null, 2)}\n`
const MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
const IDENTITY = ['memory_space_id', 'persona_id', 'agent_identity_id', 'subject_id']
const EVIDENCE_FIELDS = ['evidence_id', 'subject_ids', 'actor_ids', 'session_id', 'message_id', 'observed_at', 'claim_kind', 'content',
  'source', 'image_message_id', 'image_attachment_id', 'consent_id', ...IDENTITY]
export const ASSET_METADATA_FIELDS = Object.freeze(['schema_version', 'id', 'file', 'mime', 'bytes', 'description', 'tags', 'source',
  'created_at', 'updated_at', 'uses', ...IDENTITY, 'consent_id', 'evidence_refs', 'record_ids'])
const clone = (value) => structuredClone(value)
const querySegmenter = new Intl.Segmenter('zh', { granularity: 'word' })
const imageWords = new Set(['图', '图片', '图像', '照片', 'image', 'images', 'picture', 'pictures', 'photo', 'photos'])
const queryParticles = new Set(['的', '这', '那', '张', '一张', '个', '一个', 'a', 'an', 'the'])
function assetQueryWords(value, { query = false } = {}) {
  const words = new Set()
  for (const part of querySegmenter.segment(value.normalize('NFKC').toLowerCase())) {
    if (!part.isWordLike || query && queryParticles.has(part.segment)) continue
    words.add(imageWords.has(part.segment) ? 'image' : part.segment)
  }
  return words
}
function matchesAssetQuery(item, words) {
  if (!words.size) return false
  const available = assetQueryWords(`${item.description} ${item.tags.join(' ')}`)
  // Every query word must be present. Exact lexical tokens prevent red/credit
  // or sea/seasonal substring matches while allowing Chinese word combinations.
  return [...words].every((word) => available.has(word))
}
function blocked(value) { const reason = retentionBlockReason(value); if (reason) throw new MemoryError(reason) }
function tags(input = []) {
  if (!Array.isArray(input) || input.length > 24) throw new MemoryError('INVALID_ASSET_TAGS')
  const values = [...new Set(input.map((value) => text(value, 'asset tag', { max: 64 })))]
  if (values.some((value) => !value.isWellFormed())) throw new MemoryError('INVALID_ASSET_TAGS')
  values.forEach(blocked); return values
}

export function deriveImageIdentifiers({ identity, consent_id, file }) {
  for (const key of IDENTITY) assertId(identity?.[key])
  assertId(consent_id)
  if (!/^[a-f0-9]{64}\.(png|jpg|jpeg|webp|gif)$/.test(file)) throw new MemoryError('INVALID_ASSET_REFERENCE')
  const scope = Object.fromEntries(IDENTITY.map((key) => [key, identity[key]]))
  const suffix = digest({ ...scope, consent_id }).slice(0, 40)
  return { asset_id: `a-${digest({ ...scope, file, consent_id }).slice(0, 20)}`, record_id: `meme-${suffix}`,
    evidence_id: `image-consent-${suffix}`, operation_id: `image-save-${suffix}` }
}

/** Pure portable V2 metadata validation; archive code additionally verifies bytes and file existence. */
export function validateAssetMetadata(value, { assetId = value?.id, recordMetas, evidence } = {}) {
  assertOnly(value, ASSET_METADATA_FIELDS)
  if (ASSET_METADATA_FIELDS.some((key) => !Object.hasOwn(value, key)) || value.schema_version !== 1 || value.id !== assetId || value.source !== 'chat-attachment' || value.uses !== 0 ||
    !MIME[value.mime] || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > 8 * 1024 * 1024 ||
    typeof value.description !== 'string' || !value.description.isWellFormed()) throw new MemoryError('INVALID_SCOPED_ASSET_METADATA')
  text(value.description, 'asset description', { max: 240 }); blocked(value.description); tags(value.tags)
  timestamp(value.created_at, 'asset creation', false); timestamp(value.updated_at, 'asset update', false)
  if (value.created_at !== value.updated_at) throw new MemoryError('INVALID_SCOPED_ASSET_METADATA')
  const ids = deriveImageIdentifiers({ identity: value, consent_id: value.consent_id, file: value.file })
  const extension = value.file.split('.').at(-1)
  if (extension !== MIME[value.mime] && !(value.mime === 'image/jpeg' && extension === 'jpeg')) throw new MemoryError('INVALID_SCOPED_ASSET_METADATA')
  if (value.id !== ids.asset_id || value.record_ids?.length !== 1 || value.record_ids[0] !== ids.record_id ||
    value.evidence_refs?.length !== 1 || value.evidence_refs[0] !== ids.evidence_id) throw new MemoryError('ASSET_REFERENCE_CONFLICT')
  if (recordMetas !== undefined) {
    if (!Array.isArray(recordMetas) || recordMetas.length !== 1) throw new MemoryError('ASSET_RECORD_SCOPE_CONFLICT')
    const meta = recordMetas[0]
    if (IDENTITY.some((key) => meta[key] !== value[key]) || meta.type !== 'meme' || meta.claim_kind !== 'user_statement' ||
      meta.record_id !== ids.record_id || meta.visibility?.kind !== 'private' || meta.asset_metadata_hash !== digest(value) ||
      !Array.isArray(meta.assets) || meta.assets.length !== 2 || !meta.assets.includes(ids.asset_id) || !meta.assets.includes(value.file) ||
      !Array.isArray(meta.actor_ids) || meta.actor_ids.length !== 1 || meta.actor_ids[0] !== value.subject_id ||
      meta.provenance_refs?.length !== 1 || meta.provenance_refs[0] !== ids.evidence_id) throw new MemoryError('ASSET_RECORD_SCOPE_CONFLICT')
  }
  if (evidence !== undefined) {
    if (!Array.isArray(evidence) || evidence.length !== 1) throw new MemoryError('ASSET_CONSENT_EVIDENCE_CONFLICT')
    const source = evidence[0]
    assertOnly(source, EVIDENCE_FIELDS)
    if (source.evidence_id !== ids.evidence_id || source.consent_id !== value.consent_id || source.source !== 'user' ||
      source.claim_kind !== 'user_statement' || IDENTITY.some((key) => source[key] !== value[key]) ||
      !Array.isArray(source.subject_ids) || source.subject_ids.length !== 1 || source.subject_ids[0] !== value.subject_id ||
      !Array.isArray(source.actor_ids) || source.actor_ids.length !== 1 || source.actor_ids[0] !== value.subject_id ||
      source.image_attachment_id !== `sha256:${value.file.split('.')[0]}`) throw new MemoryError('ASSET_CONSENT_EVIDENCE_CONFLICT')
    assertId(source.session_id); assertId(source.message_id); assertId(source.image_message_id)
    timestamp(source.observed_at, 'asset source time', false); text(source.content, 'asset source', { max: 8000 }); blocked(source.content)
    if (!source.content.isWellFormed()) throw new MemoryError('ASSET_CONSENT_EVIDENCE_CONFLICT')
    const expectedConsent = `consent-${digest({ ...Object.fromEntries(IDENTITY.map((key) => [key, value[key]])),
      session_id: source.session_id, message_id: source.message_id, image_message_id: source.image_message_id,
      attachment_id: source.image_attachment_id }).slice(0, 40)}`
    if (expectedConsent !== value.consent_id) throw new MemoryError('ASSET_CONSENT_EVIDENCE_CONFLICT')
  }
  return value
}
function image(stored) {
  const ref = stored?.ref, bytes = stored?.data instanceof Uint8Array ? Buffer.from(stored.data) : null
  if (!bytes?.length || bytes.length > 8 * 1024 * 1024 || !MIME[ref?.mediaType] || ref.bytes !== bytes.length ||
    !Number.isSafeInteger(ref.width) || !Number.isSafeInteger(ref.height) || ref.width < 1 || ref.height < 1 ||
    ref.attachmentId !== `sha256:${digest(bytes)}`) throw new MemoryError('INVALID_VERIFIED_IMAGE')
  const magic = ref.mediaType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    : ref.mediaType === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : ref.mediaType === 'image/gif' ? /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))
    : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  if (!magic) throw new MemoryError('INVALID_VERIFIED_IMAGE')
  return { bytes, ref, file: `${digest(bytes)}.${MIME[ref.mediaType]}` }
}

/** Neutral managed image service. resolveConsent is trusted host code, never a tool argument. */
export class MemoryAssetsV2 {
  constructor({ store, resolveConsent } = {}) {
    if (typeof store?.managedTransaction !== 'function' || typeof resolveConsent !== 'function') throw new MemoryError('TRUSTED_ASSET_ADAPTERS_REQUIRED')
    this.store = store; this.resolveConsent = resolveConsent
  }
  #context(context) {
    return this.store.issueContext({ ...context, capabilities: ['memory.manage'], expires_at: context.expires_at })
  }
  #grant(value, context) {
    if (!value || value.source !== 'user' || value.allow_persist !== true || value.session_id !== context.session_id ||
      IDENTITY.some((key) => value[key] !== context[key]) || typeof value.isCurrent !== 'function' || !value.isCurrent() || value.signal?.aborted) throw new MemoryError('IMAGE_CONSENT_UNAVAILABLE')
    assertId(value.consent_id); assertId(value.message_id); assertId(value.image_message_id)
    timestamp(value.observed_at, 'image consent time', false)
    const content = text(value.content, 'image consent', { max: 8000 })
    blocked(content); return { ...value, content }
  }
  async save(args, context, { signal } = {}) {
    this.store._authorize(context, 'memory.write')
    this.store._authorize(context, 'memory.read')
    assertOnly(args, ['consent_id', 'description', 'tags'])
    assertId(args.consent_id)
    const description = text(args.description ?? '主人明确同意保存的图片', 'image description', { max: 240 })
    if (!description.isWellFormed()) throw new MemoryError('INVALID_ASSET_DESCRIPTION')
    blocked(description)
    const labels = tags(args.tags)
    const grant = this.#grant(await this.resolveConsent(args.consent_id, context), context)
    const prepared = image(grant.image)
    const identity = Object.fromEntries(IDENTITY.map((key) => [key, context[key]]))
    const { asset_id: assetId, record_id: recordId, evidence_id: evidenceId, operation_id: operationId } =
      deriveImageIdentifiers({ identity, file: prepared.file, consent_id: grant.consent_id })
    const managed = this.#context(context)
    const signals = [grant.signal, signal].filter(Boolean)
    const assertCurrent = () => {
      this.store._authorize(context, 'memory.write')
      if (signals.some((signal) => signal.aborted) || !grant.isCurrent()) throw new MemoryError('IMAGE_CONSENT_REVOKED')
    }
    // Revoke this exact issuer-owned branded context, so the transaction's
    // final authorization before COMMIT also observes in-flight withdrawal.
    const revoke = () => this.store.contexts.delete(managed)
    signals.forEach((signal) => signal.addEventListener('abort', revoke, { once: true }))
    try {
      assertCurrent()
      const result = await this.store.managedTransaction(operationId, { action: 'saveConsentedImage', asset_id: assetId,
        record_id: recordId, evidence_id: evidenceId, file: prepared.file, description, tags: labels, ...identity }, async ({ manifest, records }) => {
        assertCurrent()
        const current = this.#grant(await this.resolveConsent(args.consent_id, context), context)
        const checked = image(current.image)
        if (checked.file !== prepared.file || digest(current.content) !== digest(grant.content) ||
          current.message_id !== grant.message_id || current.image_message_id !== grant.image_message_id) throw new MemoryError('IMAGE_SOURCE_CHANGED')
        assertCurrent()
        if (getPurgeState(this.store.root, this.store.memorySpaceId).record_ids.includes(recordId)) throw new MemoryError('PURGED_CONTENT')
        const now = new Date().toISOString(), revisionId = randomUUID()
        const metadata = { schema_version: 1, id: assetId, file: prepared.file, mime: prepared.ref.mediaType,
          bytes: prepared.bytes.length, description, tags: labels, source: 'chat-attachment', created_at: now, updated_at: now, uses: 0,
          ...identity, consent_id: grant.consent_id, evidence_refs: [evidenceId], record_ids: [recordId] }
        const evidence = { evidence_id: evidenceId, subject_ids: [context.subject_id], actor_ids: [context.subject_id],
          session_id: context.session_id, message_id: grant.message_id, observed_at: grant.observed_at,
          claim_kind: 'user_statement', content: grant.content, source: 'user', image_message_id: grant.image_message_id,
          image_attachment_id: prepared.ref.attachmentId, consent_id: grant.consent_id, ...identity }
        const record = { meta: { schema_version: 2, record_id: recordId, revision_id: revisionId, revision: 1, ...identity,
          actor_ids: [context.subject_id], created_at: now, updated_at: now, observed_at: grant.observed_at,
          valid_from: grant.observed_at, valid_to: null, expires_at: null, retention: 'long_term', claim_kind: 'user_statement',
          confidence: 1, title: '明确同意保存的图片', type: 'meme', tags: labels, canonical_key: null,
          provenance_refs: [evidenceId], visibility: { kind: 'private' }, pinned: false, status: 'active', supersedes: null,
          revision_history: [], layers: { gist: true, detail: true, raw: true }, assets: [assetId, prepared.file], asset_metadata_hash: digest(metadata) },
        gist: grant.content, detail: grant.content, evidence: [evidence] }
        validateAssetMetadata(metadata, { recordMetas: [record.meta], evidence: [evidence] })
        const file = this.store.engine.resolvePath(`assets/${prepared.file}`)
        if (existsSync(file) && digest(readFileSync(file)) !== digest(prepared.bytes)) throw new MemoryError('EXTERNAL_ASSET_CHANGE')
        const metaPath = this.store.engine.resolvePath(`assets/${assetId}.json`)
        if (existsSync(metaPath)) throw new MemoryError('ASSET_ID_CONFLICT')
        const watermark = manifest.revision_watermark + 1
        assertCurrent()
        return { changes: [...this.store._recordChanges(record), { path: `evidence/${evidenceId}.json`, data: json(evidence) },
          { path: `assets/${assetId}.json`, data: json(metadata) }, ...(!existsSync(file) ? [{ path: `assets/${prepared.file}`, data: prepared.bytes }] : []),
          { path: 'manifest.json', data: json({ ...manifest, revision_watermark: watermark }) },
          { path: 'index/records.json', data: json(this.store._index([...records, record.meta], watermark)) }],
        result: { api_version: API_VERSION, operation_id: operationId, status: 'committed', reason_code: 'OK', asset_id: assetId,
          record_id: recordId, affected_ids: [recordId], evidence_id: evidenceId, revision: 1, pending: false } }
      }, managed, { authorize: assertCurrent })
      if (result.status !== 'committed') return result
      return { ...result, asset: this.read(result.asset_id, context) }
    } finally { signals.forEach((signal) => signal.removeEventListener('abort', revoke)) }
  }
  #metadata(assetId, context) {
    assertId(assetId)
    if (!/^a-[a-f0-9]{20}$/.test(assetId)) return null
    const path = this.store.engine.resolvePath(`assets/${assetId}.json`)
    if (!existsSync(path)) return null
    const value = JSON.parse(readFileSync(path, 'utf8'))
    if (value.schema_version !== 1 || value.id !== assetId || IDENTITY.some((key) => value[key] !== context[key]) ||
      !/^[a-f0-9]{64}\.(png|jpg|jpeg|webp|gif)$/.test(value.file) || !MIME[value.mime] ||
      !Array.isArray(value.record_ids) || !value.record_ids.length || !Array.isArray(value.evidence_refs) || !value.evidence_refs.length) return null
    const records = value.record_ids.map((id) => this.store._readRecord(id))
    const evidence = value.evidence_refs.map((id) => JSON.parse(readFileSync(this.store.engine.resolvePath(`evidence/${assertId(id)}.json`), 'utf8')))
    validateAssetMetadata(value, { assetId, recordMetas: records.map((record) => record.meta), evidence })
    if (!records.every(({ meta }) => meta.status === 'active' && meta.type === 'meme' && IDENTITY.every((key) => meta[key] === context[key]) &&
      meta.asset_metadata_hash === digest(value) && meta.assets?.includes(assetId) && meta.assets?.includes(value.file) &&
      value.evidence_refs.every((ref) => meta.provenance_refs.includes(ref)))) return null
    const bytes = readFileSync(this.store.engine.resolvePath(`assets/${value.file}`))
    if (bytes.length !== value.bytes || digest(bytes) !== value.file.split('.')[0]) throw new MemoryError('EXTERNAL_ASSET_CHANGE')
    return value
  }
  read(assetId, context) {
    this.store._authorize(context, 'memory.read')
    try { return clone(this.#metadata(assetId, context)) } catch { return null }
  }
  async list({ asset_id, query = '', tag = '', limit = 5 } = {}, context) {
    this.store._authorize(context, 'memory.read')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10 || typeof query !== 'string' || query.length > 2000 || typeof tag !== 'string' || tag.length > 64) throw new MemoryError('INVALID_ASSET_QUERY')
    const queryWords = query ? assetQueryWords(query, { query: true }) : null
    return this.store.managedRead(this.#context(context), () => {
      const ids = asset_id ? [assertId(asset_id)] : readdirSync(this.store.paths.assets).filter((file) => /^a-[a-f0-9]{20}\.json$/.test(file)).map((file) => file.slice(0, -5))
      const items = []
      for (const id of ids) {
        const item = this.read(id, context)
        if (!item || tag && !item.tags.includes(tag) || queryWords && !matchesAssetQuery(item, queryWords)) continue
        items.push(item); if (items.length >= limit) break
      }
      return items
    })
  }
  evidenceAllowed(id, context, recordMeta) {
    try {
      this.store._authorize(context, 'memory.read')
      if (recordMeta?.type !== 'meme' || !recordMeta.provenance_refs?.includes(id)) return false
      return (recordMeta.assets ?? []).filter((ref) => /^a-[a-f0-9]{20}$/.test(ref)).some((assetId) => {
        const asset = this.#metadata(assetId, context)
        return asset?.evidence_refs.includes(id) && asset.record_ids.includes(recordMeta.record_id)
      })
    } catch { return false }
  }
}

export default MemoryAssetsV2
