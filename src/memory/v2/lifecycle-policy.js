import { MemoryError, assertId, assertOnly, digest, timestamp } from './contracts.js'

export const LIFECYCLE_POLICY_VERSION = 'lifecycle-v1'
export const LIFECYCLE_CAPABILITY = 'physical-cold-v1'
const TIERS = ['active', 'cold', 'archived']
const DAY = 86400000
const error = (code) => { throw new MemoryError(code) }

export function lifecycleTime(value) {
  const number = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(timestamp(value, 'lifecycle clock', false))
  if (!Number.isFinite(number) || !Number.isFinite(new Date(number).getTime())) error('INVALID_LIFECYCLE_TIME')
  return number
}

export function validateLifecycleMetadata(meta) {
  if (meta?.lifecycle === undefined) return null
  const value = meta.lifecycle
  assertOnly(value, ['schema_version', 'tier', 'changed_at', 'reason_code', 'policy_version', 'source_revision_id'])
  if (value.schema_version !== 1) error('UNSUPPORTED_LIFECYCLE_SCHEMA')
  if (!TIERS.includes(value.tier) || value.policy_version !== LIFECYCLE_POLICY_VERSION ||
    typeof value.reason_code !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(value.reason_code)) error('INVALID_LIFECYCLE_METADATA')
  assertId(value.source_revision_id, 'source_revision_id')
  timestamp(value.changed_at, 'lifecycle changed_at', false)
  if (value.tier === 'active' ? meta.status !== 'active' : meta.status !== 'archived') error('LIFECYCLE_STATUS_CONFLICT')
  return value
}

export function isLifecycleProtected(meta) {
  return meta?.pinned === true || meta?.external_revision?.protected === true || meta?.legacy?.user_edited === true
}

export function classifyLifecycle(meta, { now } = {}) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta) || !['active', 'archived', 'superseded'].includes(meta.status)) error('INVALID_LIFECYCLE_RECORD')
  const at = lifecycleTime(now), lifecycle = validateLifecycleMetadata(meta)
  const tier = lifecycle?.tier ?? (meta.status === 'active' ? 'active' : 'archived')
  const from = timestamp(meta.valid_from, 'valid_from'), to = timestamp(meta.valid_to, 'valid_to'), expires = timestamp(meta.expires_at, 'expires_at')
  if (from && to && Date.parse(to) < Date.parse(from)) error('INVALID_TIME_RANGE')
  const notYetValid = !!from && at < Date.parse(from)
  const expired = !!to && at >= Date.parse(to) || !!expires && at >= Date.parse(expires)
  return Object.freeze({ tier, protected: isLifecycleProtected(meta), expired, not_yet_valid: notYetValid,
    effective_auto_layer: tier === 'active' && !expired && !notYetValid ? 'gist' : 'none' })
}

/** Pure host-policy preview; callers still need a real context and final CAS. */
export function buildLifecyclePlan(records, { now, mode = 'maintenance', recordIds = [], automaticCold = false,
  minAgeDays = 30, batchLimit = 32, scanLimit = 256, cursor = null } = {}) {
  const at = lifecycleTime(now)
  if (!Array.isArray(records) || !['maintenance', 'cold', 'restore'].includes(mode) || typeof automaticCold !== 'boolean' ||
    !Number.isSafeInteger(batchLimit) || batchLimit < 1 || batchLimit > 32 || !Number.isSafeInteger(scanLimit) || scanLimit < 1 || scanLimit > 4096 ||
    !Number.isFinite(minAgeDays) || minAgeDays < 0 || minAgeDays > 36500) error('INVALID_LIFECYCLE_POLICY')
  if (!Array.isArray(recordIds) || recordIds.length > 32 || new Set(recordIds).size !== recordIds.length || mode !== 'maintenance' && !recordIds.length) error('INVALID_LIFECYCLE_TARGETS')
  recordIds.forEach((id) => assertId(id)); if (cursor !== null) assertId(cursor)
  const requested = new Set(recordIds), known = new Set(), actions = [], skipped = []
  for (const meta of records) {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) error('INVALID_LIFECYCLE_RECORD')
    assertId(meta.record_id); assertId(meta.revision_id)
    if (!Number.isSafeInteger(meta.revision) || meta.revision < 1 || known.has(meta.record_id)) error('INVALID_LIFECYCLE_RECORD')
    known.add(meta.record_id)
  }
  const sorted = [...records].sort((a, b) => a.record_id < b.record_id ? -1 : a.record_id > b.record_id ? 1 : 0)
  let scanned = 0, last = null, remaining = false
  for (const meta of sorted) {
    if (requested.size && !requested.has(meta.record_id) || cursor !== null && meta.record_id <= cursor) continue
    if (scanned >= scanLimit || actions.length >= batchLimit) { remaining = true; break }
    scanned++; last = meta.record_id
    const state = classifyLifecycle(meta, { now: at })
    let reason = null, target = 'cold'
    if (state.protected) reason = 'PROTECTED_RECORD'
    else if (meta.agreement?.state === 'open') reason = 'OPEN_AGREEMENT_EXEMPT'
    else if (mode === 'restore') { target = 'active'; if (state.tier !== 'cold') reason = 'NOT_COLD' }
    else if (state.tier !== 'active') reason = 'NOT_ACTIVE'
    else if (mode === 'maintenance') {
      if (!automaticCold) reason = 'AUTOMATIC_COLD_DISABLED'
      else if (meta.canonical_key != null || ['identity', 'preference', 'promise', 'procedure'].includes(meta.type)) reason = 'CURRENT_FACT_EXEMPT'
      else if (!['episode', 'emotion'].includes(meta.type) && !(meta.retention === 'temporary' && state.expired)) reason = 'TYPE_EXEMPT'
      else if (at - Date.parse(timestamp(meta.updated_at, 'updated_at', false)) < minAgeDays * DAY) reason = 'TOO_RECENT'
    }
    if (reason) skipped.push(Object.freeze({ record_id: meta.record_id, reason_code: reason }))
    else actions.push(Object.freeze({ record_id: meta.record_id, expected_revision: meta.revision, source_revision_id: meta.revision_id,
      from: state.tier, to: target, reason_code: mode === 'restore' ? 'OWNER_RESTORE' : mode === 'cold' ? 'OWNER_COLD' : state.expired ? 'EXPIRED_TEMPORARY' : 'AGE_BASED_COLD' }))
  }
  if (mode !== 'maintenance') for (const id of recordIds) if (!known.has(id)) skipped.push(Object.freeze({ record_id: id, reason_code: 'UNKNOWN_RECORD' }))
  const plan = { schema_version: 1, policy_version: LIFECYCLE_POLICY_VERSION, mode, at: new Date(at).toISOString(), automatic_cold: automaticCold,
    min_age_days: minAgeDays, batch_limit: batchLimit, scan_limit: scanLimit, cursor, next_cursor: remaining ? last : null,
    scanned, actions: Object.freeze(actions), skipped: Object.freeze(skipped) }
  return Object.freeze({ ...plan, checksum: digest(plan) })
}

