import { MemoryError, MEMORY_TYPES, assertId, assertOnly, digest } from './contracts.js'
const bad = () => { throw new MemoryError('INVALID_BATCH_BINDING') }
export const normalizedContentHash = (content) => digest(content.normalize('NFKC').trim().replace(/\s+/gu, ' '))
export function rootTargetBinding(value) {
  if (value === null) return null
  assertOnly(value, ['record_id', 'expected_revision', 'canonical_key', 'type'])
  assertId(value.record_id)
  if (!Number.isSafeInteger(value.expected_revision) || value.expected_revision < 1 || !MEMORY_TYPES.includes(value.type) || value.canonical_key !== null && (typeof value.canonical_key !== 'string' || !value.canonical_key.trim() || value.canonical_key.length > 256)) bad()
  return { record_id: value.record_id, expected_revision: value.expected_revision, canonical_key_hash: value.canonical_key === null ? null : digest(value.canonical_key), type: value.type }
}
export function validateItemBinding(item) {
  assertOnly(item, ['evidence_id', 'event_evidence_id', 'payload_hash', 'operation_id', 'target_binding', 'span_start', 'span_end', 'outbox_outcome'])
  if (!/^item-[a-f0-9]{40}$/.test(item.evidence_id) || !/^[a-f0-9]{64}$/.test(item.payload_hash) || item.operation_id !== `memory-item-${item.evidence_id}`) bad()
  assertId(item.event_evidence_id)
  if (!Number.isSafeInteger(item.span_start) || !Number.isSafeInteger(item.span_end) || item.span_start < 0 || item.span_end <= item.span_start || item.span_end - item.span_start > 800) bad()
  const target = item.target_binding
  if (target !== null) {
    assertOnly(target, ['record_id', 'expected_revision', 'canonical_key_hash', 'type'])
    assertId(target.record_id)
    if (!Number.isSafeInteger(target.expected_revision) || target.expected_revision < 1 || !MEMORY_TYPES.includes(target.type) || target.canonical_key_hash !== null && !/^[a-f0-9]{64}$/.test(target.canonical_key_hash)) bad()
  }
  if (item.outbox_outcome !== undefined) {
    const out = item.outbox_outcome
    assertOnly(out, ['status', 'reason_code', 'observed_record_id', 'observed_revision'])
    if (!['terminal_conflict', 'ignored'].includes(out.status) || !(out.status === 'ignored' ? ['ALREADY_CURRENT'] : ['TARGET_REVISION_CHANGED','TARGET_UNAVAILABLE','SLOT_ALREADY_EXISTS']).includes(out.reason_code) || !Number.isSafeInteger(out.observed_revision) || out.observed_revision < 0) bad()
    if (out.observed_record_id !== null) assertId(out.observed_record_id)
  }
  return item
}
export function evidenceBinding(anchor, id) {
  const item = (anchor.items ?? []).find((entry) => entry.evidence_id === id)
  return item ? item : anchor.credentials.find((entry) => entry.evidence_id === id) ?? null
}
export function validateBoundItemPayload(anchor, item, value) {
  validateItemBinding(item)
  const event = anchor.credentials.find((entry) => entry.evidence_id === item.event_evidence_id)
  if (!event || value.evidence_id !== item.evidence_id || value.event_evidence_id !== event.evidence_id || value.persona_id !== anchor.persona_id || value.agent_identity_id !== anchor.agent_identity_id || value.subject_id !== anchor.subject_id || value.memory_space_id !== anchor.memory_space_id || value.independence_key !== event.independence_key || value.event_id !== event.independence_key || value.session_id !== event.session_id || value.message_id !== event.message_id || value.occurred_at !== event.occurred_at || value.source !== event.source || value.claim_kind !== event.claim_kind || value.maturity_eligible !== false || value.allow_persist !== true || event.duplicate_content && value.growth_eligible !== false || value.operation_id !== item.operation_id || digest(value) !== item.payload_hash || digest(rootTargetBinding(value.target_binding)) !== digest(item.target_binding) || value.span_start !== item.span_start || value.span_end !== item.span_end || typeof value.content !== 'string' || value.content.length !== item.span_end - item.span_start || !value.content.isWellFormed()) bad()
  const proposal = value.memory_proposal
  if (!proposal || proposal.subject_id !== anchor.subject_id || proposal.content !== value.content || proposal.gist !== value.content || proposal.provenance_refs?.length !== 1 || proposal.provenance_refs[0] !== item.evidence_id) bad()
  if (value.target_binding && (proposal.type !== value.target_binding.type || (proposal.canonical_key ?? null) !== value.target_binding.canonical_key)) bad()
  return value
}
