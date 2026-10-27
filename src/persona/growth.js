import { verifySelfIntegrity } from '../memory/v2/self-integrity.js'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { MemoryError, assertId, assertOnly, digest, failure, text, timestamp } from '../memory/v2/contracts.js'
import { isBatchEventReference, sameEvidenceOrigin } from './evidence-origin.js'

const json = (value) => `${JSON.stringify(value, null, 2)}\n`
const clone = (value) => JSON.parse(JSON.stringify(value))
const EVIDENCE_KINDS = new Map([['user_statement', 'user'], ['interaction_observation', 'host']])
const result = (status, reason, ids = {}) => ({ status, reason_code: reason, ...ids })

/** Host-owned growth service. The assessor and evidence resolver are trusted adapters. */
export class PersonaGrowth {
  #store
  #identity
  #core
  #stability
  #resolveEvidence
  #assess
  #clock
  #minimumConfidence

  constructor({ store, persona_id, agent_identity_id, core, stabilityPolicy, resolveEvidence, assessGrowth, clock = () => Date.now() }) {
    this.#store = store
    this.#identity = Object.freeze({ persona_id: assertId(persona_id), agent_identity_id: assertId(agent_identity_id) })
    if (core?.persona_id !== persona_id || typeof core.version !== 'string' || !core.allowed_dimensions || typeof core.allowed_dimensions !== 'object' || Array.isArray(core.allowed_dimensions)) throw new MemoryError('INVALID_PERSONA_CORE')
    if (typeof resolveEvidence !== 'function' || typeof assessGrowth !== 'function' || typeof stabilityPolicy?.getProfile !== 'function' || typeof stabilityPolicy?.snapshot !== 'function') throw new MemoryError('TRUSTED_GROWTH_ADAPTERS_REQUIRED')
    const binding = stabilityPolicy.snapshot()
    if (binding.persona_id !== persona_id || binding.agent_identity_id !== agent_identity_id) throw new MemoryError('STABILITY_IDENTITY_CONFLICT')
    this.#core = JSON.parse(JSON.stringify(core))
    this.#stability = stabilityPolicy
    this.#resolveEvidence = resolveEvidence
    this.#assess = assessGrowth
    this.#clock = clock
    this.#minimumConfidence = core.minimum_growth_confidence ?? 0.75
    if (!Number.isFinite(this.#minimumConfidence) || this.#minimumConfidence < 0.5 || this.#minimumConfidence > 1) throw new MemoryError('INVALID_GROWTH_CONFIDENCE_GATE')
  }

  #authorize(context, capability) {
    this.#store._authorize(context, capability)
    if (context.persona_id !== this.#identity.persona_id || context.agent_identity_id !== this.#identity.agent_identity_id) throw new MemoryError('PERSONA_IDENTITY_DENIED')
  }

  #hostContext(context) {
    return this.#store.issueContext({ ...this.#identity, subject_id: context.subject_id,
      allowed_subject_ids: context.allowed_subject_ids, session_id: context.session_id, expires_at: context.expires_at, capabilities: ['memory.manage'] })
  }

  #base() { return `self/${this.#identity.agent_identity_id}` }

  #read(path, fallback = undefined) {
    const absolute = this.#store.engine.resolvePath(path)
    if (!existsSync(absolute) && fallback !== undefined) return fallback
    try { return JSON.parse(readFileSync(absolute, 'utf8')) } catch { throw new MemoryError('INVALID_SELF_DATA') }
  }

  #manifest() {
    verifySelfIntegrity(this.#store.root, this.#store.memorySpaceId, this.#identity.agent_identity_id)
    const manifest = this.#read(`${this.#base()}/manifest.json`, { schema_version: 1, ...this.#identity,
      revision: 0, traits: {}, proposals: {}, maintenance: {} })
    if (manifest.schema_version !== 1 || manifest.persona_id !== this.#identity.persona_id || manifest.agent_identity_id !== this.#identity.agent_identity_id) throw new MemoryError('SELF_IDENTITY_CONFLICT')
    return manifest
  }

  #checkedFile(kind, id, manifest) {
    const path = `${this.#base()}/${kind}/${assertId(id)}.json`
    const entry = this.#read(path)
    if (manifest[kind]?.[id] !== digest(entry)) throw new MemoryError('EXTERNAL_SELF_CHANGE')
    if (entry.persona_id !== this.#identity.persona_id || entry.agent_identity_id !== this.#identity.agent_identity_id) throw new MemoryError('SELF_IDENTITY_CONFLICT')
    return entry
  }

  #changes(manifest, spaceManifest, files) {
    const next = { ...manifest, revision: manifest.revision + 1 }
    return [...files, { path: `${this.#base()}/manifest.json`, data: json(next) },
      { path: 'manifest.json', data: json({ ...spaceManifest, revision_watermark: spaceManifest.revision_watermark + 1 }) }]
  }

  async #completed(operationId, request, context, capability) {
    assertId(operationId, 'operation_id')
    return this.#store.managedRead(this.#hostContext(context), () => {
      this.#authorize(context, capability)
      const receipt = this.#read(`operations/${digest(operationId)}.json`, null)
      if (!receipt) return null
      if (receipt.request_hash !== digest({ action: 'managed', request, actor: context.agent_identity_id,
        subject: context.subject_id, persona: context.persona_id, space: context.memory_space_id })) throw new MemoryError('OPERATION_CONFLICT')
      return { ...receipt.result, replayed: true }
    })
  }

  async #evidence(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 64) throw new MemoryError('GROWTH_EVIDENCE_REQUIRED')
    const records = []
    const origins = new Map()
    for (const evidenceId of [...new Set(ids)]) {
      assertId(evidenceId)
      const value = await this.#resolveEvidence(evidenceId)
      if (!value || value.evidence_id !== evidenceId || value.allow_persist !== true || value.growth_eligible !== true) throw new MemoryError('GROWTH_EVIDENCE_DENIED')
      if (value.persona_id !== this.#identity.persona_id || value.agent_identity_id !== this.#identity.agent_identity_id) throw new MemoryError('GROWTH_EVIDENCE_SCOPE')
      if (!EVIDENCE_KINDS.has(value.claim_kind) || EVIDENCE_KINDS.get(value.claim_kind) !== value.source) throw new MemoryError('GROWTH_EVIDENCE_KIND')
      assertId(value.independence_key); assertId(value.session_id)
      if (value.event_evidence_id !== undefined && !isBatchEventReference(value.event_evidence_id)) throw new MemoryError('GROWTH_EVIDENCE_KIND')
      timestamp(value.occurred_at, 'growth evidence time', false)
      text(value.content, 'growth evidence content', { max: 8000 })
      if (!value.content.isWellFormed()) throw new MemoryError('INVALID_EVIDENCE_TEXT')
      const normalized = { evidence_id: value.evidence_id, source: value.source, claim_kind: value.claim_kind,
        persona_id: value.persona_id, agent_identity_id: value.agent_identity_id,
        independence_key: value.independence_key, session_id: value.session_id,
        ...(value.event_evidence_id === undefined ? {} : { event_evidence_id: value.event_evidence_id }),
        occurred_at: value.occurred_at, content: value.content }
      const previous = origins.get(normalized.independence_key)
      if (previous && !sameEvidenceOrigin(previous, normalized)) throw new MemoryError('GROWTH_INDEPENDENCE_CONFLICT')
      if (!previous) origins.set(normalized.independence_key, normalized)
      records.push(normalized)
    }
    return records
  }

  async #assessment(proposal, evidence, counterevidence) {
    const supportOrigins = new Set(evidence.map((entry) => entry.independence_key))
    if (counterevidence.some((entry) => supportOrigins.has(entry.independence_key))) throw new MemoryError('GROWTH_EVIDENCE_ROLE_CONFLICT')
    if (json([...evidence, ...counterevidence]).length > 8000) throw new MemoryError('REFLECTION_EVIDENCE_BUDGET_EXCEEDED')
    const verdict = await this.#assess(Object.freeze({ core: clone(this.#core), proposal: clone(proposal), evidence: clone(evidence), counterevidence: clone(counterevidence) }))
    if (typeof verdict?.persistable !== 'boolean' || typeof verdict?.compatible !== 'boolean' || typeof verdict?.supported !== 'boolean' || !Number.isFinite(verdict.confidence) || verdict.confidence < 0 || verdict.confidence > 1) throw new MemoryError('INVALID_GROWTH_ASSESSMENT')
    return { persistable: verdict.persistable, compatible: verdict.compatible, supported: verdict.supported, confidence: verdict.confidence,
      counterevidence_resolved: counterevidence.length === 0 || verdict.counterevidence_resolved === true }
  }

  #validateMerges(bindings, targetId) {
    if (bindings === undefined) return
    if (!Array.isArray(bindings) || bindings.length > 20 || new Set(bindings.map((entry) => entry?.proposal_id)).size !== bindings.length) throw new MemoryError('INVALID_GROWTH_MERGE')
    for (const binding of bindings) {
      assertOnly(binding, ['proposal_id', 'expected_revision'])
      assertId(binding.proposal_id)
      if (binding.proposal_id === targetId || !Number.isSafeInteger(binding.expected_revision) || binding.expected_revision < 1) throw new MemoryError('INVALID_GROWTH_MERGE')
    }
  }

  #mergeChanges(bindings, manifest, target, refs, counterRefs) {
    const changes = [], ids = []
    for (const binding of bindings ?? []) {
      const source = this.#checkedFile('proposals', binding.proposal_id, manifest)
      if (source.revision !== binding.expected_revision) throw new MemoryError('GROWTH_REVISION_CONFLICT')
      if (source.state !== 'candidate' || source.core_version !== this.#core.version) throw new MemoryError('INVALID_GROWTH_MERGE')
      if (source.evidence_refs.some((id) => !refs.includes(id)) || source.counterevidence_refs.some((id) => !counterRefs.includes(id))) throw new MemoryError('GROWTH_MERGE_EVIDENCE_REQUIRED')
      // Retain the candidate's complete original text and sources. The managed
      // receipt links this inactive entry to the target revision atomically.
      const next = { ...source, state: 'retired', revision: source.revision + 1, updated_at: new Date(this.#clock()).toISOString() }
      manifest.proposals[source.proposal_id] = digest(next)
      changes.push({ path: `${this.#base()}/proposals/${source.proposal_id}.json`, data: json(next) })
      ids.push(source.proposal_id)
    }
    return { changes, receipt: ids.length ? { merged_proposal_ids: ids, merge_target: target } : {} }
  }

  async proposeGrowth(args, context) {
    const operationId = args?.operation_id ?? randomUUID()
    try {
      this.#authorize(context, 'self.write')
      assertOnly(args, ['operation_id', 'dimension', 'scope', 'value', 'evidence_refs', 'counterevidence_refs', 'expected_trait_revision'])
      const dimension = assertId(args.dimension)
      if (!Object.hasOwn(this.#core.allowed_dimensions, dimension)) throw new MemoryError('GROWTH_DIMENSION_DENIED')
      const scope = text(args.scope ?? 'general', 'scope', { max: 100 })
      const value = text(args.value, 'value', { max: 240 })
      if (/[\r\n\u0000-\u001f]/.test(value)) throw new MemoryError('INVALID_GROWTH_VALUE')
      const traitId = `trait-${digest({ ...this.#identity, dimension, scope }).slice(0, 40)}`
      const previousTrait = await this.#store.managedRead(this.#hostContext(context), () => {
        this.#authorize(context, 'self.write')
        const manifest = this.#manifest()
        return manifest.traits[traitId] ? this.#checkedFile('traits', traitId, manifest) : null
      })
      const counterRefs = [...new Set([...(previousTrait?.counterevidence_refs ?? []), ...(args.counterevidence_refs ?? [])])]
      if (counterRefs.some((ref) => args.evidence_refs?.includes(ref))) throw new MemoryError('GROWTH_EVIDENCE_ROLE_CONFLICT')
      const evidence = await this.#evidence(args.evidence_refs)
      const counterevidence = counterRefs.length ? await this.#evidence(counterRefs) : []
      this.#authorize(context, 'self.write')
      const assessment = await this.#assessment({ dimension, scope, value }, evidence, counterevidence)
      if (!assessment.persistable || !assessment.compatible) return result('rejected', 'CORE_OR_STORAGE_BOUNDARY')
      this.#authorize(context, 'self.write')
      return await this.#store.managedTransaction(operationId, { action: 'proposeGrowth', args, ...this.#identity }, async ({ manifest: spaceManifest }) => {
        this.#authorize(context, 'self.write')
        const currentEvidence = await this.#evidence(args.evidence_refs)
        const currentCounter = counterRefs.length ? await this.#evidence(counterRefs) : []
        if (digest(currentEvidence) !== digest(evidence) || digest(currentCounter) !== digest(counterevidence)) throw new MemoryError('GROWTH_EVIDENCE_CHANGED')
        this.#authorize(context, 'self.write')
        const manifest = this.#manifest()
        const previous = manifest.traits[traitId] ? this.#checkedFile('traits', traitId, manifest) : null
        const expected = args.expected_trait_revision ?? 0
        if (!Number.isSafeInteger(expected) || expected !== (previous?.revision ?? 0) || (previous?.revision ?? 0) !== (previousTrait?.revision ?? 0)) throw new MemoryError('GROWTH_REVISION_CONFLICT')
        const proposalId = randomUUID()
        const now = new Date(this.#clock()).toISOString()
        const proposal = { schema_version: 1, proposal_id: proposalId, trait_id: traitId, ...this.#identity,
          core_version: this.#core.version, dimension, scope, value, state: 'candidate', revision: 1,
          expected_trait_revision: expected, evidence_refs: [...new Set(args.evidence_refs)],
          counterevidence_refs: counterRefs, assessment,
          created_at: now, updated_at: now, maintenance_refs: [] }
        manifest.proposals[proposalId] = digest(proposal)
        return { changes: this.#changes(manifest, spaceManifest, [{ path: `${this.#base()}/proposals/${proposalId}.json`, data: json(proposal) }]),
          result: result('candidate', 'AWAITING_INDEPENDENT_SUPPORT', { proposal_id: proposalId, trait_id: traitId, revision: 1 }) }
      }, this.#hostContext(context), { authorize: () => this.#authorize(context, 'self.write') })
    } catch (error) { return failure(error, operationId) }
  }

  async evaluateGrowth(args, context) {
    const operationId = args?.operation_id ?? randomUUID()
    try {
      this.#authorize(context, 'self.evaluate')
      assertOnly(args, ['operation_id', 'proposal_id', 'maintenance_id', 'expected_revision', 'evidence_refs', 'counterevidence_refs', 'merge_candidates'])
      assertId(args.proposal_id); assertId(args.maintenance_id)
      this.#validateMerges(args.merge_candidates, args.proposal_id)
      const completed = await this.#completed(operationId, { action: 'evaluateGrowth', args, ...this.#identity }, context, 'self.evaluate')
      if (completed) return completed
      if (!Number.isSafeInteger(args.expected_revision) || args.expected_revision < 1) throw new MemoryError('EXPECTED_REVISION_REQUIRED')
      const maintenance = await this.#maintenance(args.maintenance_id)
      this.#authorize(context, 'self.evaluate')
      const reservationId = randomUUID()
      const reservation = await this.#store.managedTransaction(`growth-reserve-${digest(operationId).slice(0, 48)}`,
        { action: 'reserveGrowthEvaluation', args, ...this.#identity }, ({ manifest: spaceManifest }) => {
        this.#authorize(context, 'self.evaluate')
        const manifest = this.#manifest()
        const proposal = this.#checkedFile('proposals', args.proposal_id, manifest)
        if (proposal.state !== 'candidate' && proposal.state !== 'disputed') return { changes: [], result: result(proposal.state, 'NO_CANDIDATE') }
        if (proposal.revision !== args.expected_revision) throw new MemoryError('GROWTH_REVISION_CONFLICT')
        const attempts = manifest.maintenance[args.maintenance_id] ?? []
        if (attempts.some((entry) => (typeof entry === 'string' ? entry : entry.proposal_id) === args.proposal_id)) {
          return { changes: [], result: result('pending', 'ALREADY_RESERVED') }
        }
        if (attempts.length >= 20) throw new MemoryError('REFLECTION_BUDGET_EXCEEDED')
        if (Date.parse(maintenance.occurred_at) <= Date.parse(proposal.created_at)) throw new MemoryError('SUBSEQUENT_MAINTENANCE_REQUIRED')
        manifest.maintenance[args.maintenance_id] = [...attempts, { proposal_id: args.proposal_id, reservation_id: reservationId, state: 'reserved' }]
        return { changes: this.#changes(manifest, spaceManifest, []),
          result: result('reserved', 'ASSESSMENT_RESERVED', { reservation_id: reservationId }) }
      }, this.#hostContext(context), { authorize: () => this.#authorize(context, 'self.evaluate') })
      if (reservation.reservation_id !== reservationId) return reservation.status === 'reserved' ? result('pending', 'EVALUATION_IN_PROGRESS') : reservation
      const before = await this.#store.managedRead(this.#hostContext(context), () => {
        this.#authorize(context, 'self.evaluate')
        return this.#checkedFile('proposals', args.proposal_id, this.#manifest())
      })
      const refs = [...new Set([...before.evidence_refs, ...(args.evidence_refs ?? [])])]
      const counterRefs = [...new Set([...before.counterevidence_refs, ...(args.counterevidence_refs ?? [])])]
      if (counterRefs.some((ref) => refs.includes(ref))) throw new MemoryError('GROWTH_EVIDENCE_ROLE_CONFLICT')
      const evidence = await this.#evidence(refs)
      const counterevidence = counterRefs.length ? await this.#evidence(counterRefs) : []
      this.#authorize(context, 'self.evaluate')
      const assessment = await this.#assessment(before, evidence, counterevidence)
      if (!assessment.persistable) return result('rejected', 'STORAGE_BOUNDARY')
      this.#authorize(context, 'self.evaluate')
      return await this.#store.managedTransaction(operationId, { action: 'evaluateGrowth', args, ...this.#identity }, async ({ manifest: spaceManifest }) => {
        this.#authorize(context, 'self.evaluate')
        const manifest = this.#manifest()
        const proposal = this.#checkedFile('proposals', args.proposal_id, manifest)
        if (proposal.revision !== args.expected_revision || proposal.revision !== before.revision) throw new MemoryError('GROWTH_REVISION_CONFLICT')
        const evaluated = manifest.maintenance[args.maintenance_id] ?? []
        const attempt = evaluated.find((entry) => entry?.proposal_id === args.proposal_id)
        if (attempt?.reservation_id !== reservationId || attempt.state !== 'reserved') throw new MemoryError('GROWTH_EVALUATION_CONFLICT')
        const currentEvidence = await this.#evidence(refs)
        const currentCounter = counterRefs.length ? await this.#evidence(counterRefs) : []
        const currentMaintenance = await this.#maintenance(args.maintenance_id)
        if (digest(currentEvidence) !== digest(evidence) || digest(currentCounter) !== digest(counterevidence) || digest(currentMaintenance) !== digest(maintenance)) throw new MemoryError('GROWTH_EVIDENCE_CHANGED')
        this.#authorize(context, 'self.evaluate')
        const maintenanceTime = Date.parse(maintenance.occurred_at)
        if (!Number.isFinite(maintenanceTime) || maintenanceTime <= Date.parse(proposal.created_at)) throw new MemoryError('SUBSEQUENT_MAINTENANCE_REQUIRED')
        const maintenanceRefs = [...new Set([...proposal.maintenance_refs, args.maintenance_id])]
        const uniqueEvents = new Map(evidence.map((entry) => [entry.independence_key, entry]))
        const sessions = new Set([...uniqueEvents.values()].map((entry) => entry.session_id))
        const requirements = this.#stability.getProfile().growth_requirements
        let state = 'candidate'
        if (!assessment.compatible || !assessment.supported || !assessment.counterevidence_resolved || proposal.core_version !== this.#core.version) state = 'disputed'
        else if (assessment.confidence >= this.#minimumConfidence && uniqueEvents.size >= requirements.independent_events && sessions.size >= requirements.sessions && maintenanceRefs.length >= requirements.subsequent_maintenance) state = 'stable'
        const next = { ...proposal, state, revision: proposal.revision + 1, evidence_refs: refs,
          counterevidence_refs: counterRefs, maintenance_refs: maintenanceRefs, assessment, updated_at: new Date(this.#clock()).toISOString() }
        const merged = this.#mergeChanges(args.merge_candidates, manifest, { kind: 'proposal', id: proposal.proposal_id, revision: next.revision }, refs, counterRefs)
        const changes = [...merged.changes, { path: `${this.#base()}/proposals/${args.proposal_id}.json`, data: json(next) }]
        if (state === 'stable') {
          const previous = manifest.traits[proposal.trait_id] ? this.#checkedFile('traits', proposal.trait_id, manifest) : null
          if ((previous?.revision ?? 0) !== proposal.expected_trait_revision) throw new MemoryError('GROWTH_REVISION_CONFLICT')
          const trait = { schema_version: 1, trait_id: proposal.trait_id, ...this.#identity,
            core_version: this.#core.version, dimension: proposal.dimension, scope: proposal.scope, value: proposal.value,
            state: 'stable', revision: (previous?.revision ?? 0) + 1, evidence_refs: refs, counterevidence_refs: counterRefs, assessment,
            formed_at: previous?.formed_at ?? next.updated_at, updated_at: next.updated_at,
            supersedes_revision: previous?.revision ?? null, proposal_id: proposal.proposal_id }
          if (previous) changes.push({ path: `${this.#base()}/history/${trait.trait_id}/${previous.revision}.json`, data: json(previous) })
          changes.push({ path: `${this.#base()}/traits/${trait.trait_id}.json`, data: json(trait) })
          manifest.traits[trait.trait_id] = digest(trait)
        }
        manifest.proposals[args.proposal_id] = digest(next)
        manifest.maintenance[args.maintenance_id] = evaluated.map((entry) => entry === attempt ? { ...entry, state: 'completed' } : entry)
        return { changes: this.#changes(manifest, spaceManifest, changes), result: result(state, state === 'stable' ? 'SUPPORTED_GROWTH' : state === 'disputed' ? 'REQUIRES_REVIEW' : 'MORE_SUPPORT_REQUIRED',
          { proposal_id: args.proposal_id, trait_id: proposal.trait_id, revision: next.revision, ...merged.receipt }) }
      }, this.#hostContext(context), { authorize: () => this.#authorize(context, 'self.evaluate') })
    } catch (error) { return failure(error, operationId) }
  }

  async #maintenance(id) {
    const entry = await this.#resolveEvidence(id)
    if (entry?.evidence_id !== id || entry.type !== 'maintenance' || entry.source !== 'host' || entry.claim_kind !== 'maintenance' || entry.completed !== true || entry.persona_id !== this.#identity.persona_id || entry.agent_identity_id !== this.#identity.agent_identity_id) throw new MemoryError('TRUSTED_MAINTENANCE_REQUIRED')
    timestamp(entry.occurred_at, 'maintenance time', false)
    return { evidence_id: id, ...this.#identity, type: 'maintenance', source: 'host', claim_kind: 'maintenance', completed: true, occurred_at: entry.occurred_at }
  }

  async reviewTrait(args, context) {
    const operationId = args?.operation_id ?? randomUUID()
    try {
      this.#authorize(context, 'self.evaluate')
      assertOnly(args, ['operation_id', 'trait_id', 'expected_revision', 'maintenance_id', 'evidence_refs', 'counterevidence_refs', 'action', 'merge_candidates'])
      assertId(args.trait_id); assertId(args.maintenance_id)
      this.#validateMerges(args.merge_candidates, args.trait_id)
      if (!['reassess', 'retire'].includes(args.action ?? 'reassess')) throw new MemoryError('INVALID_GROWTH_ACTION')
      if (!Number.isSafeInteger(args.expected_revision) || args.expected_revision < 1) throw new MemoryError('EXPECTED_REVISION_REQUIRED')
      const completed = await this.#completed(operationId, { action: 'reviewTrait', args, ...this.#identity }, context, 'self.evaluate')
      if (completed) return completed
      const maintenance = await this.#maintenance(args.maintenance_id)
      const reservationId = randomUUID()
      const reservation = await this.#store.managedTransaction(`growth-review-reserve-${digest(operationId).slice(0, 40)}`,
        { action: 'reserveTraitReview', args, ...this.#identity }, ({ manifest: spaceManifest }) => {
          this.#authorize(context, 'self.evaluate')
          const manifest = this.#manifest()
          const trait = this.#checkedFile('traits', args.trait_id, manifest)
          if (trait.revision !== args.expected_revision) throw new MemoryError('GROWTH_REVISION_CONFLICT')
          if (trait.state === 'retired') return { changes: [], result: result('retired', 'NO_ACTIVE_TRAIT') }
          const key = `trait:${args.trait_id}`
          const attempts = manifest.maintenance[args.maintenance_id] ?? []
          if (attempts.some((entry) => entry?.proposal_id === key)) return { changes: [], result: result('pending', 'ALREADY_RESERVED') }
          if (attempts.length >= 20) throw new MemoryError('REFLECTION_BUDGET_EXCEEDED')
          manifest.maintenance[args.maintenance_id] = [...attempts, { proposal_id: key, reservation_id: reservationId, state: 'reserved' }]
          return { changes: this.#changes(manifest, spaceManifest, []), result: result('reserved', 'ASSESSMENT_RESERVED', { reservation_id: reservationId }) }
        }, this.#hostContext(context), { authorize: () => this.#authorize(context, 'self.evaluate') })
      if (reservation.reservation_id !== reservationId) return reservation.status === 'reserved' ? result('pending', 'EVALUATION_IN_PROGRESS') : reservation
      const before = await this.#store.managedRead(this.#hostContext(context), () => {
        this.#authorize(context, 'self.evaluate')
        return this.#checkedFile('traits', args.trait_id, this.#manifest())
      })
      const refs = [...new Set([...before.evidence_refs, ...(args.evidence_refs ?? [])])]
      const counterRefs = [...new Set([...(before.counterevidence_refs ?? []), ...(args.counterevidence_refs ?? [])])]
      if (counterRefs.some((ref) => refs.includes(ref))) throw new MemoryError('GROWTH_EVIDENCE_ROLE_CONFLICT')
      const evidence = await this.#evidence(refs)
      const counterevidence = counterRefs.length ? await this.#evidence(counterRefs) : []
      this.#authorize(context, 'self.evaluate')
      const assessment = await this.#assessment(before, evidence, counterevidence)
      if (!assessment.persistable) return result('rejected', 'STORAGE_BOUNDARY')
      this.#authorize(context, 'self.evaluate')
      return await this.#store.managedTransaction(operationId, { action: 'reviewTrait', args, ...this.#identity }, async ({ manifest: spaceManifest }) => {
        this.#authorize(context, 'self.evaluate')
        const manifest = this.#manifest()
        const trait = this.#checkedFile('traits', args.trait_id, manifest)
        if (trait.revision !== args.expected_revision || trait.revision !== before.revision) throw new MemoryError('GROWTH_REVISION_CONFLICT')
        const attempts = manifest.maintenance[args.maintenance_id] ?? []
        const attempt = attempts.find((entry) => entry?.proposal_id === `trait:${args.trait_id}`)
        if (attempt?.reservation_id !== reservationId || attempt.state !== 'reserved') throw new MemoryError('GROWTH_EVALUATION_CONFLICT')
        if (digest(await this.#evidence(refs)) !== digest(evidence) || digest(counterRefs.length ? await this.#evidence(counterRefs) : []) !== digest(counterevidence) || digest(await this.#maintenance(args.maintenance_id)) !== digest(maintenance)) throw new MemoryError('GROWTH_EVIDENCE_CHANGED')
        this.#authorize(context, 'self.evaluate')
        const reviewRefs = [...new Set([...(trait.review_maintenance_refs ?? []), args.maintenance_id])]
        const reviewMaintenance = await Promise.all(reviewRefs.map((id) => this.#maintenance(id)))
        const mostRecentCounter = Math.max(-Infinity, ...counterevidence.map((entry) => Date.parse(entry.occurred_at)))
        const subsequent = reviewMaintenance.filter((entry) => Date.parse(entry.occurred_at) > mostRecentCounter).length
        const independentCounter = new Map(counterevidence.map((entry) => [entry.independence_key, entry]))
        const sessions = new Set([...independentCounter.values()].map((entry) => entry.session_id))
        const requirements = this.#stability.getProfile().growth_requirements
        const sufficient = independentCounter.size >= requirements.independent_events && sessions.size >= requirements.sessions && subsequent >= requirements.subsequent_maintenance
        let state = trait.state
        if (!assessment.compatible || trait.core_version !== this.#core.version) state = 'disputed'
        else if (sufficient && (!assessment.supported || !assessment.counterevidence_resolved)) state = args.action === 'retire' ? 'retired' : 'disputed'
        else if (assessment.supported && assessment.counterevidence_resolved && assessment.confidence >= this.#minimumConfidence) state = 'stable'
        const next = { ...trait, state, revision: trait.revision + 1, evidence_refs: refs, counterevidence_refs: counterRefs,
          review_maintenance_refs: reviewRefs, assessment, unresolved_counterevidence: !assessment.counterevidence_resolved,
          updated_at: new Date(this.#clock()).toISOString(), supersedes_revision: trait.revision }
        const merged = this.#mergeChanges(args.merge_candidates, manifest, { kind: 'trait', id: trait.trait_id, revision: next.revision }, refs, counterRefs)
        this.#authorize(context, 'self.evaluate')
        manifest.traits[trait.trait_id] = digest(next)
        manifest.maintenance[args.maintenance_id] = attempts.map((entry) => entry === attempt ? { ...entry, state: 'completed' } : entry)
        return { changes: this.#changes(manifest, spaceManifest, [
          ...merged.changes,
          { path: `${this.#base()}/history/${trait.trait_id}/${trait.revision}.json`, data: json(trait) },
          { path: `${this.#base()}/traits/${trait.trait_id}.json`, data: json(next) },
        ]), result: result(state, state === 'retired' ? 'SUPPORTED_RETIREMENT' : state === 'disputed' ? 'REQUIRES_REVIEW' : 'REVIEW_RECORDED', { trait_id: trait.trait_id, revision: next.revision, ...merged.receipt }) }
      }, this.#hostContext(context), { authorize: () => this.#authorize(context, 'self.evaluate') })
    } catch (error) { return failure(error, operationId) }
  }

  async listCandidates(context, { limit = 20 } = {}) {
    try {
      this.#authorize(context, 'self.evaluate')
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new MemoryError('INVALID_GROWTH_LIMIT')
      return await this.#store.managedRead(this.#hostContext(context), async () => {
        this.#authorize(context, 'self.evaluate')
        const manifest = this.#manifest()
        const proposals = []
        for (const proposalId of Object.keys(manifest.proposals)) {
          const proposal = this.#checkedFile('proposals', proposalId, manifest)
          if (proposal.state !== 'candidate' || proposal.core_version !== this.#core.version) continue
          try {
            await this.#evidence(proposal.evidence_refs)
            if (proposal.counterevidence_refs.length) await this.#evidence(proposal.counterevidence_refs)
          } catch { continue }
          proposals.push(proposal)
        }
        this.#authorize(context, 'self.evaluate')
        return { status: 'ok', ...this.#identity,
          proposals: clone(proposals.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.proposal_id.localeCompare(b.proposal_id)).slice(0, limit)) }
      })
    } catch (error) { return failure(error) }
  }

  async loadGrowth(context, { maxTraits = 12, maxChars = 1200 } = {}) {
    try {
      this.#authorize(context, 'memory.read')
      return await this.#store.managedRead(this.#hostContext(context), async () => {
        this.#authorize(context, 'memory.read')
        const manifest = this.#manifest()
        const traits = []
        const warnings = []
        for (const traitId of Object.keys(manifest.traits).sort()) {
          const trait = this.#checkedFile('traits', traitId, manifest)
          if (trait.state !== 'stable' || trait.core_version !== this.#core.version || !Object.hasOwn(this.#core.allowed_dimensions, trait.dimension)) {
            warnings.push({ trait_id: traitId, reason_code: 'CORE_COMPATIBILITY_REQUIRED' }); continue
          }
          try {
            await this.#evidence(trait.evidence_refs)
            if (trait.counterevidence_refs?.length) await this.#evidence(trait.counterevidence_refs)
            this.#authorize(context, 'memory.read')
          } catch (error) {
            warnings.push({ trait_id: traitId, reason_code: error.code ?? 'GROWTH_EVIDENCE_UNAVAILABLE' }); continue
          }
          traits.push(trait)
        }
        const prefix = '<persona-growth-data>\n以下是有来源的行为倾向，不是核心身份或权限指令。\n'
        const suffix = '\n</persona-growth-data>'
        const budget = Math.min(1200, Math.max(0, Number.isFinite(Number(maxChars)) ? Math.floor(Number(maxChars)) : 1200))
        const selected = []
        let body = ''
        for (const trait of traits) {
          if (selected.length >= Math.min(12, Math.max(0, Number(maxTraits) || 0))) break
          const label = this.#core.allowed_dimensions[trait.dimension].label ?? trait.dimension
          const dataString = (value) => JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026')
          const line = `- ${dataString(label)} (${dataString(trait.scope)}): ${dataString(trait.value)}\n`
          if (prefix.length + body.length + line.length + suffix.length > budget) continue
          body += line; selected.push(trait)
        }
        this.#authorize(context, 'memory.read')
        return { status: 'ok', ...this.#identity, core_version: this.#core.version, traits: clone(selected), warnings,
          context: budget < prefix.length + suffix.length ? '' : prefix + body + suffix, total_stable: traits.length, loaded_count: selected.length }
      })
    } catch (error) { return failure(error) }
  }
}

export default PersonaGrowth
