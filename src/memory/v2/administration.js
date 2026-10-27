import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { API_VERSION, MemoryError, assertId, assertOnly, failure } from './contracts.js'
import { atomicWrite, readJson, retireExpectedLock } from './transactions.js'
import { getPurgeState, pathIsPurged, preparePurgeImport, referencesPurged } from './purge-ledger.js'
import { validateTransferArchive } from './transfer.js'
import { loadPersonaLedger, validatePersonaAnchor } from './persona-ledger.js'
import { validateBoundItemPayload } from './batch-bindings.js'
import { loadRecordHead } from './record-integrity.js'

const json = (value) => `${JSON.stringify(value, null, 2)}\n`

function files(root, prefix = '', output = []) {
  if (!existsSync(root)) return output
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (dir.isSymbolicLink()) throw new MemoryError('UNSAFE_STORAGE_PATH')
    const path = join(root, dir.name), name = prefix + dir.name
    if (dir.isDirectory()) files(path, `${name}/`, output)
    else output.push({ path, name })
  }
  return output
}

function refs(value, key) {
  const found = new Set()
  const walk = (item) => {
    if (!item || typeof item !== 'object') return
    for (const [name, child] of Object.entries(item)) {
      if (name === key && Array.isArray(child)) {
        for (const id of child) if (typeof id === 'string') found.add(id)
      } else if (child && typeof child === 'object') walk(child)
    }
  }
  walk(value)
  return [...found]
}

function recordMetadata(store, id) {
  const head = loadRecordHead(store.root, store.memorySpaceId, id)
  if (head) return head.revisions.map((revision) => ({ record_id: id, revision: revision.revision, subject_id: head.subject_id,
    persona_id: head.persona_id, agent_identity_id: head.agent_identity_id, provenance_refs: revision.evidence_ids, assets: revision.asset_files }))
  const base = store.engine.resolvePath(`records/${assertId(id)}`)
  return files(base).filter((file) => file.name.endsWith('meta.json')).map((file) => readJson(file.path))
}

function ownerAlive(owner) {
  if (!owner) return false
  if (owner.hostname !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid < 1) return true
  try { process.kill(owner.pid, 0); return true } catch (error) { return error?.code !== 'ESRCH' }
}

/** Host-owned management service; none of these methods is a model tool. */
export class MemoryAdministration {
  constructor({ store, repairCheckpoint = () => {} } = {}) {
    if (typeof store?.managedTransaction !== 'function' || typeof store?.issueContext !== 'function') throw new MemoryError('MANAGED_MEMORY_REQUIRED')
    this.store = store
    this.repairCheckpoint = repairCheckpoint
  }

  _authorize(context, capability, { bootstrap = false } = {}) {
    if (!bootstrap || this.store.initialized) return this.store._authorize(context, capability)
    if (!context || !this.store.contexts.has(context)) throw new MemoryError('UNTRUSTED_CONTEXT')
    if (!context.capabilities.includes('memory.manage')) throw new MemoryError('CAPABILITY_DENIED')
    if (Date.parse(context.expires_at) <= Date.now()) throw new MemoryError('CONTEXT_EXPIRED')
    return context
  }

  _hostContext(context) {
    return this.store.issueContext({ agent_identity_id: context.agent_identity_id, persona_id: context.persona_id,
      subject_id: context.subject_id, allowed_subject_ids: context.allowed_subject_ids, session_id: context.session_id,
      expires_at: context.expires_at, capabilities: ['memory.manage'] })
  }

  assertImportAllowed({ archive, files: incomingFiles, record_ids = [], purge_state = null }) {
    if (archive.memory_space_id !== this.store.memorySpaceId) throw new MemoryError('TRANSFER_SPACE_MISMATCH')
    const state = purge_state ? preparePurgeImport(this.store.root, this.store.memorySpaceId, 'validate-import-scope', purge_state).state : getPurgeState(this.store.root, this.store.memorySpaceId)
    if (!state.generation) return true
    if (record_ids.some((id) => state.record_ids.includes(id))) throw new MemoryError('PURGED_CONTENT')
    for (const file of incomingFiles) {
      if (pathIsPurged(file.path, state)) throw new MemoryError('PURGED_CONTENT')
      if (/^(self|candidates|evidence)\//.test(file.path) && file.path.endsWith('.json') && !file.path.endsWith('/manifest.json')) {
        let value
        try { value = JSON.parse(file.data.toString('utf8')) } catch { throw new MemoryError('INVALID_TRANSFER_JSON') }
        if (referencesPurged(value, state)) throw new MemoryError('PURGED_CONTENT')
      }
    }
    return true
  }

