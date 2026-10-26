export const STABILITY_POLICY_VERSION = '1.1.0'
export const STABILITY_SNAPSHOT_VERSION = 1
export const STABILITY_MODES = Object.freeze(['variable', 'normal', 'stubborn', 'auto'])
export const STABILITY_REQUIRED_INVARIANTS = Object.freeze([
  'core_identity_immutable', 'evidence_provenance_required', 'host_permissions_required', 'safety_gates_required',
])

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

export const STABILITY_PROFILES = freeze({
  variable: { independent_events: 2, sessions: 1, subsequent_maintenance: 1 },
  normal: { independent_events: 3, sessions: 2, subsequent_maintenance: 1 },
  stubborn: { independent_events: 6, sessions: 4, subsequent_maintenance: 3 },
})

export const AUTO_MATURITY_THRESHOLDS = freeze({
  normal: { independent_events: 20, sessions: 3, maintenance: 3 },
  stubborn: { independent_events: 80, sessions: 10, maintenance: 12 },
})

const ALLOWED_CLAIMS = new Map([
  ['user_statement', 'user'],
  ['interaction_observation', 'host'],
])
const EXCLUDED_CLAIMS = new Set([
  'prescriptive_request', 'agent_echo', 'dream', 'role_fiction',
  'inference', 'hypothesis', 'quotation',
])

