import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync } from 'node:fs'
import { API_VERSION, MemoryError, assertId, assertOnly, digest, failure } from './contracts.js'
import { buildRecordDescriptor, loadRecordHead, recordBundlePath } from './record-integrity.js'
import { LIFECYCLE_POLICY_VERSION, buildLifecyclePlan, isLifecycleProtected, lifecycleTime } from './lifecycle-policy.js'
import { readLifecycleTree } from './lifecycle-journal.js'

const copy = (value) => structuredClone(value)
const scope = (ctx) => [ctx.memory_space_id, ctx.subject_id, ctx.persona_id, ctx.agent_identity_id, ctx.session_id]
const plans = new WeakMap()

/** Owner-managed deterministic lifecycle. It is never registered as a model tool. */
export class MemoryLifecycle {
  constructor({ store, clock = () => Date.now(), monotonic = () => performance.now(), maxBatchBytes = 64 * 1024 * 1024, maxBatchMs = 5000 } = {}) {
    if (typeof store?.managedTransaction !== 'function' || typeof clock !== 'function') throw new MemoryError('MANAGED_MEMORY_REQUIRED')
    if (typeof monotonic !== 'function' || !Number.isSafeInteger(maxBatchBytes) || maxBatchBytes < 1 || maxBatchBytes > 1024 * 1024 * 1024 || !Number.isFinite(maxBatchMs) || maxBatchMs < 1 || maxBatchMs > 30000) throw new MemoryError('INVALID_LIFECYCLE_BUDGET')
    this.store = store; this.clock = clock; this.monotonic = monotonic; this.maxBatchBytes = maxBatchBytes; this.maxBatchMs = maxBatchMs
  }

  async preview(args = {}, context) {
    try {
      this.store._authorize(context, 'memory.manage')
      assertOnly(args, ['mode', 'record_ids', 'automatic_cold', 'min_age_days', 'batch_limit', 'scan_limit', 'cursor'])
      const now = lifecycleTime(this.clock())
      return await this.store.managedRead(context, ({ records, manifest }) => {
        const plan = buildLifecyclePlan(records, { now, mode: args.mode ?? 'maintenance', recordIds: args.record_ids ?? [], automaticCold: args.automatic_cold ?? false,
          minAgeDays: args.min_age_days ?? 30, batchLimit: args.batch_limit ?? 32, scanLimit: args.scan_limit ?? 256, cursor: args.cursor ?? null })
        const snapshots = new Map(plan.actions.map((action) => {
          const head = loadRecordHead(this.store.root, this.store.memorySpaceId, action.record_id)
          return [action.record_id, { head: copy(head), meta: copy(this.store._readRecord(action.record_id).meta) }]
        }))
        plans.set(plan, { store: this.store, scope: scope(context), watermark: manifest.revision_watermark, snapshots })
        return plan
      })
    } catch (error) { return failure(error) }
  }

