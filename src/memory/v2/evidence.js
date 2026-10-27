import { MemoryError, assertId, digest, timestamp } from './contracts.js'
import { existsSync, readFileSync } from 'node:fs'
import { getPersonaAnchor, projectedIdentityBinding } from './persona-ledger.js'
import { evidenceBinding, validateBoundItemPayload } from './batch-bindings.js'
import { getPurgeState } from './purge-ledger.js'

/** @internal Resolve provenance for an already verified, explicitly shared record. No persona is initialized or projected. */
export function resolveSharedRecordEvidence(store, id, context, meta) {
  store._authorize(context, 'memory.read')
  if (!['space', 'identities'].includes(meta?.visibility?.kind) || !store._visible(meta, context) ||
    meta.memory_space_id !== store.memorySpaceId || !meta.provenance_refs?.includes(id)) return null
  const identity = store._manifest().identities?.[meta.agent_identity_id]
  if (!identity || ['persona_id', 'agent_identity_id', 'subject_id'].some(key => identity[key] !== meta[key])) return null
  const binding = projectedIdentityBinding(identity)
  const currentAnchor = () => getPersonaAnchor(store.root, store.memorySpaceId, binding)
  const anchor = currentAnchor()
  if (!anchor || ['persona_id', 'agent_identity_id', 'subject_id', 'memory_space_id'].some(key => anchor[key] !== meta[key])) return null
  const credential = evidenceBinding(anchor, assertId(id))
  if (!credential?.payload_hash || anchor.revoked_ids.includes(id) ||
    credential.event_evidence_id && anchor.revoked_ids.includes(credential.event_evidence_id) ||
    !credential.event_evidence_id && credential.allow_persist !== true) return null
  const purge = getPurgeState(store.root, store.memorySpaceId)
  if (purge.record_ids.includes(meta.record_id) || [...purge.evidence_ids, ...purge.related_evidence_ids].includes(id)) return null
  const path = store.engine.resolvePath(`self/${anchor.agent_identity_id}/evidence/${id}.json`)
  if (!existsSync(path)) return null
  let value
  try { value = JSON.parse(readFileSync(path, 'utf8')) } catch { throw new MemoryError('PERSONA_EVIDENCE_REPAIR_REQUIRED') }
  if (digest(value) !== credential.payload_hash) throw new MemoryError('EXTERNAL_PERSONA_EVIDENCE_CHANGE')
  if (credential.event_evidence_id) validateBoundItemPayload(anchor, credential, value)
  if (value.allow_persist !== true) return null
  if (anchor.revision !== currentAnchor()?.revision || purge.generation !== getPurgeState(store.root, store.memorySpaceId).generation) throw new MemoryError('PERSONA_EVIDENCE_BUSY')
  return value
}

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
