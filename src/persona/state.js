import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { MEMORY_TYPES, MemoryError, assertId, assertOnly, digest, timestamp } from '../memory/v2/contracts.js'
import { deriveEventEvidenceId, normalizeHostEvent } from '../memory/v2/evidence.js'
import { getPersonaAnchor, personaBinding, normalizeIndividualKey, personaIdentityProjection, projectedIdentityBinding } from '../memory/v2/persona-ledger.js'
import { getPurgeState } from '../memory/v2/purge-ledger.js'
import { StabilityPolicy, STABILITY_MODES } from './stability.js'
import { isSelectionDecision } from '../memory/v2/selection.js'
import { isBatchSelectionDecision, deriveBatchItemId, normalizeMemorySlotKey } from '../memory/v2/selection-batch.js'
import { evidenceBinding, normalizedContentHash, rootTargetBinding, validateBoundItemPayload } from '../memory/v2/batch-bindings.js'
import { retentionBlockReason } from '../memory/v2/retention.js'
import { verifyMemoryReceipt } from './memory-receipt.js'

const json = (value) => `${JSON.stringify(value, null, 2)}\n`
const clone = (value) => JSON.parse(JSON.stringify(value))

/** Host adapter. This class is never exposed as a model tool. */
export class PersonaState {
  #store; #personaId; #subjectId; #coreVersion; #mode; #identity; #binding; #individualKey; #policy; #facade
  constructor({ store, persona_id, core_version, mode = 'auto', subject_id, individual_key = 'default' } = {}) {
    if (!store || typeof store.managedTransaction !== 'function') throw new MemoryError('TRUSTED_STORE_REQUIRED')
    this.#store = store; this.#personaId = assertId(persona_id); this.#subjectId = assertId(subject_id)
    if (typeof core_version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(core_version)) throw new MemoryError('INVALID_CORE_VERSION')
    if (!STABILITY_MODES.includes(mode)) throw new MemoryError('INVALID_MODE')
    this.#individualKey = normalizeIndividualKey(individual_key)
    this.#coreVersion = core_version; this.#mode = mode; this.#binding = personaBinding(persona_id, subject_id, this.#individualKey)
    this.#facade = Object.freeze({ getProfile: () => this.#readyPolicy().getProfile(), snapshot: () => this.#readyPolicy().snapshot(), flush: () => this.#readyPolicy().flush() })
  }
  #readyPolicy() { if (!this.#policy) throw new MemoryError('PERSONA_STATE_NOT_INITIALIZED'); return this.#policy }
  get identity() { if (!this.#identity) throw new MemoryError('PERSONA_STATE_NOT_INITIALIZED'); return this.#identity }
  get stabilityPolicy() { this.#readyPolicy(); return this.#facade }
  #base() { return `self/${this.identity.agent_identity_id}` }
  #anchor() { return getPersonaAnchor(this.#store.root, this.#store.memorySpaceId, this.#binding) }
  #hostContext(sessionId, expiresAt = null, identity = this.#identity) {
    return this.#store.issueContext({ ...identity, session_id: sessionId, capabilities: ['memory.manage'], expires_at: expiresAt })
  }
  issueContext(sessionId, capabilities = ['memory.read', 'memory.write']) {
    return this.#store.issueContext({ ...this.identity, session_id: assertId(sessionId), capabilities })
  }
  #authorize(ctx, capability) {
    this.#store._authorize(ctx, capability)
    if (['persona_id', 'agent_identity_id', 'subject_id'].some((key) => ctx[key] !== this.identity[key])) throw new MemoryError('PERSONA_CONTEXT_SCOPE')
  }
  async #restore(anchor) {
    const records = new Map(anchor.credentials.filter((v) => !anchor.revoked_ids.includes(v.evidence_id)).map((v) => [v.evidence_id, v]))
    return StabilityPolicy.restore(anchor.snapshot, { ...this.identity, mode: this.#mode, expected_generation: anchor.snapshot.generation,
      resolveEvidence: (id) => records.get(id), minimumMaturity: anchor.snapshot.counters })
  }
  async #rebuild(anchor) {
    const records = new Map(anchor.credentials.filter((v) => !anchor.revoked_ids.includes(v.evidence_id)).map((v) => [v.evidence_id, v]))
    const policy = new StabilityPolicy({ ...this.identity, mode: this.#mode, resolveEvidence: (id) => records.get(id) })
    for (const credential of records.values()) {
      if (credential.type === 'interaction' && credential.maturity_eligible) {
        const result = await policy.observeEvidence(credential.evidence_id)
        if (!result.accepted && !['duplicate_evidence', 'duplicate_event'].includes(result.reason)) throw new MemoryError('PERSONA_CREDENTIAL_REJECTED')
      } else if (credential.type === 'maintenance') await policy.observeMaintenance(credential.evidence_id)
    }
    const generation = Math.max(anchor.revision, (anchor.snapshot?.generation ?? 0) + 1, policy.snapshot().generation)
    const snapshot = { ...policy.snapshot(), generation }
    return StabilityPolicy.restore(snapshot, { ...this.identity, mode: this.#mode, resolveEvidence: (id) => records.get(id), expected_generation: generation })
  }
  #descriptor(anchor, previous) { return { expected_revision: previous?.revision ?? 0, anchor } }
  #changes(anchor, manifest, evidence = []) {
    return [...evidence, { path: `${this.#base()}/stability.json`, data: json({ ...anchor.snapshot, anchor_revision: anchor.revision }) },
      { path: 'manifest.json', data: json({ ...manifest, revision_watermark: manifest.revision_watermark + 1,
        identities: { ...(manifest.identities ?? {}), [anchor.agent_identity_id]: personaIdentityProjection(anchor) } }) }]
  }
  async initialize() {
    if (!this.#store.initialized) await this.#store.initialize()
    const provisional = { persona_id: this.#personaId, subject_id: this.#subjectId, agent_identity_id: `agent-${randomUUID()}` }
    const ctx = this.#hostContext(null, null, provisional)
    const result = await this.#store.managedTransaction(`persona-initialize-${randomUUID()}`, { action: 'personaInitialize', binding_id: this.#binding, mode: this.#mode }, async ({ manifest }) => {
      const previous = this.#anchor()
      if (!previous) {
        const matching = Object.entries(manifest.identities ?? {}).filter(([, v]) => v?.persona_id === this.#personaId && v?.subject_id === this.#subjectId)
        for (const [identityId, identity] of matching) {
          const binding = projectedIdentityBinding(identity), other = getPersonaAnchor(this.#store.root, this.#store.memorySpaceId, binding)
          if (binding === this.#binding || !other || other.agent_identity_id !== identityId) throw new MemoryError('PERSONA_ANCHOR_REQUIRED')
        }
      }
      const id = previous?.agent_identity_id ?? provisional.agent_identity_id
      this.#identity = Object.freeze({ persona_id: this.#personaId, agent_identity_id: id, subject_id: this.#subjectId, memory_space_id: this.#store.memorySpaceId })
      if (previous) {
        this.#policy = await this.#restore(previous)
        if (previous.snapshot.mode === this.#mode && previous.core_version === this.#coreVersion) return { changes: [], result: { status: 'ready', agent_identity_id: id, anchor_revision: previous.revision } }
      }
      const anchor = previous ? { ...previous, revision: previous.revision + 1, core_version: this.#coreVersion } : {
        schema_version: this.#individualKey === 'default' ? 1 : 3, memory_space_id: this.#store.memorySpaceId, binding_id: this.#binding, ...this.identity,
        ...(this.#individualKey === 'default' ? {} : { binding_scheme: 2, individual_key: this.#individualKey, items: [] }),
        core_version: this.#coreVersion, created_at: new Date().toISOString(), revision: 1, credentials: [], revoked_ids: [],
      }
      this.#policy = await this.#rebuild(anchor); anchor.snapshot = this.#policy.snapshot()
      return { changes: this.#changes(anchor, manifest), persona_descriptor: this.#descriptor(anchor, previous), result: { status: 'ready', agent_identity_id: id, anchor_revision: anchor.revision } }
    }, ctx)
    if (result.status !== 'ready') throw new MemoryError('PERSONA_INITIALIZE_FAILED')
    return this
  }
  #credentialEvidence(anchor, id) {
    if (!anchor || anchor.revoked_ids.includes(id)) return null
    const binding = evidenceBinding(anchor, id)
    if (binding?.event_evidence_id && anchor.revoked_ids.includes(binding.event_evidence_id)) return null
    return binding
  }
  #resolveEvidenceUnlocked(id) {
    assertId(id)
    const credential = this.#credentialEvidence(this.#anchor(), id)
    if (!credential || !credential.payload_hash || (!credential.event_evidence_id && credential.allow_persist !== true)) return null
    const purged = getPurgeState(this.#store.root, this.#store.memorySpaceId)
    if ([...purged.evidence_ids, ...purged.related_evidence_ids].includes(id)) return null
    const path = this.#store.engine.resolvePath(`${this.#base()}/evidence/${id}.json`)
    if (!existsSync(path)) return null
    let value
    try { value = JSON.parse(readFileSync(path, 'utf8')) } catch { throw new MemoryError('PERSONA_EVIDENCE_REPAIR_REQUIRED') }
    if (digest(value) !== credential.payload_hash) throw new MemoryError('EXTERNAL_PERSONA_EVIDENCE_CHANGE')
    if (credential.event_evidence_id) validateBoundItemPayload(this.#anchor(), credential, value)
    return clone(value)
  }
  resolveEvidence(id) {
    this.#readyPolicy()
    const before = this.#anchor(), purge = getPurgeState(this.#store.root, this.#store.memorySpaceId)
    const value = this.#resolveEvidenceUnlocked(id)
    if (before.revision !== this.#anchor()?.revision || purge.generation !== getPurgeState(this.#store.root, this.#store.memorySpaceId).generation) throw new MemoryError('PERSONA_EVIDENCE_BUSY')
    return value
  }
  resolveMemoryEvidence(id) {
    const value = this.resolveEvidence(id)
    return value ? { ...value, claim_kind: value.claim_kind === 'interaction_observation' ? 'tool_observation' : value.claim_kind } : null
  }
  async listEvidence({ limit = 32, growth_only = true } = {}) {
    this.#readyPolicy()
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 64 || typeof growth_only !== 'boolean') throw new MemoryError('INVALID_EVIDENCE_QUERY')
    return this.#store.managedRead(this.#hostContext(null), () => {
      const anchor = this.#anchor(), result = []
      if (limit === 0) return result
      for (const credential of [...anchor.credentials, ...(anchor.items ?? [])].reverse()) {
        const value = this.#resolveEvidenceUnlocked(credential.evidence_id)
        if (value && (!growth_only || value.growth_eligible === true)) result.push(value)
        if (result.length >= limit) break
      }
      return result.slice(0, limit)
    })
  }
  async listPendingMemories({ limit = 64, cursor = null } = {}) {
    this.#readyPolicy()
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64 || cursor !== null && typeof cursor !== 'string') throw new MemoryError('INVALID_PENDING_QUERY')
    return this.#store.managedRead(this.#hostContext(null), ({ records }) => {
      const anchor = this.#anchor(), purge = getPurgeState(this.#store.root, this.#store.memorySpaceId)
      const credentials = [...anchor.credentials.filter((entry) => entry.plan_version !== 2), ...(anchor.items ?? [])].sort((a, b) => a.evidence_id.localeCompare(b.evidence_id))
      const position = cursor === null ? -1 : credentials.findIndex((entry) => entry.evidence_id === cursor)
      if (cursor !== null && position < 0) throw new MemoryError('INVALID_PENDING_CURSOR')
      const page = credentials.slice(position + 1, position + 1 + limit), items = [], historyCache = new Map()
      for (const credential of page) {
        if (!credential.event_evidence_id && (!credential.allow_persist || credential.type !== 'interaction')) continue
        if (credential.outbox_outcome || credential.event_evidence_id && anchor.revoked_ids.includes(credential.event_evidence_id)) continue
        // Management revocation is authoritative even when its original text
        // and proposal have been erased; no receipt is trusted in this branch.
        if (anchor.revoked_ids.includes(credential.evidence_id) || [...purge.evidence_ids, ...purge.related_evidence_ids].includes(credential.evidence_id)) continue
        const value = this.#resolveEvidenceUnlocked(credential.evidence_id)
        if (!value?.memory_proposal) throw new MemoryError('PERSONA_EVIDENCE_REPAIR_REQUIRED')
        const operationId = credential.operation_id ?? `memory-event-${credential.evidence_id}`
        const receiptPath = this.#store.engine.resolvePath(`operations/${digest(operationId)}.json`)
        if (existsSync(receiptPath)) {
          try {
            const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
            const recordMeta = this.#store._readRecord(receipt.result?.record_id, receipt.result?.revision_id).meta
            verifyMemoryReceipt(receipt, { args: { ...value.memory_proposal, operation_id: operationId }, identity: this.identity, recordMeta, ...(credential.event_evidence_id ? { targetBinding: value.target_binding } : {}) })
          } catch { throw new MemoryError('MEMORY_RECEIPT_REPAIR_REQUIRED') }
          continue
        }
        if (this.#sourceWasStored(value, records, historyCache)) continue
        items.push({ ...value, operation_id: operationId })
      }
      return { items, cursor: position + 1 + page.length < credentials.length ? page.at(-1).evidence_id : null }
    })
  }
  async refresh() {
    await this.#store.managedRead(this.#hostContext(null), async () => { this.#policy = await this.#restore(this.#anchor()) })
    return this.#policy.getProfile()
  }
  #sourceWasStored(value, records, cache) {
    const proposal = value.memory_proposal
    const own = (meta) => meta.memory_space_id === this.#store.memorySpaceId && meta.persona_id === this.identity.persona_id && meta.agent_identity_id === this.identity.agent_identity_id && meta.subject_id === this.identity.subject_id
    const matches = (record) => own(record.meta) && record.meta.type === proposal.type && (record.meta.canonical_key ?? null) === (proposal.canonical_key ?? null) && record.meta.provenance_refs?.includes(value.evidence_id) && record.detail === proposal.content.trim()
    const read = (id, revision = null) => {
      const key = `${id}/${revision ?? 'current'}`
      if (!cache.has(key)) { try { cache.set(key, this.#store._readRecord(id, revision)) } catch { throw new MemoryError('MEMORY_RECEIPT_REPAIR_REQUIRED') } }
      return cache.get(key)
    }
    const scoped = records.filter(own)
    for (const meta of scoped) if (meta.provenance_refs?.includes(value.evidence_id) && matches(read(meta.record_id))) return true
    for (const meta of scoped) {
      if (!Array.isArray(meta.revision_history ?? [])) throw new MemoryError('MEMORY_RECEIPT_REPAIR_REQUIRED')
      for (const previous of meta.revision_history ?? []) if (matches(read(meta.record_id, previous.revision_id))) return true
    }
    return false
  }
  #batchView(anchor, credential, records = []) {
    const legacy = credential.plan_version !== 2
    const ids = legacy ? (credential.allow_persist ? [credential.evidence_id] : []) : credential.item_ids
    const purge = getPurgeState(this.#store.root, this.#store.memorySpaceId)
    const historyCache = new Map()
    const items = ids.map((id) => {
      const binding = evidenceBinding(anchor, id), operationId = binding.operation_id ?? `memory-event-${id}`
      if (anchor.revoked_ids.includes(id) || anchor.revoked_ids.includes(credential.evidence_id)) return { evidence_id: id, operation_id: operationId, status: 'revoked', reason_code: 'EVIDENCE_REVOKED' }
      if ([...purge.evidence_ids, ...purge.related_evidence_ids].includes(id)) return { evidence_id: id, operation_id: operationId, status: 'purged', reason_code: 'EVIDENCE_PURGED' }
      if (binding.outbox_outcome) return { evidence_id: id, operation_id: operationId, ...binding.outbox_outcome }
      const value = this.#resolveEvidenceUnlocked(id)
      if (!value) throw new MemoryError('PERSONA_EVIDENCE_REPAIR_REQUIRED')
      const receipt = this.#store.engine.resolvePath(`operations/${digest(operationId)}.json`)
      if (!existsSync(receipt) && this.#sourceWasStored(value, records, historyCache)) return { evidence_id: id, operation_id: operationId, status: 'ignored', reason_code: 'SOURCE_ALREADY_COMMITTED' }
      return { ...value, operation_id: operationId, status: 'approved' }
    })
    return { batch_version: legacy ? 0 : 1, status: anchor.revoked_ids.includes(credential.evidence_id) ? 'revoked' : ids.length ? 'recorded' : credential.maturity_eligible ? 'qualified' : 'ignore',
      event_evidence_id: credential.evidence_id, event_maturity_eligible: credential.maturity_eligible === true && !anchor.revoked_ids.includes(credential.evidence_id), duplicate_content: credential.duplicate_content === true, items }
  }
  async getCommittedBatch(eventOrId) {
    this.#readyPolicy()
    const event = typeof eventOrId === 'string' ? null : normalizeHostEvent(eventOrId, this.identity)
    const id = event ? deriveEventEvidenceId(event) : assertId(eventOrId)
    return this.#store.managedRead(this.#hostContext(null), ({ records }) => {
      const anchor = this.#anchor(), credential = anchor.credentials.find((entry) => entry.type === 'interaction' && entry.evidence_id === id)
      if (!credential) return null
      if (event && credential.source_hash !== digest(event)) throw new MemoryError('PERSONA_EVENT_CONFLICT')
      return this.#batchView(anchor, credential, records)
    })
  }
  async commitSelectionBatch(record, decision, ctx) {
    this.#authorize(ctx, 'memory.write')
    const event = normalizeHostEvent(record, this.identity)
    if (event.content.length > 8000 || ctx.session_id !== event.session_id) throw new MemoryError('PERSONA_SESSION_SCOPE')
    if (!isBatchSelectionDecision(decision)) throw new MemoryError('UNTRUSTED_SELECTION_DECISION')
    const denied = retentionBlockReason(record.content, { nonRetention: record.non_retention === true, sensitive: record.sensitive === true })
    if (decision.decision === 'reject' || denied) return { batch_version: 1, status: 'reject', reason_code: denied ?? decision.reason_code, event_evidence_id: null, items: [] }
    const eventId = deriveEventEvidenceId(event)
    if (decision.decision === 'ignore' && decision.event_evidence_id === undefined && decision.items?.length === 0) return { batch_version: 1, status: 'ignore', reason_code: decision.reason_code, event_evidence_id: null, items: [] }
    if (decision.event_evidence_id !== eventId || decision.batch_version !== 1 || !Array.isArray(decision.items) || decision.items.length > 4 || typeof decision.event_maturity_eligible !== 'boolean') throw new MemoryError('INVALID_BATCH_SELECTION')
    const existing = await this.getCommittedBatch(event)
    this.#authorize(ctx, 'memory.write')
    if (existing) return { ...existing, replayed: true }
    const spans = [], quotes = new Set(), targets = new Set(), keys = new Set()
    let units = 0
    for (const item of decision.items) {
      const evidence = item.evidence, start = evidence?.span_start, end = evidence?.span_end
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > event.content.length || end - start > 800 || evidence.content !== event.content.slice(start,end) || quotes.has(evidence.content) || spans.some(([a,b]) => start < b && end > a)) throw new MemoryError('BATCH_INVALID_EXACT_SPAN')
      spans.push([start,end]); quotes.add(evidence.content); units += end-start
      if (units > 1600) throw new MemoryError('BATCH_TOTAL_QUOTE_BUDGET_EXCEEDED')
      for (const key of ['event_id','message_id','session_id','occurred_at','subject_id','persona_id','agent_identity_id','source','claim_kind']) if (evidence[key] !== event[key]) throw new MemoryError('SELECTION_EVIDENCE_CONFLICT')
      if (evidence.independence_key !== event.event_id || evidence.maturity_eligible !== false || item.operation_id !== `memory-item-${item.evidence_id}` || evidence.evidence_id !== item.evidence_id) throw new MemoryError('INVALID_BATCH_SELECTION')
      if (!item.allow_persist) continue
      const proposal = item.proposal
      if (!proposal || !MEMORY_TYPES.includes(proposal.type) || proposal.subject_id !== event.subject_id || proposal.content !== evidence.content || proposal.gist !== evidence.content || proposal.provenance_refs?.length !== 1 || proposal.provenance_refs[0] !== item.evidence_id || deriveBatchItemId(event,{span_start:start,span_end:end,type:proposal.type,canonical_key:proposal.canonical_key??null}) !== item.evidence_id) throw new MemoryError('SELECTION_PROPOSAL_CONFLICT')
      rootTargetBinding(item.target_binding)
      if (item.target_binding) {
        if (targets.has(item.target_binding.record_id) || proposal.type !== item.target_binding.type || (proposal.canonical_key??null) !== item.target_binding.canonical_key) throw new MemoryError('BATCH_DUPLICATE_TARGET')
        targets.add(item.target_binding.record_id)
      }
      if (proposal.canonical_key !== null && proposal.canonical_key !== undefined) {
        const key = `${proposal.type}\0${normalizeMemorySlotKey(proposal.canonical_key) ?? proposal.canonical_key}`
        if (keys.has(key)) throw new MemoryError('BATCH_DUPLICATE_SLOT')
        keys.add(key)
      }
    }
    const contentHash = normalizedContentHash(event.content)
    const result = await this.#store.managedTransaction(`persona-batch-${eventId}`, { action:'commitSelectionBatch', event_id:eventId, source_hash:digest(event), selection_hash:digest(decision) }, async ({manifest}) => {
      this.#authorize(ctx,'memory.write')
      const previous = this.#anchor(), old = previous.credentials.find((entry) => entry.evidence_id === eventId || entry.independence_key === event.event_id)
      if (old) throw new MemoryError('PERSONA_EVENT_CONFLICT')
      const duplicate = previous.credentials.some((entry) => entry.normalized_content_hash === contentHash)
      const files = [], bindings = []
      for (const item of decision.items.filter((entry) => entry.allow_persist)) {
        const full = { ...item.evidence, type:'interaction', memory_space_id:this.#store.memorySpaceId, event_evidence_id:eventId,
          allow_persist:true, growth_eligible:item.growth_eligible === true && !duplicate, maturity_eligible:false,
          operation_id:item.operation_id, target_binding:clone(item.target_binding), memory_proposal:clone(item.proposal) }
        const binding = { evidence_id:item.evidence_id, event_evidence_id:eventId, operation_id:item.operation_id, payload_hash:digest(full),
          span_start:full.span_start, span_end:full.span_end, target_binding:rootTargetBinding(full.target_binding) }
        bindings.push(binding); files.push({path:`${this.#base()}/evidence/${item.evidence_id}.json`,data:json(full)})
      }
      const credential = { evidence_id:eventId,type:'interaction',persona_id:event.persona_id,agent_identity_id:event.agent_identity_id,
        independence_key:event.event_id,session_id:event.session_id,message_id:event.message_id,occurred_at:event.occurred_at,source:event.source,claim_kind:event.claim_kind,
        allow_persist:false,growth_eligible:false,maturity_eligible:decision.event_maturity_eligible && !duplicate,source_hash:digest(event),
        plan_version:2,item_ids:bindings.map((item)=>item.evidence_id),plan_hash:digest({selection:decision,bindings}),normalized_content_hash:contentHash,
        duplicate_content:duplicate,plan_decision:decision.decision === 'selected'?'selected':'ignore',reason_code:decision.reason_code,content_units:event.content.length }
      const anchor = { ...previous,schema_version:Math.max(2,previous.schema_version),revision:previous.revision+1,credentials:[...previous.credentials,credential],items:[...(previous.items??[]),...bindings] }
      anchor.snapshot=(await this.#rebuild(anchor)).snapshot()
      this.#authorize(ctx,'memory.write')
      return {changes:this.#changes(anchor,manifest,files),persona_descriptor:this.#descriptor(anchor,previous),result:{status:'recorded',event_evidence_id:eventId,item_ids:credential.item_ids}}
    },this.#hostContext(ctx.session_id,ctx.expires_at),{authorize:()=>this.#authorize(ctx,'memory.write')})
    await this.refresh()
    return {...await this.getCommittedBatch(event),...(result.replayed?{replayed:true}:{})}
  }
  async recordItemOutcome(id, outcome, ctx) {
    this.#authorize(ctx,'memory.write');assertId(id)
    assertOnly(outcome,['status','reason_code','observed_revision'])
    if (!['terminal_conflict','ignored'].includes(outcome.status)) throw new MemoryError('INVALID_ITEM_OUTCOME')
    return this.#store.managedTransaction(`persona-item-outcome-${id}`,{action:'recordItemOutcome',evidence_id:id,outcome},({manifest,records})=>{
      this.#authorize(ctx,'memory.write')
      const previous=this.#anchor(),binding=(previous.items??[]).find((item)=>item.evidence_id===id)
      if(!binding)throw new MemoryError('ITEM_NOT_FOUND')
      if(binding.outbox_outcome)return{changes:[],result:{...binding.outbox_outcome,evidence_id:id,operation_id:binding.operation_id,replayed:true}}
      const value=this.#resolveEvidenceUnlocked(id)
      if(!value)throw new MemoryError('ITEM_UNAVAILABLE')
      const receiptPath=this.#store.engine.resolvePath(`operations/${digest(binding.operation_id)}.json`)
      if(existsSync(receiptPath)){
        const receipt=JSON.parse(readFileSync(receiptPath,'utf8')),recordMeta=this.#store._readRecord(receipt.result?.record_id,receipt.result?.revision_id).meta
        const checked=verifyMemoryReceipt(receipt,{args:{...value.memory_proposal,operation_id:binding.operation_id},identity:this.identity,recordMeta,targetBinding:value.target_binding})
        return{changes:[],result:{...checked,evidence_id:id}}
      }
      const target=value.target_binding,own=(meta)=>meta.memory_space_id===this.#store.memorySpaceId&&meta.persona_id===this.identity.persona_id&&meta.agent_identity_id===this.identity.agent_identity_id&&meta.subject_id===this.identity.subject_id
      let observed,reason
      if(target){
        observed=records.find((meta)=>meta.record_id===target.record_id)
        if(!observed){
          if(!getPurgeState(this.#store.root,this.#store.memorySpaceId).record_ids.includes(target.record_id))throw new MemoryError('TARGET_UNAVAILABLE')
          reason='TARGET_UNAVAILABLE';observed={record_id:target.record_id,revision:0}
        }else if(observed.revision!==target.expected_revision)reason='TARGET_REVISION_CHANGED'
        else if(!own(observed)||observed.status!=='active'||observed.visibility?.kind!=='private'||observed.type!==target.type||(observed.canonical_key??null)!==target.canonical_key)reason='TARGET_UNAVAILABLE'
        else if(outcome.status==='ignored'){
          const record=this.#store._readRecord(observed.record_id)
          if(record.detail!==value.memory_proposal.content.trim())throw new MemoryError('ITEM_OUTCOME_UNPROVEN')
          reason='ALREADY_CURRENT'
        }else throw new MemoryError('ITEM_OUTCOME_UNPROVEN')
      }else{
        const key=value.memory_proposal.canonical_key
        observed=records.find((meta)=>own(meta)&&meta.status==='active'&&meta.type===value.memory_proposal.type&&key!==null&&key!==undefined&&(normalizeMemorySlotKey(meta.canonical_key)??meta.canonical_key)===(normalizeMemorySlotKey(key)??key))
        if(!observed)throw new MemoryError('ITEM_OUTCOME_UNPROVEN')
        reason='SLOT_ALREADY_EXISTS'
      }
      if(outcome.observed_revision!==undefined&&outcome.observed_revision!==observed.revision)throw new MemoryError('ITEM_OUTCOME_UNPROVEN')
      if(outcome.status==='terminal_conflict'&&outcome.reason_code!==reason||outcome.status==='ignored'&&reason!=='ALREADY_CURRENT')throw new MemoryError('ITEM_OUTCOME_UNPROVEN')
      const terminal={status:outcome.status,reason_code:reason,observed_record_id:observed.record_id,observed_revision:observed.revision}
      const anchor={...previous,revision:previous.revision+1,items:previous.items.map((item)=>item.evidence_id===id?{...item,outbox_outcome:terminal}:item)}
      return{changes:this.#changes(anchor,manifest),persona_descriptor:this.#descriptor(anchor,previous),result:{...terminal,evidence_id:id,operation_id:binding.operation_id}}
    },this.#hostContext(ctx.session_id,ctx.expires_at),{authorize:()=>this.#authorize(ctx,'memory.write')})
  }
  async commitInteraction(record, decision, ctx) {
    this.#authorize(ctx, 'memory.write')
    const event = normalizeHostEvent(record, this.identity)
    if (ctx.session_id !== event.session_id) throw new MemoryError('PERSONA_SESSION_SCOPE')
    if (!isSelectionDecision(decision)) throw new MemoryError('UNTRUSTED_SELECTION_DECISION')
    const blocked = retentionBlockReason(record.content, { nonRetention: record.non_retention === true, sensitive: record.sensitive === true })
    if (blocked) return { status: 'reject', reason_code: blocked, evidence_id: null }
    if (!decision || !['reject', 'ignore', 'temporary', 'long_term'].includes(decision.decision)) throw new MemoryError('INVALID_SELECTION_DECISION')
    if (decision.decision === 'reject' || (!decision.allow_persist && !decision.maturity_eligible)) return { status: decision.decision, reason_code: decision.reason_code, evidence_id: null }
    if (decision.growth_eligible && !decision.allow_persist) throw new MemoryError('INVALID_GROWTH_ELIGIBILITY')
    const evidenceId = deriveEventEvidenceId(event), supplied = decision.evidence
    if (!supplied || supplied.evidence_id !== evidenceId || supplied.independence_key !== event.event_id || typeof supplied.content !== 'string' || !supplied.content.trim() || !event.content.includes(supplied.content)) throw new MemoryError('SELECTION_EVIDENCE_CONFLICT')
    for (const key of ['event_id', 'message_id', 'session_id', 'occurred_at', 'subject_id', 'persona_id', 'agent_identity_id', 'source', 'claim_kind']) if (supplied[key] !== event[key]) throw new MemoryError('SELECTION_EVIDENCE_CONFLICT')
    const full = { ...supplied, ...event, content: supplied.content, evidence_id: evidenceId, type: 'interaction',
      subject_ids: [event.subject_id], actor_ids: event.actor_ids, observed_at: event.occurred_at,
      allow_persist: decision.allow_persist === true, growth_eligible: decision.growth_eligible === true, maturity_eligible: decision.maturity_eligible === true }
    if (full.allow_persist) {
      const proposal = decision.proposal
      if (!proposal || proposal.subject_id !== event.subject_id || proposal.content !== supplied.content || proposal.gist !== supplied.content || proposal.provenance_refs?.length !== 1 || proposal.provenance_refs[0] !== evidenceId) throw new MemoryError('SELECTION_PROPOSAL_CONFLICT')
      full.memory_proposal = clone(proposal)
    }
    const credential = { evidence_id: evidenceId, type: 'interaction', persona_id: event.persona_id, agent_identity_id: event.agent_identity_id,
      independence_key: event.event_id, session_id: event.session_id, occurred_at: event.occurred_at, source: event.source, claim_kind: event.claim_kind,
      allow_persist: full.allow_persist, growth_eligible: full.growth_eligible, maturity_eligible: full.maturity_eligible,
      source_hash: digest(event), ...(full.allow_persist ? { payload_hash: digest(full) } : {}) }
    const operationId = `persona-interaction-${evidenceId}`
    const result = await this.#store.managedTransaction(operationId, { action: 'commitInteraction', credential }, async ({ manifest }) => {
      this.#authorize(ctx, 'memory.write')
      const previous = this.#anchor()
      if (previous.revoked_ids.includes(evidenceId)) throw new MemoryError('EVIDENCE_REVOKED')
      const purged = getPurgeState(this.#store.root, this.#store.memorySpaceId)
      if ([...purged.evidence_ids, ...purged.related_evidence_ids].includes(evidenceId)) throw new MemoryError('EVIDENCE_PURGED')
      const existing = previous.credentials.find((v) => v.evidence_id === evidenceId || v.independence_key === event.event_id)
      if (existing && existing.source_hash !== credential.source_hash) throw new MemoryError('PERSONA_EVENT_CONFLICT')
      if (existing) return { changes: [], result: { status: 'recorded', evidence_id: evidenceId, anchor_revision: previous.revision } }
      const normalized = normalizedContentHash(event.content), duplicate = previous.credentials.some((entry) => entry.normalized_content_hash === normalized)
      const approved = { ...full, growth_eligible: full.growth_eligible && !duplicate, maturity_eligible: full.maturity_eligible && !duplicate }
      const storedCredential = { ...credential, normalized_content_hash: normalized, duplicate_content: duplicate, growth_eligible: approved.growth_eligible, maturity_eligible: approved.maturity_eligible,
        ...(approved.allow_persist ? { payload_hash: digest(approved) } : {}) }
      const anchor = { ...previous, schema_version: Math.max(2, previous.schema_version), items: previous.items ?? [], revision: previous.revision + 1, credentials: [...previous.credentials, storedCredential] }
      const policy = await this.#rebuild(anchor); anchor.snapshot = policy.snapshot()
      this.#authorize(ctx, 'memory.write')
      return { changes: this.#changes(anchor, manifest, approved.allow_persist ? [{ path: `${this.#base()}/evidence/${evidenceId}.json`, data: json(approved) }] : []),
        persona_descriptor: this.#descriptor(anchor, previous), result: { status: full.allow_persist ? 'recorded' : 'qualified', evidence_id: evidenceId, anchor_revision: anchor.revision } }
    }, this.#hostContext(ctx.session_id, ctx.expires_at), { authorize: () => this.#authorize(ctx, 'memory.write') })
    await this.refresh()
    if (this.#anchor().revoked_ids.includes(evidenceId)) return { status: 'revoked', evidence_id: evidenceId, reason_code: 'EVIDENCE_REVOKED', replayed: result.replayed === true }
    if (getPurgeState(this.#store.root, this.#store.memorySpaceId).related_evidence_ids.includes(evidenceId)) return { status: 'purged', evidence_id: evidenceId, reason_code: 'EVIDENCE_PURGED', replayed: result.replayed === true }
    return result
  }
  async commitMaintenance(record, ctx) {
    this.#authorize(ctx, 'self.evaluate')
    if (record?.type !== 'maintenance' || (typeof record.source === 'object' ? record.source.kind : record.source) !== 'host' || record.claim_kind !== 'maintenance' || record.completed !== true) throw new MemoryError('TRUSTED_MAINTENANCE_REQUIRED')
    for (const key of ['persona_id', 'agent_identity_id']) if (record[key] !== this.identity[key]) throw new MemoryError('PERSONA_EVENT_SCOPE')
    const id = assertId(record.evidence_id), occurredAt = timestamp(record.occurred_at, 'maintenance time', false)
    const full = { evidence_id: id, type: 'maintenance', source: 'host', claim_kind: 'maintenance', completed: true,
      persona_id: this.#personaId, agent_identity_id: this.identity.agent_identity_id, occurred_at: occurredAt, allow_persist: true }
    const credential = { ...full, payload_hash: digest(full) }
    const result = await this.#store.managedTransaction(`persona-maintenance-${id}`, { action: 'commitMaintenance', credential }, async ({ manifest }) => {
      this.#authorize(ctx, 'self.evaluate')
      const previous = this.#anchor()
      if (previous.revoked_ids.includes(id)) throw new MemoryError('EVIDENCE_REVOKED')
      const existing = previous.credentials.find((v) => v.evidence_id === id)
      if (existing && digest(existing) !== digest(credential)) throw new MemoryError('PERSONA_EVENT_CONFLICT')
      if (existing) return { changes: [], result: { status: 'recorded', evidence_id: id, anchor_revision: previous.revision } }
      const anchor = { ...previous, revision: previous.revision + 1, credentials: [...previous.credentials, credential] }
      anchor.snapshot = (await this.#rebuild(anchor)).snapshot()
      this.#authorize(ctx, 'self.evaluate')
      return { changes: this.#changes(anchor, manifest, [{ path: `${this.#base()}/evidence/${id}.json`, data: json(full) }]), persona_descriptor: this.#descriptor(anchor, previous), result: { status: 'recorded', evidence_id: id, anchor_revision: anchor.revision } }
    }, this.#hostContext(ctx.session_id, ctx.expires_at), { authorize: () => this.#authorize(ctx, 'self.evaluate') })
    await this.refresh()
    if (this.#anchor().revoked_ids.includes(id)) return { status: 'revoked', evidence_id: id, reason_code: 'EVIDENCE_REVOKED', replayed: result.replayed === true }
    return result
  }
  async revokeEvidence(id, ctx) {
    this.#authorize(ctx, 'memory.manage'); assertId(id)
    const result = await this.#store.managedTransaction(`persona-revoke-${id}`, { action: 'revokeEvidence', evidence_id: id }, async ({ manifest }) => {
      this.#authorize(ctx, 'memory.manage')
      const previous = this.#anchor()
      if (!previous.credentials.some((v) => v.evidence_id === id) && !(previous.items ?? []).some((v) => v.evidence_id === id)) throw new MemoryError('EVIDENCE_NOT_FOUND')
      const children = (previous.items ?? []).filter((item) => item.event_evidence_id === id).map((item) => item.evidence_id)
      const anchor = { ...previous, revision: previous.revision + 1, revoked_ids: [...new Set([...previous.revoked_ids, id, ...children])] }
      anchor.snapshot = (await this.#rebuild(anchor)).snapshot()
      return { changes: this.#changes(anchor, manifest, [{ path: `${this.#base()}/evidence/${id}.json`, data: null }]), persona_descriptor: this.#descriptor(anchor, previous), result: { status: 'revoked', evidence_id: id, anchor_revision: anchor.revision } }
    }, this.#hostContext(ctx.session_id, ctx.expires_at), { authorize: () => this.#authorize(ctx, 'memory.manage') })
    await this.refresh(); return result
  }
}
export default PersonaState
