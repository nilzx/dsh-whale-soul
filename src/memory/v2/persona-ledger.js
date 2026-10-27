import { existsSync, lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve, relative, sep } from 'node:path'
import { MemoryError, assertId, assertOnly, digest, timestamp } from './contracts.js'
import { evidenceBinding, validateItemBinding, validateBoundItemPayload } from './batch-bindings.js'
import { StabilityPolicy, STABILITY_MODES } from '../../shared/stability-policy.js'

export const PERSONA_LEDGER_PATH = '.administration/persona-ledger.json'
const json = (value) => `${JSON.stringify(value, null, 2)}\n`
const clone = (value) => JSON.parse(JSON.stringify(value))
function safe(root, path) {
  const target = resolve(root, path), rel = relative(root, target)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) throw new MemoryError('UNSAFE_STORAGE_PATH')
  let current = root
  for (const part of rel.split(sep)) { current = join(current, part); try { if (lstatSync(current).isSymbolicLink()) throw new MemoryError('UNSAFE_STORAGE_PATH') } catch (error) { if (error.code !== 'ENOENT') throw error } }
  return target
}
function read(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return fallback; throw new MemoryError('PERSONA_STATE_REPAIR_REQUIRED') }
}
export function normalizeIndividualKey(value = 'default') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) throw new MemoryError('INVALID_INDIVIDUAL_KEY')
  return value
}
export function personaBinding(personaId, subjectId, individualKey = 'default') {
  const identity = { persona_id: assertId(personaId), subject_id: assertId(subjectId) }, key = normalizeIndividualKey(individualKey)
  return `binding-${digest(key === 'default' ? identity : { binding_scheme: 2, ...identity, individual_key: key }).slice(0, 40)}`
}
export function personaIdentityProjection(anchor) {
  return { persona_id: anchor.persona_id, subject_id: anchor.subject_id, agent_identity_id: anchor.agent_identity_id, created_at: anchor.created_at,
    ...(anchor.schema_version === 3 ? { binding_id: anchor.binding_id, individual_key: anchor.individual_key } : {}) }
}
export function projectedIdentityBinding(identity) {
  const key = normalizeIndividualKey(identity?.individual_key)
  const binding = personaBinding(identity?.persona_id, identity?.subject_id, key)
  if (key !== 'default' && identity.binding_id !== binding || key === 'default' && identity.binding_id !== undefined && identity.binding_id !== binding) throw new MemoryError('PERSONA_IDENTITY_CONFLICT')
  return binding
}
export function loadPersonaLedger(root) {
  const ledger = read(safe(root, PERSONA_LEDGER_PATH), { schema_version: 1, spaces: {} })
  if (ledger?.schema_version !== 1 || !ledger.spaces || Array.isArray(ledger.spaces) || typeof ledger.spaces !== 'object') throw new MemoryError('PERSONA_STATE_REPAIR_REQUIRED')
  return ledger
}
export function getPersonaAnchor(root, spaceId, binding) {
  const spaces = loadPersonaLedger(root).spaces
  const space = Object.hasOwn(spaces, assertId(spaceId)) ? spaces[spaceId] : {}
  const anchor = space && Object.hasOwn(space, assertId(binding)) ? space[binding] : null
  if (anchor) validatePersonaAnchor(anchor)
  return anchor ? clone(anchor) : null
}
export function validatePersonaAnchor(anchor) {
  assertOnly(anchor, ['schema_version', 'memory_space_id', 'binding_id', 'persona_id', 'agent_identity_id', 'subject_id', 'core_version', 'created_at', 'revision', 'credentials', 'revoked_ids', 'snapshot', 'management_resets', 'items', 'individual_key', 'binding_scheme'])
  if (!anchor || ![1, 2, 3].includes(anchor.schema_version) || !Number.isSafeInteger(anchor.revision) || anchor.revision < 1) throw new MemoryError('PERSONA_STATE_REPAIR_REQUIRED')
  timestamp(anchor.created_at, 'persona created_at', false)
  if (typeof anchor.core_version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(anchor.core_version)) throw new MemoryError('PERSONA_STATE_REPAIR_REQUIRED')
  for (const key of ['memory_space_id', 'binding_id', 'persona_id', 'agent_identity_id', 'subject_id']) assertId(anchor[key])
  if (anchor.schema_version === 3) {
    if (anchor.binding_scheme !== 2 || normalizeIndividualKey(anchor.individual_key) === 'default') throw new MemoryError('PERSONA_STATE_REPAIR_REQUIRED')
  } else if (anchor.individual_key !== undefined || anchor.binding_scheme !== undefined) throw new MemoryError('PERSONA_STATE_REPAIR_REQUIRED')
  if (anchor.binding_id !== personaBinding(anchor.persona_id, anchor.subject_id, anchor.individual_key)) throw new MemoryError('PERSONA_STATE_REPAIR_REQUIRED')
  if (!Array.isArray(anchor.credentials) || !Array.isArray(anchor.revoked_ids) || new Set(anchor.credentials.map((v) => v.evidence_id)).size !== anchor.credentials.length) throw new MemoryError('PERSONA_STATE_REPAIR_REQUIRED')
  anchor.revoked_ids.forEach((id) => assertId(id))
  const credentialKeys = new Set(['evidence_id', 'type', 'persona_id', 'agent_identity_id', 'independence_key', 'session_id', 'occurred_at', 'source', 'claim_kind', 'allow_persist', 'growth_eligible', 'maturity_eligible', 'source_hash', 'payload_hash', 'completed', 'plan_version', 'item_ids', 'plan_hash', 'normalized_content_hash', 'duplicate_content', 'plan_decision', 'reason_code', 'message_id', 'content_units'])
  for (const credential of anchor.credentials) {
    if (!credential || Object.keys(credential).some((key) => !credentialKeys.has(key)) || Object.hasOwn(credential, 'content') || Object.hasOwn(credential, 'value') || Object.hasOwn(credential, 'quote')) throw new MemoryError('PERSONA_CREDENTIAL_CONTENT_FORBIDDEN')
    for (const key of ['evidence_id', 'persona_id', 'agent_identity_id']) assertId(credential[key])
    if (!['interaction', 'maintenance'].includes(credential.type) || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(credential.occurred_at) || !Number.isFinite(Date.parse(credential.occurred_at))) throw new MemoryError('PERSONA_STATE_REPAIR_REQUIRED')
    if (credential.source_hash !== undefined && !/^[a-f0-9]{64}$/.test(credential.source_hash)) throw new MemoryError('PERSONA_STATE_REPAIR_REQUIRED')
    if (credential.type === 'interaction') {
      assertId(credential.independence_key); assertId(credential.session_id)
      if (!['user', 'host'].includes(credential.source) || credential.claim_kind !== (credential.source === 'user' ? 'user_statement' : 'interaction_observation') || ['allow_persist', 'growth_eligible', 'maturity_eligible'].some((key) => typeof credential[key] !== 'boolean') || credential.growth_eligible && !credential.allow_persist || !credential.source_hash) throw new MemoryError('PERSONA_STATE_REPAIR_REQUIRED')
    } else if (credential.source !== 'host' || credential.claim_kind !== 'maintenance' || credential.completed !== true || credential.allow_persist !== true) throw new MemoryError('PERSONA_STATE_REPAIR_REQUIRED')
    if (credential.allow_persist === true && !credential.payload_hash) throw new MemoryError('PERSONA_STATE_REPAIR_REQUIRED')
    if (credential.payload_hash !== undefined && !/^[a-f0-9]{64}$/.test(credential.payload_hash)) throw new MemoryError('PERSONA_STATE_REPAIR_REQUIRED')
    if (credential.persona_id !== anchor.persona_id || credential.agent_identity_id !== anchor.agent_identity_id) throw new MemoryError('PERSONA_STATE_REPAIR_REQUIRED')
  }
  if (anchor.schema_version === 1 && anchor.items !== undefined || anchor.schema_version >= 2 && !Array.isArray(anchor.items)) throw new MemoryError('PERSONA_STATE_REPAIR_REQUIRED')
  const items = anchor.items ?? []
  if (new Set(items.map((item) => item.evidence_id)).size !== items.length) throw new MemoryError('INVALID_BATCH_BINDING')
  items.forEach(validateItemBinding)
  const hashes = new Set(), allContent = new Set()
  for (const credential of anchor.credentials) {
    if (credential.normalized_content_hash !== undefined && !/^[a-f0-9]{64}$/.test(credential.normalized_content_hash)) throw new MemoryError('INVALID_BATCH_BINDING')
    if (credential.normalized_content_hash) {
      const repeated = allContent.has(credential.normalized_content_hash)
      if (credential.duplicate_content !== repeated) throw new MemoryError('PERSONA_DUPLICATE_QUALIFICATION_CONFLICT')
      allContent.add(credential.normalized_content_hash)
    }
    if (credential.duplicate_content !== undefined && (typeof credential.duplicate_content !== 'boolean' || credential.duplicate_content && (credential.maturity_eligible || credential.growth_eligible))) throw new MemoryError('INVALID_BATCH_BINDING')
    if (anchor.schema_version === 1 && ['normalized_content_hash','duplicate_content','plan_version','item_ids','plan_hash'].some((key) => credential[key] !== undefined)) throw new MemoryError('INVALID_BATCH_BINDING')
    if (credential.plan_version !== undefined) {
      if (anchor.schema_version < 2 || credential.plan_version !== 2 || credential.allow_persist !== false || credential.growth_eligible !== false || !Array.isArray(credential.item_ids) || credential.item_ids.length > 4 || new Set(credential.item_ids).size !== credential.item_ids.length || !/^[a-f0-9]{64}$/.test(credential.plan_hash) || !/^[a-f0-9]{64}$/.test(credential.normalized_content_hash) || typeof credential.duplicate_content !== 'boolean' || credential.duplicate_content && credential.maturity_eligible || !['selected', 'ignore'].includes(credential.plan_decision) || !['SELECTED_ITEMS','NO_PERSISTENT_VALUE'].includes(credential.reason_code) || !Number.isSafeInteger(credential.content_units) || credential.content_units < 1 || credential.content_units > 8000) throw new MemoryError('INVALID_BATCH_BINDING')
      assertId(credential.message_id)
      const bound = items.filter((item) => item.event_evidence_id === credential.evidence_id)
      if (digest([...credential.item_ids].sort()) !== digest(bound.map((item) => item.evidence_id).sort()) || bound.reduce((sum, item) => sum + item.span_end - item.span_start, 0) > 1600) throw new MemoryError('INVALID_BATCH_BINDING')
      const spans = [...bound].sort((a,b) => a.span_start-b.span_start)
      if (spans.some((item,index) => item.span_end > credential.content_units || index && item.span_start < spans[index-1].span_end)) throw new MemoryError('INVALID_BATCH_BINDING')
    }
    if (credential.maturity_eligible && credential.normalized_content_hash && !anchor.revoked_ids.includes(credential.evidence_id)) {
      if (hashes.has(credential.normalized_content_hash)) throw new MemoryError('PERSONA_DUPLICATE_QUALIFICATION_CONFLICT')
      hashes.add(credential.normalized_content_hash)
    }
  }
  if (items.some((item) => !anchor.credentials.some((credential) => credential.plan_version === 2 && credential.evidence_id === item.event_evidence_id && credential.item_ids.includes(item.evidence_id)))) throw new MemoryError('INVALID_BATCH_BINDING')
  if (!anchor.snapshot || anchor.snapshot.persona_id !== anchor.persona_id || anchor.snapshot.agent_identity_id !== anchor.agent_identity_id || (!Number.isSafeInteger(anchor.snapshot.generation) || anchor.snapshot.generation < 0)) throw new MemoryError('PERSONA_STATE_REPAIR_REQUIRED')
  assertOnly(anchor.snapshot, ['schema_version', 'policy_version', 'persona_id', 'agent_identity_id', 'mode', 'generation', 'evidence_ids', 'maintenance_ids', 'counters', 'auto_profile'])
  assertOnly(anchor.snapshot.counters, ['independent_events', 'sessions', 'maintenance'])
  if (anchor.management_resets !== undefined) {
    if (!Array.isArray(anchor.management_resets)) throw new MemoryError('PERSONA_STATE_REPAIR_REQUIRED')
    for (const entry of anchor.management_resets) {
      assertOnly(entry, ['operation_id', 'anchor_revision', 'before', 'after'])
      assertId(entry.operation_id)
      if (!Number.isSafeInteger(entry.anchor_revision) || entry.anchor_revision < 1 || entry.anchor_revision > anchor.revision) throw new MemoryError('PERSONA_STATE_REPAIR_REQUIRED')
      for (const counters of [entry.before, entry.after]) {
        assertOnly(counters, ['independent_events', 'sessions', 'maintenance'])
        if (Object.values(counters).some((n) => !Number.isSafeInteger(n) || n < 0)) throw new MemoryError('PERSONA_STATE_REPAIR_REQUIRED')
      }
    }
  }
  return anchor
}