  async purgeScope(args, context) {
    const operationId = args?.operation_id ?? randomUUID()
    try {
      this._authorize(context, 'memory.purge')
      assertOnly(args, ['operation_id', 'record_ids', 'expected_revisions', 'include_legacy_narratives'])
      if (args.include_legacy_narratives !== undefined && typeof args.include_legacy_narratives !== 'boolean') throw new MemoryError('INVALID_PURGE_SCOPE')
      if (args.include_legacy_narratives === true) this._authorize(context, 'memory.manage')
      if (!Array.isArray(args.record_ids) || !args.record_ids.length || args.record_ids.length > 1000) throw new MemoryError('PRECISE_PURGE_SCOPE_REQUIRED')
      const recordIds = [...new Set(args.record_ids.map((id) => assertId(id, 'record_id')))]
      if (!args.expected_revisions || typeof args.expected_revisions !== 'object' || Array.isArray(args.expected_revisions)) throw new MemoryError('EXPECTED_REVISION_REQUIRED')
      return await this.store.managedTransaction(operationId, { action: 'purgeScope', args }, ({ manifest, records }) => {
        this._authorize(context, 'memory.purge')
        let hasLegacyNarratives = files(join(this.store.spaceRoot, 'cold/legacy-v1/dreams')).length > 0
        for (const category of ['exports', 'backups']) for (const file of files(join(this.store.root, category))) {
          if (!file.name.endsWith('.json')) continue
          let archive
          try { archive = JSON.parse(readFileSync(file.path, 'utf8')) } catch { continue }
          if (archive?.transfer_format === 'dsh-memory-space' && archive.memory_space_id === this.store.memorySpaceId) {
            try { validateTransferArchive(archive) } catch { throw new MemoryError('MANAGED_ARCHIVE_REPAIR_REQUIRED') }
            if (archive.files.some((entry) => /(?:^|\/)legacy-v1\/dreams\//.test(entry.path))) hasLegacyNarratives = true
          }
        }
        if (hasLegacyNarratives && args.include_legacy_narratives !== true) throw new MemoryError('LEGACY_NARRATIVE_SCOPE_REQUIRED')
        const previous = getPurgeState(this.store.root, this.store.memorySpaceId)
        const targetMetas = []
        for (const id of recordIds) {
          if (previous.record_ids.includes(id)) continue
          const head = loadRecordHead(this.store.root, this.store.memorySpaceId, id)
          const current = head ? { subject_id: head.subject_id, revision: head.head_revision } : this.store._readRecord(id).meta
          if (!context.capabilities.includes('memory.manage') && !context.allowed_subject_ids.includes(current.subject_id)) throw new MemoryError('SUBJECT_DENIED')
          if (args.expected_revisions[id] !== current.revision) throw new MemoryError('REVISION_CONFLICT')
          targetMetas.push(...recordMetadata(this.store, id))
        }
        const relatedEvidence = [...new Set(targetMetas.flatMap((meta) => meta.provenance_refs ?? []))]
        const targetAssets = [...new Set(targetMetas.flatMap((meta) => meta.assets ?? []))]
        const remaining = records.filter((meta) => !recordIds.includes(meta.record_id))
        const ledgerRoot = join(this.store.root, '.administration/record-heads', this.store.memorySpaceId)
        const remainingIds = existsSync(ledgerRoot) ? readdirSync(ledgerRoot).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)).filter((id) => !recordIds.includes(id) && !previous.record_ids.includes(id)) : remaining.map((meta) => meta.record_id)
        const remainingMetas = remainingIds.flatMap((id) => recordMetadata(this.store, id))
        const stillReferenced = new Set(remainingMetas.flatMap((meta) => meta.provenance_refs ?? []))
        const retainedAssets = new Set(remainingMetas.flatMap((meta) => meta.assets ?? []))
        const evidenceIds = relatedEvidence.filter((id) => !stillReferenced.has(id))
        const combinedState = { ...previous, record_ids: [...new Set([...previous.record_ids, ...recordIds])], related_evidence_ids: [...new Set([...previous.related_evidence_ids, ...relatedEvidence])] }
        const derivedPaths = []
        const unresolvedArtifacts = []
        for (const prefix of ['self', 'candidates', 'dreams']) {
          for (const file of files(join(this.store.spaceRoot, prefix))) {
            if (!file.name.endsWith('.json') || file.name.endsWith('/manifest.json')) continue
            let value
            try { value = readJson(file.path) } catch { unresolvedArtifacts.push(`${prefix}/${file.name}`); continue }
            if (referencesPurged(value, combinedState)) derivedPaths.push(`${prefix}/${file.name}`)
            else for (const asset of refs(value, 'assets')) retainedAssets.add(asset)
          }
        }
        const assetFiles = []
        for (const asset of targetAssets.filter((id) => !retainedAssets.has(id))) {
          assertId(asset, 'asset id')
          for (const name of readdirSync(this.store.paths.assets)) if (name === asset || name.startsWith(`${asset}.`)) assetFiles.push(name)
        }
        const descriptor = { operation_id: operationId, memory_space_id: this.store.memorySpaceId,
          generation: previous.generation + 1, revision_floor: manifest.revision_watermark + 1,
          record_ids: recordIds, evidence_ids: evidenceIds, related_evidence_ids: relatedEvidence, asset_files: assetFiles }
        descriptor.clear_legacy_narratives = args.include_legacy_narratives === true
        const changes = [
          ...recordIds.flatMap((id) => ['records', 'cold', 'external-changes'].map((prefix) => ({ path: `${prefix}/${id}`, data: null }))),
          ...evidenceIds.map((id) => ({ path: `evidence/${id}.json`, data: null })),
          ...assetFiles.map((file) => ({ path: `assets/${file}`, data: null })),
          ...derivedPaths.map((path) => ({ path, data: null })),
          { path: 'manifest.json', data: json({ ...manifest, purge_generation: descriptor.generation, revision_watermark: descriptor.revision_floor }) },
          { path: 'index/records.json', data: json(this.store._index(remaining, descriptor.revision_floor)) },
        ]
        return { changes, purge_descriptor: descriptor, result: {
          api_version: API_VERSION, operation_id: operationId, status: 'committed', reason_code: 'PURGED', pending: false,
          affected_ids: recordIds, purge_generation: descriptor.generation, evidence_ids_removed: evidenceIds,
          shared_evidence_ids_retained: relatedEvidence.filter((id) => stillReferenced.has(id)), asset_files_removed: assetFiles,
          derived_paths_removed: derivedPaths,
          unresolved_artifacts: unresolvedArtifacts,
          legacy_narratives_cleared: descriptor.clear_legacy_narratives,
          outside_scope: ['Host conversation history', 'Unmanaged external copies and exports', 'Unattributed legacy narratives and malformed artifacts without stable references'],
        } }
      }, this._hostContext(context), { authorize: () => {
        this._authorize(context, 'memory.purge')
        if (args.include_legacy_narratives === true) this._authorize(context, 'memory.manage')
      } })
    } catch (error) { return failure(error, operationId) }
  }