  async apply({ operation_id = randomUUID(), plan } = {}, context, hostOptions = {}) {
    const results = []; const started = this.monotonic(); let totalBytes = 0
    try {
      this.store._authorize(context, 'memory.manage')
      assertId(operation_id); assertOnly(hostOptions, ['authorize', 'signal'])
      if (hostOptions.authorize !== undefined && typeof hostOptions.authorize !== 'function') throw new MemoryError('TRUSTED_AUTHORIZER_REQUIRED')
      const capture = plans.get(plan)
      if (!capture || capture.store !== this.store || digest(capture.scope) !== digest(scope(context))) throw new MemoryError('TRUSTED_LIFECYCLE_PLAN_REQUIRED')
      const checkHost = () => {
        const elapsed = this.monotonic() - started
        if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > this.maxBatchMs) throw new MemoryError('LIFECYCLE_TIME_BUDGET_EXCEEDED')
        this.store._authorize(context, 'memory.manage')
        if (hostOptions.signal?.aborted) throw new MemoryError('LIFECYCLE_CANCELLED')
        if (hostOptions.authorize) {
          const allowed = hostOptions.authorize()
          if (allowed && typeof allowed.then === 'function') { Promise.resolve(allowed).catch(() => {}); throw new MemoryError('ASYNC_AUTHORIZER_UNSUPPORTED') }
          if (allowed === false) throw new MemoryError('HOST_AUTHORIZATION_DENIED')
        }
      }
      checkHost()
      // Each bounded item has its own durable receipt; partial progress is explicit.
      for (const action of plan.actions) {
        const original = capture.snapshots.get(action.record_id)
        const op = `lifecycle-${digest([operation_id, action.record_id]).slice(0, 48)}`
        let prepared = false, preparedRecord = null
        const assertCurrent = () => {
          checkHost()
          const current = loadRecordHead(this.store.root, this.store.memorySpaceId, action.record_id)
          if (!prepared && existsSync(this.store.engine.resolvePath(`operations/${digest(op)}.json`)) && current?.revisions.some((revision) => revision.operation_id === op)) return
          if (digest(current) !== digest(original.head)) throw new MemoryError('REVISION_CONFLICT')
          const record = this.store._readRecord(action.record_id)
          if (record.meta.revision !== action.expected_revision || record.meta.revision_id !== action.source_revision_id) throw new MemoryError('REVISION_CONFLICT')
          if (isLifecycleProtected(record.meta)) throw new MemoryError('PROTECTED_RECORD')
          if (prepared) { readLifecycleTree(this.store.engine, recordBundlePath(current), current); this.store._commitChanges(preparedRecord) }
        }
        const result = await this.store.managedTransaction(op, { action: 'lifecycle', plan_checksum: plan.checksum, record_id: action.record_id, expected_revision: action.expected_revision }, () => {
          assertCurrent()
          const previous = this.store._readRecord(action.record_id), oldHead = loadRecordHead(this.store.root, this.store.memorySpaceId, action.record_id)
          const base = recordBundlePath(oldHead), source = this.store.engine.resolvePath(base), stat = lstatSync(source)
          const sourceFiles = readLifecycleTree(this.store.engine, base, oldHead)
          const at = new Date(lifecycleTime(this.clock())).toISOString(), revisionId = randomUUID()
          const record = { ...previous, meta: { ...copy(previous.meta), status: action.to === 'active' ? 'active' : 'archived', revision_id: revisionId,
            revision: previous.meta.revision + 1, supersedes: previous.meta.revision_id, updated_at: at,
            revision_history: [...(previous.meta.revision_history ?? []), { revision_id: previous.meta.revision_id, revision: previous.meta.revision, superseded_at: at, reason: action.reason_code }],
            lifecycle: { schema_version: 1, tier: action.to, changed_at: at, reason_code: action.reason_code, policy_version: LIFECYCLE_POLICY_VERSION, source_revision_id: previous.meta.revision_id } } }
          const files = this.store._recordFiles(record)
          const descriptor = buildRecordDescriptor({ root: this.store.root, spaceId: this.store.memorySpaceId, meta: record.meta, files, operationId: op, bundleLocation: action.to === 'active' ? 'records' : 'cold' })
          const targetBase = recordBundlePath(descriptor.next)
          if (existsSync(this.store.engine.resolvePath(targetBase))) throw new MemoryError('LIFECYCLE_DESTINATION_EXISTS')
          const targetFiles = Object.fromEntries(Object.entries(sourceFiles).filter(([name]) => name.startsWith('revisions/')))
          Object.assign(targetFiles, files, Object.fromEntries(Object.entries(files).map(([name, data]) => [`revisions/${revisionId}/${name}`, data])))
          totalBytes += [...Object.values(sourceFiles), ...Object.values(targetFiles)].reduce((size, value) => size + Buffer.byteLength(value), 0)
          if (totalBytes > this.maxBatchBytes) throw new MemoryError('LIFECYCLE_BATCH_BYTES_EXCEEDED')
          const derived = this.store._commitChanges(record).filter((change) => ['manifest.json', 'index/records.json'].includes(change.path))
          preparedRecord = record; prepared = true
          return { changes: derived, lifecycle_descriptor: { schema_version: 1, operation_id: op, record_id: action.record_id,
            source_identity: { dev: stat.dev, ino: stat.ino }, previous_head: oldHead, record_descriptor: descriptor,
            source_hashes: Object.fromEntries(Object.entries(sourceFiles).map(([name, bytes]) => [name, digest(bytes)])),
            target_files: Object.fromEntries(Object.entries(targetFiles).map(([name, bytes]) => [name, Buffer.from(bytes).toString('base64')])) },
            result: { api_version: API_VERSION, operation_id: op, status: 'committed', reason_code: 'OK', affected_ids: [action.record_id], record_id: action.record_id, revision: record.meta.revision, revision_id: revisionId, tier: action.to, pending: false } }
        }, context, { authorize: assertCurrent })
        results.push(result)
        if (result.status !== 'committed') break
      }
      return { api_version: API_VERSION, operation_id, status: results.every((item) => item.status === 'committed') ? 'committed' : 'partial', reason_code: !results.length ? 'NO_CHANGES' : results.every((item) => item.status === 'committed') ? 'OK' : 'LIFECYCLE_PARTIAL', results, affected_ids: results.flatMap((item) => item.affected_ids ?? []), pending: false }
    } catch (error) { return { ...failure(error, operation_id), ...(results.length ? { status: 'partial', results, affected_ids: results.flatMap((item) => item.affected_ids ?? []) } : {}) } }
  }
}