export function createMaintenanceBaseline({ memorySpaceId, now, revisionWatermark }) {
  assertId(memorySpaceId)
  if (!Number.isSafeInteger(revisionWatermark) || revisionWatermark < 0) error('INVALID_MAINTENANCE_WATERMARK')
  return { schema_version: 1, memory_space_id: memorySpaceId, policy_version: LIFECYCLE_POLICY_VERSION, generation: 1,
    initialized_at: new Date(lifecycleTime(now)).toISOString(), baseline_revision_watermark: revisionWatermark,
    last_completed_at: null, processed_revision_watermark: null, last_checked_at: null, scan_cursor: null, scan_revision_watermark: null }
}

export function validateMaintenanceState(state, spaceId) {
  assertOnly(state, ['schema_version', 'memory_space_id', 'policy_version', 'generation', 'initialized_at', 'baseline_revision_watermark',
    'last_completed_at', 'processed_revision_watermark', 'last_checked_at', 'scan_cursor', 'scan_revision_watermark'])
  if (state.schema_version !== 1 || state.policy_version !== LIFECYCLE_POLICY_VERSION) error('UNSUPPORTED_MAINTENANCE_SCHEMA')
  assertId(state.memory_space_id); if (spaceId !== undefined && state.memory_space_id !== spaceId) error('MAINTENANCE_SCOPE_MISMATCH')
  if (!Number.isSafeInteger(state.generation) || state.generation < 1 || !Number.isSafeInteger(state.baseline_revision_watermark) || state.baseline_revision_watermark < 0) error('INVALID_MAINTENANCE_STATE')
  timestamp(state.initialized_at, 'maintenance initialized_at', false)
  timestamp(state.last_completed_at, 'last_completed_at'); timestamp(state.last_checked_at, 'last_checked_at')
  if ((state.last_completed_at === null) !== (state.processed_revision_watermark === null) ||
    state.processed_revision_watermark !== null && (!Number.isSafeInteger(state.processed_revision_watermark) || state.processed_revision_watermark < state.baseline_revision_watermark)) error('INVALID_MAINTENANCE_STATE')
  const initialized = Date.parse(state.initialized_at)
  if (state.last_completed_at && Date.parse(state.last_completed_at) < initialized || state.last_checked_at && Date.parse(state.last_checked_at) < initialized || state.last_completed_at && state.last_checked_at && Date.parse(state.last_checked_at) < Date.parse(state.last_completed_at)) error('INVALID_MAINTENANCE_STATE')
  if (state.scan_cursor !== null) assertId(state.scan_cursor)
  if ((state.scan_cursor === null) !== (state.scan_revision_watermark === null) || state.scan_revision_watermark !== null && (!Number.isSafeInteger(state.scan_revision_watermark) || state.scan_revision_watermark < (state.processed_revision_watermark ?? state.baseline_revision_watermark))) error('INVALID_MAINTENANCE_STATE')
  return state
}

export function evaluateMaintenanceDue(state, { now, revisionWatermark, days = 7, writes = 40 } = {}) {
  validateMaintenanceState(state)
  if (!Number.isSafeInteger(revisionWatermark) || revisionWatermark < 0 || !Number.isFinite(days) || days <= 0 ||
    !Number.isSafeInteger(writes) || writes < 1) error('INVALID_MAINTENANCE_POLICY')
  const floor = state.processed_revision_watermark ?? state.baseline_revision_watermark
  if (revisionWatermark < floor) error('MAINTENANCE_WATERMARK_ROLLBACK')
  const since = Date.parse(state.last_completed_at ?? state.initialized_at), at = lifecycleTime(now)
  if (at < since) error('MAINTENANCE_CLOCK_ROLLBACK')
  const dueByTime = at >= since + days * DAY, dueByWrites = revisionWatermark - floor >= writes
  return Object.freeze({ due: dueByTime || dueByWrites, due_by_time: dueByTime, due_by_writes: dueByWrites,
    writes_since_completion: revisionWatermark - floor, next_due_at: new Date(since + days * DAY).toISOString() })
}