export function commitPersonaDescriptor(root, spaceRoot, descriptor, write) {
  if (!descriptor) return
  const anchor = validatePersonaAnchor(descriptor.anchor)
  if (resolve(spaceRoot) !== resolve(root, 'spaces', anchor.memory_space_id)) throw new MemoryError('PERSONA_SPACE_MISMATCH')
  const previous = getPersonaAnchor(root, anchor.memory_space_id, anchor.binding_id)
  if (previous && anchor.revision <= previous.revision) {
    if (anchor.revision === previous.revision && digest(anchor) !== digest(previous)) throw new MemoryError('PERSONA_ANCHOR_CONFLICT')
    return
  }
  if ((previous?.revision ?? 0) !== descriptor.expected_revision || anchor.revision !== descriptor.expected_revision + 1) throw new MemoryError('PERSONA_REVISION_CONFLICT')
  if (previous && anchor.schema_version < previous.schema_version) throw new MemoryError('PERSONA_SCHEMA_DOWNGRADE')
  if (previous && (previous.agent_identity_id !== anchor.agent_identity_id || previous.persona_id !== anchor.persona_id || previous.subject_id !== anchor.subject_id)) throw new MemoryError('PERSONA_IDENTITY_CONFLICT')
  if (previous && previous.revoked_ids.some((id) => !anchor.revoked_ids.includes(id))) throw new MemoryError('PERSONA_REVOCATION_ROLLBACK')
  const ledger = loadPersonaLedger(root)
  ledger.spaces[anchor.memory_space_id] = { ...(ledger.spaces[anchor.memory_space_id] ?? {}), [anchor.binding_id]: anchor }
  write(safe(root, PERSONA_LEDGER_PATH), json(ledger))
}