  /** Permanently erase one approved item that has never entered a record. */
  async purgePendingItem(args, context) {
    const operationId = args?.operation_id ?? randomUUID()
    try {
      this._authorize(context, 'memory.purge')
      assertOnly(args, ['operation_id', 'evidence_id'])
      const evidenceId = assertId(args.evidence_id, 'evidence_id')
      return await this.store.managedTransaction(operationId, { action: 'purgePendingItem', evidence_id: evidenceId }, ({ manifest }) => {
        this._authorize(context, 'memory.purge')
        const spaces = loadPersonaLedger(this.store.root).spaces
        const space = Object.hasOwn(spaces, this.store.memorySpaceId) ? spaces[this.store.memorySpaceId] : {}
        if (!space || typeof space !== 'object' || Array.isArray(space)) throw new MemoryError('PERSONA_STATE_REPAIR_REQUIRED')
        const matches = []
        for (const anchor of Object.values(space)) {
          validatePersonaAnchor(anchor)
          if (anchor.memory_space_id !== this.store.memorySpaceId) throw new MemoryError('PERSONA_SPACE_MISMATCH')
          const item = (anchor.items ?? []).find((entry) => entry.evidence_id === evidenceId)
          if (item) matches.push({ anchor, item })
        }
        if (matches.length !== 1) throw new MemoryError(matches.length ? 'PERSONA_ITEM_CONFLICT' : 'ITEM_NOT_FOUND')
        const { anchor, item } = matches[0]
        if (!context.capabilities.includes('memory.manage') && (context.agent_identity_id !== anchor.agent_identity_id || context.persona_id !== anchor.persona_id || context.subject_id !== anchor.subject_id)) throw new MemoryError('SUBJECT_DENIED')
        const previous = getPurgeState(this.store.root, this.store.memorySpaceId)
        const result = (generation, replayed = false) => ({ api_version: API_VERSION, operation_id: operationId,
          status: 'committed', reason_code: 'PURGED', pending: false, affected_ids: [], evidence_ids_removed: [evidenceId],
          purge_generation: generation, replayed, event_qualification_retained: true,
          outside_scope: ['Host conversation history', 'Unmanaged external copies and exports'] })
        if (previous.evidence_ids.includes(evidenceId)) return { changes: [], result: result(previous.generation, true) }
        const payloadPath = `self/${anchor.agent_identity_id}/evidence/${evidenceId}.json`
        const payload = readJson(this.store.engine.resolvePath(payloadPath), null)
        if (payload) validateBoundItemPayload(anchor, item, payload)
        else if (!anchor.revoked_ids.includes(evidenceId)) throw new MemoryError('PERSONA_EVIDENCE_REPAIR_REQUIRED')
        files(this.store.paths.records)
        const scan = this.store._records()
        if (scan.warnings.length) throw new MemoryError('MEMORY_REPAIR_REQUIRED')
        const check = (record) => {
          if (record.meta.provenance_refs?.includes(evidenceId) || record.evidence.some((entry) => entry.evidence_id === evidenceId)) throw new MemoryError('ITEM_HAS_RECORDS')
        }
        for (const meta of scan.records) {
          check(this.store._readRecord(meta.record_id))
          const history = this.store.engine.resolvePath(`records/${meta.record_id}/revisions`)
          for (const entry of readdirSync(history, { withFileTypes: true })) {
            if (!entry.isDirectory() || entry.isSymbolicLink()) throw new MemoryError('MEMORY_REPAIR_REQUIRED')
            check(this.store._readRecord(meta.record_id, entry.name))
          }
        }
        const descriptor = { operation_id: operationId, memory_space_id: this.store.memorySpaceId,
          generation: previous.generation + 1, revision_floor: manifest.revision_watermark + 1,
          record_ids: [], evidence_ids: [evidenceId], related_evidence_ids: [evidenceId], asset_files: [], clear_legacy_narratives: false }
        const changes = [
          { path: payloadPath, data: null }, { path: `evidence/${evidenceId}.json`, data: null },
          { path: 'manifest.json', data: json({ ...manifest, purge_generation: descriptor.generation, revision_watermark: descriptor.revision_floor }) },
          { path: 'index/records.json', data: json(this.store._index(scan.records, descriptor.revision_floor)) },
        ]
        return { changes, purge_descriptor: descriptor, result: result(descriptor.generation) }
      }, this._hostContext(context), { authorize: () => this._authorize(context, 'memory.purge') })
    } catch (error) { return failure(error, operationId) }
  }

