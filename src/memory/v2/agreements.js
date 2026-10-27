import { randomUUID } from 'node:crypto'
import { MemoryError, assertId, assertOnly, digest, failure, timestamp } from './contracts.js'
import { participantKey, validateAgreementMetadata, validateAgreementParticipant, validateAgreementDelivery } from './agreement-policy.js'
import { isLifecycleProtected, lifecycleTime } from './lifecycle-policy.js'
import { recordRetentionAllowed } from './read-policy.js'

const clone = (value) => structuredClone(value)
const grantStamps = new WeakMap()
const stamp = (value) => digest(Object.fromEntries(['event_id', 'action', 'agreement_id', 'memory_space_id', 'subject_id', 'persona_id', 'agent_identity_id', 'session_id', 'participant', 'source', 'occurred_at', 'evidence_id', 'assertion', 'allow_persist', 'participants', 'due_at', 'related_agreement_id', 'delivery'].map((key) => [key, value[key]])))
const scopeKeys = ['memory_space_id', 'subject_id', 'persona_id', 'agent_identity_id']
const participantSource = (grant) => grant.source === 'user' ? 'user_report' : grant.source === 'host_tool' ? 'tool_observation' : 'host_agent_commitment'

/** Trusted event adapter service; no model-callable state or acceptance flags. */
export class MemoryAgreements {
  constructor({ store, resolveEvent, clock = () => Date.now() } = {}) {
    if (typeof store?.managedTransaction !== 'function' || typeof resolveEvent !== 'function' || typeof clock !== 'function') throw new MemoryError('TRUSTED_AGREEMENT_ADAPTER_REQUIRED')
    this.store = store; this.resolveEvent = resolveEvent; this.clock = clock
  }