/** Rebuild only derived state. No original interaction text is kept here. */
export function reconcilePersonaState(root, spaceRoot, write) {
  const spaceId = assertId(spaceRoot.split(/[\\/]/).pop())
  const ledger = loadPersonaLedger(root)
  const anchors = Object.hasOwn(ledger.spaces, spaceId) ? ledger.spaces[spaceId] : {}
  if (!anchors || typeof anchors !== 'object' || Array.isArray(anchors)) throw new MemoryError('PERSONA_STATE_REPAIR_REQUIRED')
  const manifestPath = safe(root, relative(root, join(spaceRoot, 'manifest.json')))
  const manifest = read(manifestPath, null)
  if (!manifest) return
  let changed = false
  const identities = { ...(manifest.identities ?? {}) }
  for (const anchor of Object.values(anchors)) {
    validatePersonaAnchor(anchor)
    const identity = personaIdentityProjection(anchor)
    if (identities[anchor.agent_identity_id] && digest(identities[anchor.agent_identity_id]) !== digest(identity)) throw new MemoryError('PERSONA_IDENTITY_CONFLICT')
    if (!identities[anchor.agent_identity_id]) { identities[anchor.agent_identity_id] = identity; changed = true }
    const base = `self/${anchor.agent_identity_id}`
    const snapshotPath = safe(root, relative(root, join(spaceRoot, base, 'stability.json')))
    const expected = { ...anchor.snapshot, anchor_revision: anchor.revision }
    const existing = read(snapshotPath, null)
    if (digest(existing) !== digest(expected)) write(snapshotPath, json(expected))
    for (const id of anchor.revoked_ids) {
      const path = safe(root, relative(root, join(spaceRoot, base, 'evidence', `${assertId(id)}.json`)))
      rmSync(path, { force: true })
    }
    // A revoked source cannot survive through historical self data or a replay.
    const revoked = new Set(anchor.revoked_ids)
    const hasRef = (v, key = '') => typeof v === 'string' ? ['evidence_id', 'evidence_refs', 'counterevidence_refs'].includes(key) && revoked.has(v)
      : Array.isArray(v) ? v.some((x) => hasRef(x, key)) : v && typeof v === 'object' && Object.entries(v).some(([k, x]) => hasRef(x, k))
    const walk = (folder) => {
      if (!existsSync(folder)) return
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const path = safe(root, relative(root, join(folder, entry.name)))
        if (entry.isDirectory()) walk(path)
        else if (entry.name.endsWith('.json') && !entry.name.endsWith('manifest.json') && entry.name !== 'stability.json') {
          const value = read(path, null)
          if (hasRef(value)) rmSync(path, { force: true })
        }
      }
    }
    walk(safe(root, relative(root, join(spaceRoot, base))))
    if (revoked.size) {
      const growthPath = safe(root, relative(root, join(spaceRoot, base, 'manifest.json')))
      const growth = read(growthPath, null)
      if (growth) {
        let pruned = false
        for (const kind of ['traits', 'proposals']) for (const id of Object.keys(growth[kind] ?? {})) {
          if (!existsSync(safe(root, relative(root, join(spaceRoot, base, kind, `${assertId(id)}.json`))))) { delete growth[kind][id]; pruned = true }
        }
        for (const key of Object.keys(growth.maintenance ?? {})) {
          if (!Array.isArray(growth.maintenance[key])) continue
          const old = growth.maintenance[key]
          const kept = old.filter((item) => typeof item === 'string' ? Boolean(growth.proposals?.[item]) : Boolean(growth.proposals?.[item?.proposal_id]) || String(item?.proposal_id).startsWith('trait:') && Boolean(growth.traits?.[String(item.proposal_id).slice(6)]))
          if (kept.length !== old.length) { growth.maintenance[key] = kept; pruned = true }
        }
        if (pruned) { growth.revision = (growth.revision ?? 0) + 1; write(growthPath, json(growth)) }
      }
    }
  }
  if (changed) write(manifestPath, json({ ...manifest, identities }))
}