  inspectLocks(context) {
    this._authorize(context, 'memory.manage', { bootstrap: true })
    return { writer: readJson(join(this.store.root, '.writer.lock/owner.json'), null), recovery: readJson(join(this.store.root, '.writer-recovery.lock/owner.json'), null), management: readJson(join(this.store.root, '.administration/repair.lock/owner.json'), null) }
  }

  async repairAbandonedLocks(args, context) {
    try {
      this._authorize(context, 'memory.manage', { bootstrap: true })
      getPurgeState(this.store.root, this.store.memorySpaceId)
      assertOnly(args, ['expected_writer_token', 'expected_recovery_token'])
      const maintenance = join(this.store.root, '.administration/repair.lock')
      mkdirSync(join(this.store.root, '.administration'), { recursive: true, mode: 0o700 })
      const owner = { pid: process.pid, hostname: hostname(), token: randomUUID() }
      const candidate = join(this.store.root, `.management-candidate-${owner.token}`)
      mkdirSync(candidate, { mode: 0o700 })
      atomicWrite(join(candidate, 'owner.json'), json(owner))
      try { renameSync(candidate, maintenance) } catch (error) {
        rmSync(candidate, { recursive: true, force: true })
        if (['EEXIST', 'ENOTEMPTY'].includes(error?.code)) throw new MemoryError('MANAGEMENT_BUSY')
        throw error
      }
      try {
        const state = this.inspectLocks(context)
        if ((state.writer?.token ?? null) !== (args.expected_writer_token ?? null) || (state.recovery?.token ?? null) !== (args.expected_recovery_token ?? null)) throw new MemoryError('LOCK_OWNER_CONFLICT')
        if (ownerAlive(state.writer) || ownerAlive(state.recovery)) throw new MemoryError('LIVE_LOCK_OWNER')
        await this.repairCheckpoint('after_check', { writer: state.writer, recovery: state.recovery })
        for (const [name, inspected] of [['.writer.lock', state.writer], ['.writer-recovery.lock', state.recovery]]) {
          if (!inspected) continue
          this._authorize(context, 'memory.manage', { bootstrap: true })
          if (readJson(join(maintenance, 'owner.json'), null)?.token !== owner.token) throw new MemoryError('MANAGEMENT_GATE_LOST')
          await this.repairCheckpoint('before_retire', { name, inspected })
          this._authorize(context, 'memory.manage', { bootstrap: true })
          if (readJson(join(maintenance, 'owner.json'), null)?.token !== owner.token) throw new MemoryError('MANAGEMENT_GATE_LOST')
          const path = join(this.store.root, name)
          if (!existsSync(path)) continue
          if (lstatSync(path).isSymbolicLink()) throw new MemoryError('UNSAFE_STORAGE_PATH')
          retireExpectedLock(path, inspected.token, this.store.root, { requireDead: true })
        }
        return { status: 'ok', reason_code: 'ABANDONED_LOCKS_REMOVED' }
      } finally {
        if (readJson(join(maintenance, 'owner.json'), null)?.token === owner.token) retireExpectedLock(maintenance, owner.token, this.store.root)
      }
    } catch (error) { return failure(error) }
  }

  repairAbandonedManagementGate(args, context) {
    try {
      this._authorize(context, 'memory.manage', { bootstrap: true })
      getPurgeState(this.store.root, this.store.memorySpaceId)
      assertOnly(args, ['expected_gate_token'])
      const path = join(this.store.root, '.administration/repair.lock')
      const owner = readJson(join(path, 'owner.json'), null)
      if (!owner || owner.token !== args.expected_gate_token) throw new MemoryError('LOCK_OWNER_CONFLICT')
      if (ownerAlive(owner)) throw new MemoryError('LIVE_LOCK_OWNER')
      retireExpectedLock(path, owner.token, this.store.root, { requireDead: true })
      return { status: 'ok', reason_code: 'ABANDONED_MANAGEMENT_GATE_REMOVED' }
    } catch (error) { return failure(error) }
  }
}

export default MemoryAdministration