  #authorize(context, signal, grant = null) {
    this.store._authorize(context, 'memory.manage')
    if (signal?.aborted) throw new MemoryError('AGREEMENT_CANCELLED')
    if (grant) {
      let current
      try { current = grant.isCurrent() } catch { throw new MemoryError('AGREEMENT_EVENT_REVOKED') }
      if (current !== true || grant.signal?.aborted || grantStamps.get(grant) !== stamp(grant)) throw new MemoryError('AGREEMENT_EVENT_REVOKED')
    }
  }

  async #event(id, action, agreementId, context, signal) {
    assertId(id); this.#authorize(context, signal)
    const grant = await this.resolveEvent(id, context)
    this.#authorize(context, signal)
    if (!grant || typeof grant.isCurrent !== 'function' || grant.allow_persist !== true || grant.assertion !== 'direct' || grant.event_id !== id || grant.action !== action ||
      grant.agreement_id !== agreementId || grant.session_id !== context.session_id || !grant.session_id || scopeKeys.some((key) => grant[key] !== context[key]) || !['user', 'host_agent_commitment', 'host_tool'].includes(grant.source)) throw new MemoryError('TRUSTED_AGREEMENT_EVENT_REQUIRED')
    validateAgreementParticipant(grant.participant)
    const participant = grant.participant
    if (participant.kind === 'subject' ? participant.id !== context.subject_id || grant.source !== 'user' : participant.id !== context.agent_identity_id || grant.source === 'user') throw new MemoryError('AGREEMENT_PARTICIPANT_DENIED')
    if (grant.source === 'host_tool' && action !== 'fulfill') throw new MemoryError('AGREEMENT_EVENT_KIND_DENIED')
    const observedAt = timestamp(grant.occurred_at, 'event time', false)
    if (Date.parse(observedAt) > lifecycleTime(this.clock())) throw new MemoryError('AGREEMENT_FUTURE_EVENT')
    grantStamps.set(grant, stamp(grant))
    const [evidence] = await this.store._evidence([assertId(grant.evidence_id)], context, context.subject_id)
    if (evidence.session_id !== grant.session_id || evidence.message_id !== grant.event_id || evidence.observed_at !== observedAt || !evidence.actor_ids.includes(participant.id) ||
      evidence.claim_kind !== (grant.source === 'user' ? 'user_statement' : 'tool_observation')) throw new MemoryError('AGREEMENT_EVIDENCE_MISMATCH')
    this.#authorize(context, signal, grant)
    return { grant, evidence, observedAt }
  }

  async propose(args, context, { signal } = {}) {
    const operationId = args?.operation_id ?? randomUUID()
    try {
      this.#authorize(context, signal); assertOnly(args, ['operation_id', 'event_id'])
      const { grant, evidence, observedAt } = await this.#event(args.event_id, 'propose', null, context, signal)
      if (!Array.isArray(grant.participants) || !grant.participants.length || grant.participants.length > 8) throw new MemoryError('INVALID_AGREEMENT_PARTICIPANT')
      grant.participants.forEach(validateAgreementParticipant)
      const participants = clone(grant.participants)
      if (participants.some((party) => party.kind === 'subject' ? party.id !== context.subject_id : party.id !== context.agent_identity_id) || !participants.some((party) => participantKey(party) === participantKey(grant.participant))) throw new MemoryError('AGREEMENT_SCOPE_MISMATCH')
      const dueAt = timestamp(grant.due_at, 'agreement due_at')
      if (dueAt && Date.parse(dueAt) < Date.parse(observedAt)) throw new MemoryError('INVALID_AGREEMENT_TIME')
      const delivery = grant.delivery === undefined ? null : clone(validateAgreementDelivery(grant.delivery))
      if (delivery && delivery.session_id !== context.session_id) throw new MemoryError('AGREEMENT_SCOPE_MISMATCH')
      return await this.store.managedTransaction(operationId, { action: 'proposeAgreement', event_id: args.event_id }, async () => {
        this.#authorize(context, signal, grant)
        const record = await this.store._proposal({ content: evidence.content, gist: evidence.content.slice(0, 2000), type: 'promise', provenance_refs: [evidence.evidence_id] }, context)
        const recordedAt = new Date(lifecycleTime(this.clock())).toISOString()
        record.meta.created_at = recordedAt; record.meta.updated_at = recordedAt
        record.meta.status = 'archived'
        record.meta.agreement = { schema_version: 1, kind: 'commitment', state: 'proposed', participants,
          required_acceptances: participants.map(participantKey), accepted_by: [], proposed_at: observedAt, accepted_at: null, due_at: dueAt, closed_at: null,
          proposal_evidence_refs: [evidence.evidence_id], acceptance_evidence_refs: [], transition_evidence_refs: [],
          last_transition: { kind: 'proposal', observed_at: observedAt, recorded_at: recordedAt, event_id: grant.event_id, evidence_id: evidence.evidence_id, source: participantSource(grant) },
          related_agreement_id: grant.related_agreement_id ?? null, ...(delivery ? { delivery } : {}) }
        validateAgreementMetadata(record.meta)
        if (!recordRetentionAllowed(record)) throw new MemoryError('AGREEMENT_RETENTION_DENIED')
        return { changes: this.store._commitChanges(record), result: { status: 'committed', reason_code: 'AGREEMENT_PROPOSED', record_id: record.meta.record_id, revision: record.meta.revision,
          revision_id: record.meta.revision_id, agreement_state: 'proposed', affected_ids: [record.meta.record_id], pending: false } }
      }, context, { authorize: () => this.#authorize(context, signal, grant) })
    } catch (error) { return failure(error, operationId) }
  }

  async list(args = {}, context) {
    try {
      this.#authorize(context)
      assertOnly(args, ['states', 'limit'])
      const states = args.states ?? ['open'], limit = args.limit ?? 32
      if (!Array.isArray(states) || !states.length || states.length > 5 || new Set(states).size !== states.length || states.some((state) => !['proposed', 'open', 'fulfilled', 'cancelled', 'expired'].includes(state)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new MemoryError('INVALID_AGREEMENT_QUERY')
      return await this.store.managedRead(context, ({ records }) => {
        this.#authorize(context)
        const now = lifecycleTime(this.clock())
        const matching = records.filter((meta) => meta.agreement && scopeKeys.every((key) => meta[key] === context[key]) && states.includes(meta.agreement.state))
          .sort((a, b) => a.record_id.localeCompare(b.record_id))
        return { status: 'ok', items: matching.slice(0, limit).map((meta) => ({ record_id: meta.record_id, revision: meta.revision, agreement: clone(validateAgreementMetadata(meta)),
          window_closed: !!meta.agreement.due_at && now >= Date.parse(meta.agreement.due_at), title: meta.title })), truncated: matching.length > limit }
      })
    } catch (error) { return failure(error) }
  }

  async transition(args, context, { signal } = {}) {
    const operationId = args?.operation_id ?? randomUUID()
    try {
      this.#authorize(context, signal)
      assertOnly(args, ['operation_id', 'record_id', 'expected_revision', 'action', 'event_id'])
      assertId(args.record_id)
      if (!Number.isSafeInteger(args.expected_revision) || args.expected_revision < 1 || !['accept', 'fulfill', 'cancel', 'expire'].includes(args.action)) throw new MemoryError('INVALID_AGREEMENT_TRANSITION')
      if (args.action === 'expire' && args.event_id !== undefined) throw new MemoryError('CLOCK_TRANSITION_EVENT_FORBIDDEN')
      const event = args.action === 'expire' ? null : await this.#event(args.event_id, args.action, args.record_id, context, signal)
      let prepared = false, expectedHash = null
      const check = () => {
        this.#authorize(context, signal, event?.grant)
        if (prepared && digest(this.store._readRecord(args.record_id)) !== expectedHash) throw new MemoryError('AGREEMENT_SOURCE_CHANGED')
      }
      return await this.store.managedTransaction(operationId, { action: 'transitionAgreement', args }, () => {
        check()
        const previous = this.store._readRecord(args.record_id), agreement = validateAgreementMetadata(previous.meta)
        if (!agreement) throw new MemoryError('AGREEMENT_UNCLASSIFIED')
        if (scopeKeys.some((key) => previous.meta[key] !== context[key])) throw new MemoryError('AGREEMENT_SCOPE_MISMATCH')
        if (previous.meta.revision !== args.expected_revision) throw new MemoryError('REVISION_CONFLICT')
        if (isLifecycleProtected(previous.meta)) throw new MemoryError('PROTECTED_RECORD')
        if (previous.meta.lifecycle?.tier === 'cold') throw new MemoryError('LIFECYCLE_MANAGEMENT_REQUIRED')
        const next = clone(agreement), now = new Date(lifecycleTime(this.clock())).toISOString()
        let observedAt, source, transitionKind
        if (event) {
          const key = participantKey(event.grant.participant)
          if (!agreement.required_acceptances.includes(key)) throw new MemoryError('AGREEMENT_PARTICIPANT_DENIED')
          observedAt = event.observedAt; source = participantSource(event.grant)
          if (Date.parse(observedAt) < Date.parse(agreement.proposed_at)) throw new MemoryError('INVALID_AGREEMENT_TIME')
        } else { observedAt = agreement.due_at; source = 'clock' }
        if (args.action === 'accept') {
          if (agreement.state !== 'proposed') throw new MemoryError('AGREEMENT_STATE_CONFLICT')
          if (agreement.due_at && lifecycleTime(this.clock()) >= Date.parse(agreement.due_at)) throw new MemoryError('AGREEMENT_WINDOW_CLOSED')
          if (next.accepted_by.some((entry) => participantKey(entry.participant) === participantKey(event.grant.participant))) throw new MemoryError('AGREEMENT_ALREADY_ACCEPTED')
          next.accepted_by.push({ participant: clone(event.grant.participant), event_id: event.grant.event_id, evidence_id: event.evidence.evidence_id, observed_at: observedAt })
          next.acceptance_evidence_refs = [...new Set([...next.acceptance_evidence_refs, event.evidence.evidence_id])]
          if (next.accepted_by.length === next.required_acceptances.length) { next.state = 'open'; next.accepted_at = new Date(Math.max(...next.accepted_by.map((entry) => Date.parse(entry.observed_at)))).toISOString() }
          transitionKind = 'acceptance'
        } else if (args.action === 'fulfill') {
          if (!['open', 'expired'].includes(agreement.state)) throw new MemoryError('AGREEMENT_STATE_CONFLICT')
          if (Date.parse(observedAt) < Date.parse(agreement.accepted_at)) throw new MemoryError('INVALID_AGREEMENT_TIME')
          if (agreement.delivery && (event.grant.source !== 'host_tool' || !event.grant.delivery || digest(event.grant.delivery) !== digest(agreement.delivery))) throw new MemoryError('AGREEMENT_DELIVERY_MISMATCH')
          next.state = 'fulfilled'; next.closed_at = observedAt; transitionKind = 'fulfillment'
        } else if (args.action === 'cancel') {
          if (!['proposed', 'open'].includes(agreement.state)) throw new MemoryError('AGREEMENT_STATE_CONFLICT')
          next.state = 'cancelled'; next.closed_at = observedAt; transitionKind = 'cancellation'
        } else {
          if (agreement.state !== 'open') throw new MemoryError('AGREEMENT_STATE_CONFLICT')
          if (!agreement.due_at || lifecycleTime(this.clock()) < Date.parse(agreement.due_at)) throw new MemoryError('AGREEMENT_NOT_EXPIRED')
          next.state = 'expired'; next.closed_at = agreement.due_at; transitionKind = 'expiry'
        }
        if (event && args.action !== 'accept') next.transition_evidence_refs = [...new Set([...next.transition_evidence_refs, event.evidence.evidence_id])]
        next.last_transition = { kind: transitionKind, observed_at: observedAt, recorded_at: now, event_id: event?.grant.event_id ?? null, evidence_id: event?.evidence.evidence_id ?? null, source }
        const record = clone(previous), sources = new Map(record.evidence.map((item) => [item.evidence_id, item]))
        if (event) {
          if (sources.has(event.evidence.evidence_id) && digest(sources.get(event.evidence.evidence_id)) !== digest(event.evidence)) throw new MemoryError('EVIDENCE_CONFLICT')
          sources.set(event.evidence.evidence_id, event.evidence)
        }
        record.evidence = [...sources.values()]
        record.meta = { ...record.meta, agreement: next, status: next.state === 'open' ? 'active' : 'archived', revision_id: randomUUID(), revision: previous.meta.revision + 1,
          supersedes: previous.meta.revision_id, updated_at: now, provenance_refs: [...sources.keys()], actor_ids: [...new Set(record.evidence.flatMap((item) => item.actor_ids))],
          claim_kind: new Set(record.evidence.map((item) => item.claim_kind)).size === 1 ? record.evidence[0].claim_kind : 'inference',
          revision_history: [...(previous.meta.revision_history ?? []), { revision_id: previous.meta.revision_id, revision: previous.meta.revision, superseded_at: now, reason: `AGREEMENT_${transitionKind.toUpperCase()}` }] }
        validateAgreementMetadata(record.meta)
        if (!recordRetentionAllowed(record)) throw new MemoryError('AGREEMENT_RETENTION_DENIED')
        expectedHash = digest(previous); prepared = true
        return { changes: this.store._commitChanges(record), result: { status: 'committed', reason_code: 'AGREEMENT_TRANSITIONED', record_id: record.meta.record_id, revision: record.meta.revision,
          revision_id: record.meta.revision_id, agreement_state: next.state, affected_ids: [record.meta.record_id], pending: false } }
      }, context, { authorize: check })
    } catch (error) { return failure(error, operationId) }
  }
}