async function policyFromCredentials(anchor, mode, generation) {
  const active = new Map(anchor.credentials.filter((entry) => !anchor.revoked_ids.includes(entry.evidence_id)).map((entry) => [entry.evidence_id, entry]))
  const options = { persona_id: anchor.persona_id, agent_identity_id: anchor.agent_identity_id, mode, resolveEvidence: (id) => active.get(id) }
  const policy = new StabilityPolicy(options)
  for (const credential of active.values()) {
    if (credential.type === 'interaction' && credential.maturity_eligible === true) {
      const result = await policy.observeEvidence(credential.evidence_id)
      if (!result.accepted && result.reason !== 'duplicate_event') throw new MemoryError('PERSONA_CREDENTIAL_REJECTED')
    } else if (credential.type === 'maintenance') {
      const result = await policy.observeMaintenance(credential.evidence_id)
      if (!result.accepted) throw new MemoryError('PERSONA_CREDENTIAL_REJECTED')
    }
  }
  const snapshot = { ...policy.snapshot(), generation: Math.max(generation ?? 0, policy.snapshot().generation) }
  return StabilityPolicy.restore(snapshot, { ...options, expected_generation: snapshot.generation })
}

export function validatePortablePersonaShape(value, spaceId) {
  assertOnly(value, ['schema_version', 'anchors'])
  if (![1, 2, 3].includes(value.schema_version) || !Array.isArray(value.anchors) || value.anchors.length > 1000) throw new MemoryError('INVALID_TRANSFER_PERSONA_STATE')
  const bindings = new Set(), identities = new Set()
  for (const anchor of value.anchors) {
    validatePersonaAnchor(anchor)
    if (anchor.schema_version > value.schema_version || anchor.management_resets !== undefined || anchor.memory_space_id !== spaceId || bindings.has(anchor.binding_id) || identities.has(anchor.agent_identity_id)) throw new MemoryError('INVALID_TRANSFER_PERSONA_STATE')
    if (anchor.credentials.length > 100_000 || anchor.revoked_ids.length > 100_000 || !STABILITY_MODES.includes(anchor.snapshot.mode)) throw new MemoryError('INVALID_TRANSFER_PERSONA_STATE')
    bindings.add(anchor.binding_id); identities.add(anchor.agent_identity_id)
  }
  return value
}

