import { MemoryError, assertId, digest, timestamp } from './contracts.js'

/** Canonical host event identity; no model-provided metadata is accepted. */
export function normalizeHostEvent(record, identity) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new MemoryError('INVALID_HOST_EVENT')
  const source = typeof record.source === 'object' ? record.source?.kind : record.source
  if (!['user', 'host'].includes(source)) throw new MemoryError('UNTRUSTED_EVENT_SOURCE')
  const claimKind = source === 'user' ? 'user_statement' : 'interaction_observation'
  if (record.claim_kind !== undefined && record.claim_kind !== claimKind) throw new MemoryError('HOST_EVENT_CLAIM_CONFLICT')
  const event = {
    event_id: assertId(record.event_id), message_id: assertId(record.message_id), session_id: assertId(record.session_id),
    occurred_at: timestamp(record.occurred_at, 'event time', false),
    subject_id: assertId(record.subject_id), persona_id: assertId(record.persona_id), agent_identity_id: assertId(record.agent_identity_id),
    source, claim_kind: claimKind,
  }
  if (identity && ['subject_id', 'persona_id', 'agent_identity_id'].some((key) => event[key] !== identity[key])) throw new MemoryError('PERSONA_EVENT_SCOPE')
  if (record.independence_key !== undefined && record.independence_key !== event.event_id) throw new MemoryError('INDEPENDENCE_KEY_CONFLICT')
  if (typeof record.content !== 'string' || !record.content.trim() || record.content.length > 60_000) throw new MemoryError('INVALID_EVENT_CONTENT')
  const actors = record.actor_ids ?? [event.subject_id]
  if (!Array.isArray(actors) || actors.length > 32) throw new MemoryError('INVALID_EVENT_ACTORS')
  const actorIds = [...new Set(actors.map((actor) => assertId(actor)))]
  return { ...event, independence_key: event.event_id, actor_ids: actorIds, content: record.content }
}
export function deriveEventEvidenceId(record) {
  const event = normalizeHostEvent(record)
  const { event_id, message_id, session_id, occurred_at, subject_id, persona_id, agent_identity_id, source, claim_kind } = event
  return `event-${digest({ event_id, session_id, message_id, occurred_at, subject_id, persona_id, agent_identity_id, source, claim_kind }).slice(0, 40)}`
}
