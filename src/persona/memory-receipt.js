import { API_VERSION, MemoryError, assertId, digest } from '../memory/v2/contracts.js'

export const MEMORY_REVISION_REASON = 'New independently sourced statement about the same fact'
const invalid = () => { throw new MemoryError('MEMORY_RECEIPT_REPAIR_REQUIRED') }
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const sameIds = (left, right) => Array.isArray(left) && Array.isArray(right) &&
  [...new Set(left)].sort().join('\0') === [...new Set(right)].sort().join('\0')
function frozen(value) {
  if (plain(value) || Array.isArray(value)) { Object.values(value).forEach(frozen); Object.freeze(value) }
  return value
}

/**
 * Pure host-owned receipt verification. recordMeta is the integrity-checked
 * historical revision named by the receipt, not today's potentially newer
 * revision. Only a trusted purge ledger may supply purged=true. No receipt's
 * self-declared success is sufficient to skip an outbox item.
 */
export function verifyMemoryReceipt(receipt, { args, identity, recordMeta, purged = false } = {}) {
  try {
    if (!plain(receipt) || Object.keys(receipt).some((key) => !['operation_id', 'request_hash', 'result'].includes(key)) ||
      !plain(args) || !plain(identity) || typeof purged !== 'boolean') invalid()
    for (const key of ['agent_identity_id', 'persona_id', 'subject_id', 'memory_space_id']) assertId(identity[key])
    assertId(args.operation_id)
    const result = receipt.result
    if (!plain(result) || Object.keys(result).some((key) => !['api_version', 'operation_id', 'status', 'reason_code', 'affected_ids',
      'record_id', 'revision_id', 'revision', 'pending'].includes(key)) || result.api_version !== API_VERSION ||
      receipt.operation_id !== args.operation_id || result.operation_id !== args.operation_id ||
      !['committed', 'temporary', 'purged'].includes(result.status) || result.pending !== false ||
      !Number.isSafeInteger(result.revision) || result.revision < 1 || !/^[a-f0-9]{64}$/.test(receipt.request_hash ?? '')) invalid()
    assertId(result.record_id); assertId(result.revision_id)
    if (!Array.isArray(result.affected_ids) || !result.affected_ids.includes(result.record_id)) invalid()
    const request = (action, value) => digest({ action, args: value, actor: identity.agent_identity_id,
      subject: identity.subject_id, persona: identity.persona_id, space: identity.memory_space_id })
    const hashes = [request('proposeMemory', args)]
    if (result.revision > 1) hashes.push(request('reviseMemory', { ...args, record_id: result.record_id,
      expected_revision: result.revision - 1, reason: MEMORY_REVISION_REASON }))
    if (!hashes.includes(receipt.request_hash)) invalid()
    if (!purged) {
      if (!plain(recordMeta) || ['agent_identity_id', 'persona_id', 'subject_id', 'memory_space_id'].some((key) => recordMeta[key] !== identity[key]) ||
        recordMeta.record_id !== result.record_id || recordMeta.revision_id !== result.revision_id || recordMeta.revision !== result.revision ||
        recordMeta.type !== (args.type ?? 'fact') || recordMeta.canonical_key !== (args.canonical_key ?? null) ||
        !sameIds(recordMeta.provenance_refs, args.provenance_refs)) invalid()
    }
    return frozen(purged ? { api_version: result.api_version, operation_id: args.operation_id, status: 'purged',
      reason_code: 'PURGED_BY_MANAGEMENT', affected_ids: [], pending: false, replayed: true }
      : { ...structuredClone(result), replayed: true })
  } catch { invalid() }
}