export async function validatePortablePersonaState(value, spaceId) {
  validatePortablePersonaShape(value, spaceId)
  for (const anchor of value.anchors) {
    const active = new Map(anchor.credentials.filter((entry) => !anchor.revoked_ids.includes(entry.evidence_id)).map((entry) => [entry.evidence_id, entry]))
    try {
      await StabilityPolicy.restore(anchor.snapshot, { persona_id: anchor.persona_id, agent_identity_id: anchor.agent_identity_id,
        resolveEvidence: (id) => active.get(id), expected_generation: anchor.snapshot.generation })
    } catch (error) {
      throw error instanceof MemoryError ? error : new MemoryError(typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : 'INVALID_TRANSFER_PERSONA_STATE')
    }
    const actual = (await policyFromCredentials(anchor, anchor.snapshot.mode, anchor.snapshot.generation)).snapshot()
    for (const key of ['evidence_ids', 'maintenance_ids']) if (digest([...actual[key]].sort()) !== digest([...anchor.snapshot[key]].sort())) throw new MemoryError('PERSONA_QUALIFICATION_MISMATCH')
    if (digest(actual.counters) !== digest(anchor.snapshot.counters) || actual.auto_profile !== anchor.snapshot.auto_profile) throw new MemoryError('PERSONA_QUALIFICATION_MISMATCH')
  }
  return value
}