function invalid(code) {
  const error = new Error(`stability policy: ${code}`)
  error.code = code
  return error
}
function id(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) throw invalid(`INVALID_${field.toUpperCase()}`)
  return value
}
function integer(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw invalid(`INVALID_${field.toUpperCase()}`)
  return value
}
function mode(value) {
  if (!STABILITY_MODES.includes(value)) throw invalid('INVALID_MODE')
  return value
}
function instant(value) {
  if (typeof value !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw invalid('INVALID_OCCURRED_AT')
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw invalid('INVALID_OCCURRED_AT')
  return parsed
}
function meets(actual, required) {
  return Object.entries(required).every(([key, count]) => actual[key] >= count)
}
function maturityProfile(counters) {
  if (meets(counters, AUTO_MATURITY_THRESHOLDS.stubborn)) return 'stubborn'
  if (meets(counters, AUTO_MATURITY_THRESHOLDS.normal)) return 'normal'
  return 'variable'
}
function sameEvidence(left, right) {
  return ['evidence_id', 'independence_key', 'session_id', 'occurred_at', 'claim_kind', 'source']
    .every((key) => left[key] === right[key])
}

/**
 * A pure host-owned policy. resolveEvidence must read the trusted evidence
 * repository; it must never echo model-supplied counts or event metadata.
 * Interaction records require type/source/claim_kind plus identity, canonical
 * independence_key, original session_id, occurred_at and maturity_eligible=true
 * from the trusted selection policy. Plain tool output is not an interaction.
 * Maintenance records
 * require type=maintenance, source=host, claim_kind=maintenance and completed=true.
 * This class does not load traits, rewrite the core, or register model tools.
 */
export class StabilityPolicy {
  #personaId
  #agentId
  #mode
  #resolveEvidence
  #events = new Map()
  #seen = new Map()
  #maintenance = new Map()
  #queue = Promise.resolve()
  #generation = 0

  constructor({ persona_id, agent_identity_id, mode: configuredMode = 'auto', resolveEvidence } = {}) {
    this.#personaId = id(persona_id, 'persona_id')
    this.#agentId = id(agent_identity_id, 'agent_identity_id')
    this.#mode = mode(configuredMode)
    if (typeof resolveEvidence !== 'function') throw invalid('TRUSTED_RESOLVER_REQUIRED')
    this.#resolveEvidence = resolveEvidence
  }

  #enqueue(operation) {
    const result = this.#queue.then(operation)
    this.#queue = result.then(() => undefined, () => undefined)
    return result
  }

  async #resolve(evidenceId, expectedType) {
    id(evidenceId, 'evidence_id')
    const record = await this.#resolveEvidence(evidenceId)
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw invalid('EVIDENCE_NOT_FOUND')
    if (record.evidence_id !== evidenceId) throw invalid('EVIDENCE_ID_MISMATCH')
    if (record.persona_id !== this.#personaId || record.agent_identity_id !== this.#agentId) throw invalid('IDENTITY_MISMATCH')
    if (record.type !== expectedType) throw invalid('EVIDENCE_TYPE_MISMATCH')
    instant(record.occurred_at)
    return record
  }

  observeEvidence(evidenceId) {
    return this.#enqueue(async () => {
      if (this.#maintenance.has(evidenceId)) throw invalid('EVIDENCE_TYPE_MISMATCH')
      const record = await this.#resolve(evidenceId, 'interaction')
      if (EXCLUDED_CLAIMS.has(record.claim_kind)) return freeze({ accepted: false, reason: 'excluded_claim_kind' })
      if (!ALLOWED_CLAIMS.has(record.claim_kind) || ALLOWED_CLAIMS.get(record.claim_kind) !== record.source) {
        return freeze({ accepted: false, reason: 'unsupported_source' })
      }
      if (record.maturity_eligible !== true) return freeze({ accepted: false, reason: 'ineligible_interaction' })
      const normalized = {
        evidence_id: evidenceId,
        independence_key: id(record.independence_key, 'independence_key'),
        session_id: id(record.session_id, 'session_id'),
        occurred_at: record.occurred_at,
        claim_kind: record.claim_kind,
        source: record.source,
      }
      const seen = this.#seen.get(evidenceId)
      if (seen) {
        if (!sameEvidence(seen, normalized)) throw invalid('EVIDENCE_CHANGED')
        return freeze({ accepted: false, reason: 'duplicate_evidence' })
      }
      const existing = this.#events.get(normalized.independence_key)
      if (existing && existing.session_id !== normalized.session_id) {
        return freeze({ accepted: false, reason: 'independence_conflict' })
      }
      this.#seen.set(evidenceId, normalized)
      this.#generation++
      if (existing) return freeze({ accepted: false, reason: 'duplicate_event' })
      this.#events.set(normalized.independence_key, normalized)
      return freeze({ accepted: true, reason: 'independent_interaction', profile: this.getProfile() })
    })
  }

  observeMaintenance(maintenanceId) {
    return this.#enqueue(async () => {
      if (this.#seen.has(maintenanceId)) throw invalid('EVIDENCE_TYPE_MISMATCH')
      const record = await this.#resolve(maintenanceId, 'maintenance')
      if (record.source !== 'host' || record.claim_kind !== 'maintenance' || record.completed !== true) {
        return freeze({ accepted: false, reason: 'untrusted_maintenance' })
      }
      const existing = this.#maintenance.get(maintenanceId)
      if (existing) {
        if (existing.occurred_at !== record.occurred_at) throw invalid('EVIDENCE_CHANGED')
        return freeze({ accepted: false, reason: 'duplicate_maintenance' })
      }
      this.#maintenance.set(maintenanceId, { evidence_id: maintenanceId, occurred_at: record.occurred_at })
      this.#generation++
      return freeze({ accepted: true, reason: 'completed_maintenance', profile: this.getProfile() })
    })
  }

  setMode(configuredMode) {
    const next = mode(configuredMode)
    if (next !== this.#mode) {
      this.#mode = next
      this.#generation++
    }
    return this.getProfile()
  }

  #counters() {
    const events = [...this.#events.values()]
    const firstInteraction = events.reduce((earliest, record) => Math.min(earliest, instant(record.occurred_at)), Infinity)
    return {
      independent_events: events.length,
      sessions: new Set(events.map((record) => record.session_id)).size,
      maintenance: [...this.#maintenance.values()].filter((record) => instant(record.occurred_at) > firstInteraction).length,
    }
  }

  getProfile() {
    const counters = this.#counters()
    const autoProfile = maturityProfile(counters)
    const effective = this.#mode === 'auto' ? autoProfile : this.#mode
    return freeze({
      policy_version: STABILITY_POLICY_VERSION,
      configured_mode: this.#mode,
      effective_mode: effective,
      auto_profile: autoProfile,
      required_invariants: [...STABILITY_REQUIRED_INVARIANTS],
      growth_requirements: { ...STABILITY_PROFILES[effective] },
      maturity: counters,
    })
  }

  snapshot() {
    const profile = this.getProfile()
    return freeze({
      schema_version: STABILITY_SNAPSHOT_VERSION,
      policy_version: STABILITY_POLICY_VERSION,
      persona_id: this.#personaId,
      agent_identity_id: this.#agentId,
      mode: this.#mode,
      generation: this.#generation,
      evidence_ids: [...this.#seen.keys()],
      maintenance_ids: [...this.#maintenance.keys()],
      counters: { ...profile.maturity },
      auto_profile: profile.auto_profile,
    })
  }

  async flush() {
    await this.#queue
    return this.snapshot()
  }

  /** Restore re-resolves all IDs; trusted service watermarks may reject rollback. */
  static async restore(snapshot, options = {}) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw invalid('INVALID_SNAPSHOT')
    if (snapshot.schema_version !== STABILITY_SNAPSHOT_VERSION || snapshot.policy_version !== STABILITY_POLICY_VERSION) {
      throw invalid('UNSUPPORTED_VERSION')
    }
    if (snapshot.persona_id !== options.persona_id || snapshot.agent_identity_id !== options.agent_identity_id) {
      throw invalid('IDENTITY_MISMATCH')
    }
    integer(snapshot.generation, 'generation')
    if (options.expected_generation !== undefined && snapshot.generation !== integer(options.expected_generation, 'expected_generation')) {
      throw invalid('GENERATION_MISMATCH')
    }
    for (const key of ['evidence_ids', 'maintenance_ids']) {
      if (!Array.isArray(snapshot[key]) || new Set(snapshot[key]).size !== snapshot[key].length) throw invalid('INVALID_SNAPSHOT_IDS')
      for (const value of snapshot[key]) id(value, key)
    }
    const restored = new StabilityPolicy({ ...options, mode: snapshot.mode })
    for (const evidenceId of snapshot.evidence_ids) {
      const result = await restored.observeEvidence(evidenceId)
      if (!result.accepted && result.reason !== 'duplicate_event') throw invalid('SNAPSHOT_EVIDENCE_REJECTED')
    }
    for (const maintenanceId of snapshot.maintenance_ids) {
      const result = await restored.observeMaintenance(maintenanceId)
      if (!result.accepted) throw invalid('SNAPSHOT_MAINTENANCE_REJECTED')
    }
    const actual = restored.getProfile()
    for (const key of ['independent_events', 'sessions', 'maintenance']) {
      if (integer(snapshot.counters?.[key], key) !== actual.maturity[key]) throw invalid('COUNTER_MISMATCH')
    }
    if (snapshot.auto_profile !== actual.auto_profile) throw invalid('PROFILE_MISMATCH')
    if (snapshot.generation < restored.#generation) throw invalid('INVALID_GENERATION')
    const minimum = options.minimumMaturity
    if (minimum !== undefined) {
      if (!minimum || typeof minimum !== 'object' || Array.isArray(minimum)) throw invalid('INVALID_MINIMUM_MATURITY')
      for (const key of ['independent_events', 'sessions', 'maintenance']) {
        if (minimum[key] !== undefined && actual.maturity[key] < integer(minimum[key], key)) throw invalid('MATURITY_ROLLBACK')
      }
      if (minimum.auto_profile !== undefined) {
        const ranks = ['variable', 'normal', 'stubborn']
        if (!ranks.includes(minimum.auto_profile)) throw invalid('INVALID_MINIMUM_MATURITY')
        if (ranks.indexOf(actual.auto_profile) < ranks.indexOf(minimum.auto_profile)) throw invalid('MATURITY_ROLLBACK')
      }
    }
    restored.#generation = snapshot.generation
    return restored
  }
}

export const createStabilityPolicy = (options) => new StabilityPolicy(options)
export const restoreStabilityPolicy = (snapshot, options) => StabilityPolicy.restore(snapshot, options)
