import { MemoryError, assertId, assertOnly, digest, timestamp } from './contracts.js'

export const AGREEMENT_STATES = Object.freeze(['proposed', 'open', 'fulfilled', 'cancelled', 'expired'])
export const participantKey = (value) => `${value.kind}:${value.id}`
const fail = (code) => { throw new MemoryError(code) }
export function validateAgreementParticipant(value) {
  assertOnly(value, ['kind', 'id'])
  if (!['subject', 'agent_identity'].includes(value.kind)) fail('INVALID_AGREEMENT_PARTICIPANT')
  assertId(value.id)
  return value
}
function refs(value) {
  if (!Array.isArray(value) || new Set(value).size !== value.length || value.length > 64) fail('INVALID_AGREEMENT_EVIDENCE')
  value.forEach((id) => assertId(id)); return value
}

/** Missing metadata leaves legacy promises and boundaries explicitly unclassified. */
export function validateAgreementMetadata(meta) {
  const value = meta?.agreement
  if (value === undefined) return null
  assertOnly(value, ['schema_version', 'kind', 'state', 'participants', 'required_acceptances', 'accepted_by', 'proposed_at', 'accepted_at', 'due_at', 'closed_at',
    'proposal_evidence_refs', 'acceptance_evidence_refs', 'transition_evidence_refs', 'last_transition', 'related_agreement_id'])
  if (value.schema_version !== 1) fail('UNSUPPORTED_AGREEMENT_SCHEMA')
  if (value.kind !== 'commitment' || meta.type !== 'promise' || !AGREEMENT_STATES.includes(value.state) ||
    !Array.isArray(value.participants) || !value.participants.length || value.participants.length > 8) fail('INVALID_AGREEMENT_METADATA')
  value.participants.forEach(validateAgreementParticipant)
  const keys = value.participants.map(participantKey)
  if (new Set(keys).size !== keys.length || value.participants.some((party) => party.kind === 'subject' ? party.id !== meta.subject_id : party.id !== meta.agent_identity_id)) fail('AGREEMENT_SCOPE_MISMATCH')
  if (!Array.isArray(value.required_acceptances) || digest([...value.required_acceptances].sort()) !== digest([...keys].sort()) || new Set(value.required_acceptances).size !== keys.length) fail('INVALID_AGREEMENT_ACCEPTANCE')
  if (!Array.isArray(value.accepted_by) || value.accepted_by.length > keys.length) fail('INVALID_AGREEMENT_ACCEPTANCE')
  const accepted = new Set()
  for (const entry of value.accepted_by) {
    assertOnly(entry, ['participant', 'event_id', 'evidence_id', 'observed_at'])
    validateAgreementParticipant(entry.participant); const key = participantKey(entry.participant)
    if (!keys.includes(key) || accepted.has(key)) fail('INVALID_AGREEMENT_ACCEPTANCE')
    accepted.add(key); assertId(entry.event_id); assertId(entry.evidence_id); timestamp(entry.observed_at, 'acceptance time', false)
  }
  const proposalTime = Date.parse(timestamp(value.proposed_at, 'proposed_at', false))
  for (const key of ['accepted_at', 'due_at', 'closed_at']) timestamp(value[key], key)
  if (value.due_at && Date.parse(value.due_at) < proposalTime || value.accepted_by.some((entry) => Date.parse(entry.observed_at) < proposalTime)) fail('INVALID_AGREEMENT_TIME')
  const proposal = refs(value.proposal_evidence_refs), acceptance = refs(value.acceptance_evidence_refs), transition = refs(value.transition_evidence_refs)
  if (!proposal.length || value.accepted_by.some((entry) => !acceptance.includes(entry.evidence_id)) || [...proposal, ...acceptance, ...transition].some((id) => !meta.provenance_refs.includes(id))) fail('INVALID_AGREEMENT_EVIDENCE')
  if (value.state === 'proposed' ? accepted.size === keys.length || value.accepted_at !== null : accepted.size !== keys.length || value.accepted_at === null) {
    // A proposal may be cancelled before all parties accepted it.
    if (!(value.state === 'cancelled' && value.accepted_at === null && accepted.size < keys.length)) fail('INVALID_AGREEMENT_ACCEPTANCE')
  }
  if (value.accepted_at && Date.parse(value.accepted_at) !== Math.max(...value.accepted_by.map((entry) => Date.parse(entry.observed_at)))) fail('INVALID_AGREEMENT_TIME')
  if (['proposed', 'open'].includes(value.state) ? value.closed_at !== null : value.closed_at === null) fail('INVALID_AGREEMENT_TIME')
  if (value.closed_at && Date.parse(value.closed_at) < proposalTime || value.state === 'expired' && (!value.due_at || value.closed_at !== value.due_at)) fail('INVALID_AGREEMENT_TIME')
  if (value.state === 'open' ? meta.status !== 'active' : meta.status !== 'archived') fail('AGREEMENT_STATUS_CONFLICT')
  const last = value.last_transition
  assertOnly(last, ['kind', 'observed_at', 'recorded_at', 'event_id', 'evidence_id', 'source'])
  if (!['proposal', 'acceptance', 'fulfillment', 'cancellation', 'expiry'].includes(last.kind) || !['user_report', 'host_agent_commitment', 'tool_observation', 'clock'].includes(last.source)) fail('INVALID_AGREEMENT_TRANSITION')
  const observed = Date.parse(timestamp(last.observed_at, 'transition time', false)), recorded = Date.parse(timestamp(last.recorded_at, 'recorded time', false))
  if (observed < proposalTime || recorded < observed) fail('INVALID_AGREEMENT_TIME')
  if (last.kind === 'expiry' ? last.event_id !== null || last.evidence_id !== null || last.source !== 'clock' : !last.event_id || !last.evidence_id || last.source === 'clock') fail('INVALID_AGREEMENT_TRANSITION')
  if (value.state === 'open' && last.kind !== 'acceptance' || value.state === 'fulfilled' && last.kind !== 'fulfillment' || value.state === 'cancelled' && last.kind !== 'cancellation' || value.state === 'expired' && last.kind !== 'expiry' || value.state === 'proposed' && !['proposal', 'acceptance'].includes(last.kind)) fail('INVALID_AGREEMENT_TRANSITION')
  if (value.closed_at && Date.parse(value.closed_at) !== observed) fail('INVALID_AGREEMENT_TIME')
  if (last.event_id !== null) assertId(last.event_id)
  if (last.evidence_id !== null) { assertId(last.evidence_id); if (!meta.provenance_refs.includes(last.evidence_id)) fail('INVALID_AGREEMENT_EVIDENCE') }
  if (value.related_agreement_id !== null) assertId(value.related_agreement_id)
  return value
}
