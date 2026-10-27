/** Batch item grouping is accepted only from the trusted evidence resolver. */
export const isBatchEventReference = (value) => typeof value === 'string' && /^event-[a-f0-9]{40}$/.test(value)

export function sameEvidenceOrigin(left, right) {
  if (['session_id', 'occurred_at', 'source', 'claim_kind', 'event_evidence_id'].some((key) => left[key] !== right[key])) return false
  return left.content === right.content || isBatchEventReference(left.event_evidence_id)
}
