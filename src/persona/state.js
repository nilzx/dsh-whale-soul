import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { MemoryError, assertId, digest, timestamp } from '../memory/v2/contracts.js'
import { deriveEventEvidenceId, normalizeHostEvent } from '../memory/v2/evidence.js'
import { getPersonaAnchor, personaBinding } from '../memory/v2/persona-ledger.js'
import { getPurgeState } from '../memory/v2/purge-ledger.js'
import { StabilityPolicy, STABILITY_MODES } from './stability.js'
import { isSelectionDecision } from '../memory/v2/selection.js'
import { verifyMemoryReceipt } from './memory-receipt.js'

const json = (value) => `${JSON.stringify(value, null, 2)}\n`
const clone = (value) => JSON.parse(JSON.stringify(value))

/** Host adapter. This class is never exposed as a model tool. */
export class PersonaState {
  #store; #personaId; #subjectId; #coreVersion; #mode; #identity; #binding; #policy; #facade
  constructor({ store, persona_id, core_version, mode = 'auto', subject_id } = {}) {
    if (!store || typeof store.managedTransaction !== 'function') throw new MemoryError('TRUSTED_STORE_REQUIRED')
    this.#store = store; this.#personaId = assertId(persona_id); this.#subjectId = assertId(subject_id)
    if (typeof core_version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(core_version)) throw new MemoryError('INVALID_CORE_VERSION')
    if (!STABILITY_MODES.includes(mode)) throw new MemoryError('INVALID_MODE')
    this.#coreVersion = core_version; this.#mode = mode; this.#binding = personaBinding(persona_id, subject_id)
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
        identities: { ...(manifest.identities ?? {}), [anchor.agent_identity_id]: { persona_id: anchor.persona_id, subject_id: anchor.subject_id, agent_identity_id: anchor.agent_identity_id, created_at: anchor.created_at } } }) }]
  }
  async initialize() {
    if (!this.#store.initialized) await this.#store.initialize()
    const provisional = { persona_id: this.#personaId, subject_id: this.#subjectId, agent_identity_id: `agent-${randomUUID()}` }
    const ctx = this.#hostContext(null, null, provisional)
    const result = await this.#store.managedTransaction(`persona-initialize-${randomUUID()}`, { action: 'personaInitialize', binding_id: this.#binding, mode: this.#mode }, async ({ manifest }) => {
      const previous = this.#anchor()
      if (!previous) {
        const matching = Object.entries(manifest.identities ?? {}).filter(([, v]) => v?.persona_id === this.#personaId && v?.subject_id === this.#subjectId)
        if (matching.length) throw new MemoryError('PERSONA_ANCHOR_REQUIRED')
      }
      const id = previous?.agent_identity_id ?? provisional.agent_identity_id
      this.#identity = Object.freeze({ persona_id: this.#personaId, agent_identity_id: id, subject_id: this.#subjectId, memory_space_id: this.#store.memorySpaceId })
      if (previous) {
        this.#policy = await this.#restore(previous)
        if (previous.snapshot.mode === this.#mode && previous.core_version === this.#coreVersion) return { changes: [], result: { status: 'ready', agent_identity_id: id, anchor_revision: previous.revision } }
      }
      const anchor = previous ? { ...previous, revision: previous.revision + 1, core_version: this.#coreVersion } : {
        schema_version: 1, memory_space_id: this.#store.memorySpaceId, binding_id: this.#binding, ...this.identity,
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
    return anchor.credentials.find((v) => v.evidence_id === id) ?? null
  }
  #resolveEvidenceUnlocked(id) {
    assertId(id)
    const credential = this.#credentialEvidence(this.#anchor(), id)
    if (!credential || !credential.payload_hash || credential.allow_persist !== true) return null
    const purged = getPurgeState(this.#store.root, this.#store.memorySpaceId)
    if ([...purged.evidence_ids, ...purged.related_evidence_ids].includes(id)) return null
    const path = this.#store.engine.resolvePath(`${this.#base()}/evidence/${id}.json`)
    if (!existsSync(path)) return null
    let value
    try { value = JSON.parse(readFileSync(path, 'utf8')) } catch { throw new MemoryError('PERSONA_EVIDENCE_REPAIR_REQUIRED') }
    if (digest(value) !== credential.payload_hash) throw new MemoryError('EXTERNAL_PERSONA_EVIDENCE_CHANGE')
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
      for (const credential of [...anchor.credentials].reverse()) {
        if (growth_only && credential.growth_eligible !== true) continue
        const value = this.#resolveEvidenceUnlocked(credential.evidence_id)
        if (value) result.push(value)
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
      const credentials = [...anchor.credentials].sort((a, b) => a.evidence_id.localeCompare(b.evidence_id))
      const position = cursor === null ? -1 : credentials.findIndex((entry) => entry.evidence_id === cursor)
      if (cursor !== null && position < 0) throw new MemoryError('INVALID_PENDING_CURSOR')
      const page = credentials.slice(position + 1, position + 1 + limit), items = []
      for (const credential of page) {
        if (!credential.allow_persist || credential.type !== 'interaction') continue
        // Management revocation is authoritative even when its original text
        // and proposal have been erased; no receipt is trusted in this branch.
        if (anchor.revoked_ids.includes(credential.evidence_id) || [...purge.evidence_ids, ...purge.related_evidence_ids].includes(credential.evidence_id)) continue
        const value = this.#resolveEvidenceUnlocked(credential.evidence_id)
        if (!value?.memory_proposal) throw new MemoryError('PERSONA_EVIDENCE_REPAIR_REQUIRED')
        const operationId = `memory-event-${credential.evidence_id}`
        const receiptPath = this.#store.engine.resolvePath(`operations/${digest(operationId)}.json`)
        if (existsSync(receiptPath)) {
          try {
            const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
            const recordMeta = this.#store._readRecord(receipt.result?.record_id, receipt.result?.revision_id).meta
            verifyMemoryReceipt(receipt, { args: { ...value.memory_proposal, operation_id: operationId }, identity: this.identity, recordMeta })
          } catch { throw new MemoryError('MEMORY_RECEIPT_REPAIR_REQUIRED') }
          continue
        }
        if (records.some((meta) => meta.agent_identity_id === this.identity.agent_identity_id && meta.persona_id === this.identity.persona_id && meta.subject_id === this.identity.subject_id && meta.provenance_refs?.includes(credential.evidence_id))) continue
        items.push(value)
      }
      return { items, cursor: position + 1 + page.length < credentials.length ? page.at(-1).evidence_id : null }
    })
  }
  async refresh() {
    await this.#store.managedRead(this.#hostContext(null), async () => { this.#policy = await this.#restore(this.#anchor()) })
    return this.#policy.getProfile()
  }
  async commitInteraction(record, decision, ctx) {
    this.#authorize(ctx, 'memory.write')
    const event = normalizeHostEvent(record, this.identity)
    if (ctx.session_id !== event.session_id) throw new MemoryError('PERSONA_SESSION_SCOPE')
    if (!isSelectionDecision(decision)) throw new MemoryError('UNTRUSTED_SELECTION_DECISION')
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
      if (existing && digest(existing) !== digest(credential)) throw new MemoryError('PERSONA_EVENT_CONFLICT')
      if (existing) return { changes: [], result: { status: 'recorded', evidence_id: evidenceId, anchor_revision: previous.revision } }
      const anchor = { ...previous, revision: previous.revision + 1, credentials: [...previous.credentials, credential] }
      const policy = await this.#rebuild(anchor); anchor.snapshot = policy.snapshot()
      this.#authorize(ctx, 'memory.write')
      return { changes: this.#changes(anchor, manifest, full.allow_persist ? [{ path: `${this.#base()}/evidence/${evidenceId}.json`, data: json(full) }] : []),
        persona_descriptor: this.#descriptor(anchor, previous), result: { status: full.allow_persist ? 'recorded' : 'qualified', evidence_id: evidenceId, anchor_revision: anchor.revision } }
    }, this.#hostContext(ctx.session_id, ctx.expires_at))
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
    }, this.#hostContext(ctx.session_id, ctx.expires_at))
    await this.refresh()
    if (this.#anchor().revoked_ids.includes(id)) return { status: 'revoked', evidence_id: id, reason_code: 'EVIDENCE_REVOKED', replayed: result.replayed === true }
    return result
  }
  async revokeEvidence(id, ctx) {
    this.#authorize(ctx, 'memory.manage'); assertId(id)
    const result = await this.#store.managedTransaction(`persona-revoke-${id}`, { action: 'revokeEvidence', evidence_id: id }, async ({ manifest }) => {
      this.#authorize(ctx, 'memory.manage')
      const previous = this.#anchor()
      if (!previous.credentials.some((v) => v.evidence_id === id)) throw new MemoryError('EVIDENCE_NOT_FOUND')
      const anchor = { ...previous, revision: previous.revision + 1, revoked_ids: [...new Set([...previous.revoked_ids, id])] }
      anchor.snapshot = (await this.#rebuild(anchor)).snapshot()
      return { changes: this.#changes(anchor, manifest, [{ path: `${this.#base()}/evidence/${id}.json`, data: null }]), persona_descriptor: this.#descriptor(anchor, previous), result: { status: 'revoked', evidence_id: id, anchor_revision: anchor.revision } }
    }, this.#hostContext(ctx.session_id, ctx.expires_at))
    await this.refresh(); return result
  }
}
export default PersonaState
