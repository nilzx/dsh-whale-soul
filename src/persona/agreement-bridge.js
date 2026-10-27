import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MemoryAgreements } from '../memory/v2/agreements.js'
import { MemoryError, assertId, digest, timestamp } from '../memory/v2/contracts.js'
import { retentionBlockReason } from '../memory/v2/retention.js'
import { explicitSelectionEnd } from '../memory/v2/selection-time.js'

const scopeKeys = ['memory_space_id', 'subject_id', 'persona_id', 'agent_identity_id']
const explicitDeadline = /直到|截至|截止|(?:^|[，,；;\s])到\s*(?:\d|今年|明年|[一二三四五六七八九十]+月)|(?:持续|接下来|未来)\s*\d+\s*天|\b(?:until|through|before)\b|\bfor\s+\d+\s+days?\b/i
const future = /以后|今后|每次|每周|每月|下周|明天|明日|下次|未来|从今天起|\b(?:next|every|tomorrow|from now on)\b/i
const fiction = /^(?:假如|假设|引用|有人说|在故事里|小说里)|假装|扮演|改成.{0,8}性格|\b(?:pretend|roleplay|hypothetically|suppose|imagine)\b/i
const taskControl = /(?:记忆|保存|记住|记录|存储).{0,30}(?:指令|要求|约束)|(?:只按|仅按).{0,24}(?:这次|本次|提供)|\b(?:memory|storage|saving)\s+(?:instruction|request|constraint)\b/i
const accept = /^(?:我(?:确认)?接受|我同意|就按)(?:这个|这项|刚才的|我们刚才的)?约定(?:[，,:：。.!！\s]|$)|^I\s+(?:accept|agree to)\s+(?:this|that|the)\s+agreement\b/i
const cancel = /^(?:我(?:想|要)?(?:取消|撤回)|取消)(?:这个|这项|刚才的|我们刚才的)?约定(?:[，,:：。.!！\s]|$)|^(?:I\s+)?(?:cancel|withdraw)\s+(?:this|that|the)\s+agreement\b/i
const proposal = /^(?:(?:我们(?:来)?|我想(?:和|跟)你|(?:我想)?(?:和|跟)你)(?:做个|定个)?约定(?:一下)?|咱们约定)\s*[：:，,]?\s*([\s\S]+)$|^(?:let['’]s\s+(?:agree|make an agreement)|I\s+propose\s+(?:an?\s+)?agreement)\s*[:：,]?\s*([\s\S]+)$/i
const clone = (value) => structuredClone(value)

/** A narrow host bridge. Ordinary promises and tool success never create completion. */
export class PersonaAgreementBridge {
  #sources = new Map(); #events = new Map()
  constructor({ store, state, clock = () => Date.now() } = {}) {
    if (!store || typeof state?.issueContext !== 'function') throw new MemoryError('TRUSTED_AGREEMENT_ADAPTER_REQUIRED')
    this.store = store; this.state = state; this.clock = clock
    this.service = new MemoryAgreements({ store, clock, resolveEvent: (id) => this.#events.get(id) })
  }
  #check(ctx, options = {}) {
    this.store._authorize(ctx, 'memory.manage')
    if (scopeKeys.some((key) => ctx[key] !== this.state.identity[key])) throw new MemoryError('AGREEMENT_SCOPE_MISMATCH')
    if (options.signal?.aborted) throw new MemoryError('AGREEMENT_CANCELLED')
    if (options.authorize && options.authorize() !== true) throw new MemoryError('AGREEMENT_EVENT_REVOKED')
  }
  resolveEvidence(id) {
    if (typeof id !== 'string' || !/^agreement-event-[a-f0-9]{40}$/.test(id)) return null
    if (this.#sources.has(id)) return clone(this.#sources.get(id))
    const path = join(this.store.paths.evidence, `${id}.json`)
    if (!existsSync(path)) return null
    let value
    try { value = JSON.parse(readFileSync(path, 'utf8')) } catch { throw new MemoryError('AGREEMENT_EVIDENCE_UNAVAILABLE') }
    return value.evidence_id === id ? { ...value, allow_persist: true } : null
  }
  #event(record, action, target, terms, ctx, options, dueAt = null) {
    this.#check(ctx, options)
    if (scopeKeys.some((key) => record[key] !== ctx[key]) || record.session_id !== ctx.session_id) throw new MemoryError('AGREEMENT_SCOPE_MISMATCH')
    const eventId = assertId(record.message_id), occurredAt = timestamp(record.occurred_at, 'agreement event time', false)
    const user = record.source === 'user' || record.source?.kind === 'user'
    const participant = { kind: user ? 'subject' : 'agent_identity', id: user ? ctx.subject_id : ctx.agent_identity_id }
    const evidenceId = `agreement-event-${digest({ eventId, session: ctx.session_id, action, target, participant }).slice(0, 40)}`
    const evidence = { evidence_id: evidenceId, subject_ids: [ctx.subject_id], session_id: ctx.session_id,
      message_id: eventId, observed_at: occurredAt, actor_ids: [participant.id], claim_kind: user ? 'user_statement' : 'tool_observation',
      content: terms, allow_persist: true, growth_eligible: false, maturity_eligible: false }
    this.#sources.set(evidenceId, evidence)
    const grant = { ...Object.fromEntries(scopeKeys.map((key) => [key, ctx[key]])), event_id: eventId, action, agreement_id: target,
      participant, source: user ? 'user' : 'host_agent_commitment', occurred_at: occurredAt, evidence_id: evidenceId,
      session_id: ctx.session_id, assertion: 'direct', allow_persist: true, signal: options.signal,
      isCurrent: () => { try { this.#check(ctx, options); return true } catch { return false } },
      ...(action === 'propose' ? { participants: [{ kind: 'subject', id: ctx.subject_id }, { kind: 'agent_identity', id: ctx.agent_identity_id }], due_at: dueAt } : {}) }
    this.#events.set(eventId, grant)
    return { event_id: eventId, evidence_id: evidenceId, operation_id: `agreement-${digest({ eventId, session: ctx.session_id, action, target, participant }).slice(0, 40)}` }
  }
  async #replay(record, action, ctx, options) {
    this.#check(ctx, options)
    return this.store.managedRead(ctx, ({ records }) => {
      this.#check(ctx, options)
      for (const meta of records) {
        if (!meta.agreement || scopeKeys.some((key) => meta[key] !== ctx[key])) continue
        const target = action === 'propose' ? null : meta.record_id
        const participant = { kind: 'subject', id: ctx.subject_id }
        const key = { eventId: record.message_id, session: ctx.session_id, action, target, participant }
        const evidenceId = `agreement-event-${digest(key).slice(0, 40)}`
        const refs = action === 'propose' ? meta.agreement.proposal_evidence_refs
          : action === 'accept' ? meta.agreement.accepted_by.filter((entry) => entry.participant.kind === 'subject').map((entry) => entry.evidence_id)
            : meta.agreement.state === 'cancelled' ? meta.agreement.transition_evidence_refs : []
        if (!refs.includes(evidenceId)) continue
        const value = this.store._readRecord(meta.record_id)
        const source = value.evidence.find((item) => item.evidence_id === evidenceId)
        if (!source || source.message_id !== record.message_id || source.session_id !== ctx.session_id || source.claim_kind !== 'user_statement') continue
        const operationId = `agreement-${digest(key).slice(0, 40)}`
        const path = this.store.engine.resolvePath(`operations/${digest(operationId)}.json`)
        let receipt
        try { receipt = JSON.parse(readFileSync(path, 'utf8')) } catch { throw new MemoryError('AGREEMENT_RECEIPT_REPAIR_REQUIRED') }
        if (receipt.operation_id !== operationId || receipt.result?.status !== 'committed' || receipt.result.record_id !== meta.record_id) throw new MemoryError('AGREEMENT_RECEIPT_REPAIR_REQUIRED')
        this.#check(ctx, options)
        return { handled: true, ...receipt.result, terms: value.detail, replayed: true }
      }
      return null
    })
  }
  async #items(ctx, options) {
    this.#check(ctx, options)
    const result = await this.service.list({ states: ['proposed', 'open'], limit: 32 }, ctx)
    this.#check(ctx, options)
    if (result.status !== 'ok') throw new MemoryError(result.reason_code ?? 'AGREEMENT_UNAVAILABLE')
    return result.items.map((item) => ({ ...item, terms: this.store._readRecord(item.record_id).detail }))
  }
  async pending(ctx, options = {}) {
    const items = await this.#items(ctx, options), current = []
    for (const item of items) {
      if (item.window_closed && item.agreement.state === 'open') {
        await this.service.transition({ operation_id: `agreement-expire-${item.record_id}-${item.revision}`,
          record_id: item.record_id, expected_revision: item.revision, action: 'expire' }, ctx, options)
      } else if (!item.window_closed) current.push({ record_id: item.record_id, revision: item.revision, terms: item.terms,
        agreement_state: item.agreement.state, window_closed: false, accepted_by: item.agreement.accepted_by.map((entry) => entry.participant.kind), due_at: item.agreement.due_at })
    }
    return { status: 'ok', items: current.slice(0, 8), truncated: current.length > 8 }
  }
  async observeUser(record, ctx, options = {}) {
    this.#check(ctx, options)
    if (!(record.source === 'user' || record.source?.kind === 'user') || record.claim_kind && record.claim_kind !== 'user_statement') throw new MemoryError('TRUSTED_AGREEMENT_EVENT_REQUIRED')
    const text = record.content?.trim()
    if (typeof text !== 'string' || !text || text.length > 8000 || retentionBlockReason(text) || fiction.test(text) || taskControl.test(text)) return { handled: false }
    const action = accept.test(text) ? 'accept' : cancel.test(text) ? 'cancel' : null
    const match = !action && text.match(proposal)
    if (!action && !match) return { handled: false }
    const replay = await this.#replay(record, action ?? 'propose', ctx, options)
    if (replay) return replay
    const items = await this.#items(ctx, options)
    if (action) {
      const eligible = items.filter((item) => !item.window_closed && (action === 'cancel' || item.agreement.state === 'proposed'))
      const quoted = eligible.filter((item) => text.includes(item.terms))
      const specifiesTerms = /[：:]\s*\S/.test(text)
      const target = quoted.length === 1 ? quoted[0] : !specifiesTerms && eligible.length === 1 ? eligible[0] : null
      if (!target) return { handled: true, status: 'clarification_required', reason_code: eligible.length ? 'AGREEMENT_TARGET_AMBIGUOUS' : 'AGREEMENT_TARGET_UNAVAILABLE' }
      if (action === 'accept' && target.agreement.proposal_evidence_refs.some((id) => this.resolveEvidence(id)?.message_id === record.message_id)) return { handled: true, status: 'rejected', reason_code: 'SEPARATE_ACCEPTANCE_REQUIRED' }
      const event = this.#event(record, action, target.record_id, text, ctx, options)
      const result = await this.service.transition({ operation_id: event.operation_id, event_id: event.event_id,
        record_id: target.record_id, expected_revision: target.revision, action }, ctx, options)
      return { handled: true, ...result, terms: target.terms }
    }
    const terms = (match[1] ?? match[2]).trim()
    let dueAt = record.valid_to ?? null
    try {
      // A start date or a recurring topic is not an ending. Retain it in the
      // terms, but derive expiry only from an explicit deadline expression.
      const end = explicitDeadline.test(terms) ? explicitSelectionEnd(terms, { ...record, timezone_offset_minutes: record.timezone_offset_minutes ?? 0 }) : null
      if (!dueAt && end) dueAt = new Date(end.end).toISOString()
    } catch { return { handled: true, status: 'clarification_required', reason_code: 'AGREEMENT_DEADLINE_AMBIGUOUS' } }
    if (!terms || terms.length > 800 || !future.test(terms) && !dueAt) return { handled: true, status: 'clarification_required', reason_code: 'AGREEMENT_TERMS_REQUIRED' }
    const same = items.filter((item) => !item.window_closed && item.terms === terms)
    if (same.length === 1) return { handled: true, status: 'existing', record_id: same[0].record_id, revision: same[0].revision, agreement_state: same[0].agreement.state, terms }
    const event = this.#event(record, 'propose', null, terms, ctx, options, dueAt)
    const result = await this.service.propose({ operation_id: event.operation_id, event_id: event.event_id }, ctx, options)
    return { handled: true, ...result, terms }
  }
  async acceptAgent(args, record, ctx, options = {}) {
    this.#check(ctx, options)
    if (record.source !== 'host' && record.source?.kind !== 'host') throw new MemoryError('TRUSTED_AGENT_COMMITMENT_REQUIRED')
    assertId(args?.record_id)
    if (!Number.isSafeInteger(args.expected_revision) || args.expected_revision < 1) throw new MemoryError('INVALID_AGREEMENT_TRANSITION')
    const items = await this.#items(ctx, options), target = items.find((item) => item.record_id === args.record_id)
    if (!target || target.window_closed) return { status: 'rejected', reason_code: 'AGREEMENT_TARGET_UNAVAILABLE' }
    const event = this.#event(record, 'accept', target.record_id, target.terms, ctx, options)
    return this.service.transition({ operation_id: event.operation_id, event_id: event.event_id, record_id: target.record_id,
      expected_revision: args.expected_revision, action: 'accept' }, ctx, options)
  }
}