export function exportPersonaState(root, spaceId) {
  const ledger = loadPersonaLedger(root)
  const anchors = Object.hasOwn(ledger.spaces, spaceId) ? Object.values(ledger.spaces[spaceId]) : []
  return { schema_version: Math.max(1, ...anchors.map((anchor) => anchor.schema_version)), anchors: anchors.map((anchor) => {
    validatePersonaAnchor(anchor)
    const portable = clone(anchor)
    delete portable.management_resets
    return portable
  }).sort((a, b) => a.binding_id.localeCompare(b.binding_id)) }
}

/** Prepare against the root lock; installation is deferred until durable COMMIT. */
export async function preparePersonaImport(root, spaceId, operationId, incoming, { allowMaturityReset = false } = {}) {
  assertId(operationId)
  await validatePortablePersonaState(incoming, spaceId)
  const descriptors = [], anchors = []
  for (const source of incoming.anchors) {
    const previous = getPersonaAnchor(root, spaceId, source.binding_id)
    if (previous && previous.agent_identity_id !== source.agent_identity_id) throw new MemoryError('PERSONA_IDENTITY_CONFLICT')
    if (previous && previous.created_at !== source.created_at) throw new MemoryError('PERSONA_IDENTITY_CONFLICT')
    const credentials = new Map((previous?.credentials ?? []).map((entry) => [entry.evidence_id, entry]))
    const origins = new Map((previous?.credentials ?? []).filter((entry) => entry.independence_key).map((entry) => [entry.independence_key, entry.evidence_id]))
    for (const entry of source.credentials) {
      if (credentials.has(entry.evidence_id) && digest(credentials.get(entry.evidence_id)) !== digest(entry)) throw new MemoryError('PERSONA_QUALIFICATION_CONFLICT')
      if (entry.independence_key && origins.has(entry.independence_key) && origins.get(entry.independence_key) !== entry.evidence_id) throw new MemoryError('PERSONA_QUALIFICATION_CONFLICT')
      credentials.set(entry.evidence_id, clone(entry))
      if (entry.independence_key) origins.set(entry.independence_key, entry.evidence_id)
    }
    const itemMap = new Map((previous?.items ?? []).map((item) => [item.evidence_id, clone(item)]))
    for (const item of source.items ?? []) {
      const old = itemMap.get(item.evidence_id)
      const strip = (entry) => { const copy = clone(entry); delete copy.outbox_outcome; return copy }
      if (old && digest(strip(old)) !== digest(strip(item))) throw new MemoryError('PERSONA_ITEM_CONFLICT')
      if (old?.outbox_outcome && item.outbox_outcome && digest(old.outbox_outcome) !== digest(item.outbox_outcome)) throw new MemoryError('PERSONA_ITEM_OUTCOME_CONFLICT')
      itemMap.set(item.evidence_id, { ...clone(item), ...(old?.outbox_outcome ? { outbox_outcome: old.outbox_outcome } : {}) })
    }
    const revoked = [...new Set([...(previous?.revoked_ids ?? []), ...source.revoked_ids])].sort()
    const unchanged = previous && digest(previous.credentials.map((entry) => [entry.evidence_id, entry]).sort()) === digest([...credentials.entries()].sort()) && digest([...previous.revoked_ids].sort()) === digest(revoked) && digest((previous.items ?? []).map((item) => [item.evidence_id,item]).sort()) === digest([...itemMap.entries()].sort())
    if (unchanged) { anchors.push(previous); continue }
    const schema = Math.max(previous?.schema_version ?? 1, source.schema_version)
    const anchor = { ...source, ...(schema >= 2 ? { schema_version: schema, items: [...itemMap.values()] } : {}), revision: (previous?.revision ?? 0) + 1,
      core_version: previous?.core_version ?? source.core_version, credentials: [...credentials.values()], revoked_ids: revoked,
      ...(previous?.management_resets ? { management_resets: clone(previous.management_resets) } : {}) }
    const mode = previous?.snapshot.mode ?? source.snapshot.mode
    const policy = await policyFromCredentials(anchor, mode, (previous?.snapshot.generation ?? 0) + 1)
    anchor.snapshot = policy.snapshot()
    const lowered = previous && ['independent_events', 'sessions', 'maintenance'].some((key) => anchor.snapshot.counters[key] < previous.snapshot.counters[key])
    if (lowered && !allowMaturityReset) throw new MemoryError('PERSONA_MATURITY_CONFLICT')
    if (lowered) anchor.management_resets = [...(previous.management_resets ?? []), { operation_id: operationId, anchor_revision: anchor.revision,
      before: clone(previous.snapshot.counters), after: clone(anchor.snapshot.counters) }]
    validatePersonaAnchor(anchor)
    descriptors.push({ expected_revision: previous?.revision ?? 0, anchor })
    anchors.push(anchor)
  }
  return { anchors, descriptors }
}

export function assertPersonaFilesAllowed(files, anchors, { validateSnapshot = false } = {}) {
  const byIdentity = new Map(anchors.map((anchor) => [anchor.agent_identity_id, anchor]))
  for (const file of files) {
    const match = /^self\/([^/]+)\//.exec(file.path)
    if (!match) continue
    const anchor = byIdentity.get(match[1])
    if (!anchor) {
      if (/\/(?:stability\.json|evidence\/)/.test(file.path)) throw new MemoryError('MISSING_TRANSFER_PERSONA_STATE')
      continue
    }
    if (!file.path.endsWith('.json')) continue
    let value
    try { value = JSON.parse(file.data.toString('utf8')) } catch { throw new MemoryError('INVALID_TRANSFER_JSON') }
    if (validateSnapshot && file.path.endsWith('/stability.json') && digest(value) !== digest({ ...anchor.snapshot, anchor_revision: anchor.revision })) throw new MemoryError('TRANSFER_PERSONA_SNAPSHOT_MISMATCH')
    const revoked = new Set(anchor.revoked_ids)
    const referencesRevoked = (item, key = '') => typeof item === 'string' ? ['evidence_id', 'evidence_refs', 'counterevidence_refs', 'provenance_refs'].includes(key) && revoked.has(item)
      : Array.isArray(item) ? item.some((entry) => referencesRevoked(entry, key)) : item && typeof item === 'object' && Object.entries(item).some(([name, entry]) => referencesRevoked(entry, name))
    if (!file.path.endsWith('/stability.json') && referencesRevoked(value)) throw new MemoryError('PERSONA_REVOKED_CONTENT')
    if (/\/evidence\/[^/]+\.json$/.test(file.path)) {
      const credential = evidenceBinding(anchor, value.evidence_id)
      if (credential?.event_evidence_id) validateBoundItemPayload(anchor, credential, value)
      if (!credential || (!credential.event_evidence_id && credential.allow_persist !== true) || credential.payload_hash !== digest(value) || value.persona_id !== anchor.persona_id || value.agent_identity_id !== anchor.agent_identity_id) throw new MemoryError('TRANSFER_PERSONA_EVIDENCE_MISMATCH')
    }
  }
}
