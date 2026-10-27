import { MemoryError, assertOnly, digest, failure } from './contracts.js'
import { MemoryLifecycle } from './lifecycle.js'
import { createMaintenanceBaseline, evaluateMaintenanceDue, lifecycleTime } from './lifecycle-policy.js'
import { loadMaintenanceState } from './lifecycle-ledger.js'

const identityKeys = ['memory_space_id', 'subject_id', 'persona_id', 'agent_identity_id']

/** A single trusted coordinator. It does not establish multi-host global idle. */
export class MemoryMaintenance {
  #store; #lifecycle; #clock; #activity; #contextFactory; #policy; #timer = null; #running = null; #disposed = false; #controller = new AbortController(); #setTimer; #clearTimer
  constructor({ store, getActivity, clock = () => Date.now(), contextFactory, automaticCold = false, automatic = false,
    maxBatchBytes, maxBatchMs, monotonic, days = 7, writes = 40, idleMs = 300000, minAgeDays = 30, batchLimit = 32, scanLimit = 256, intervalMs = 60000,
    setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    if (typeof store?.managedTransaction !== 'function' || typeof getActivity !== 'function' || typeof clock !== 'function' ||
      typeof automaticCold !== 'boolean' || typeof automatic !== 'boolean' || typeof setTimer !== 'function' || typeof clearTimer !== 'function') throw new MemoryError('TRUSTED_MAINTENANCE_BINDINGS_REQUIRED')
    if (!Number.isSafeInteger(idleMs) || idleMs < 0 || !Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 3600000) throw new MemoryError('INVALID_MAINTENANCE_POLICY')
    this.#store = store; this.#clock = clock; this.#activity = getActivity; this.#contextFactory = contextFactory; this.#setTimer = setTimer; this.#clearTimer = clearTimer
    this.#policy = Object.freeze({ automaticCold, automatic, days, writes, idleMs, minAgeDays, batchLimit, scanLimit, intervalMs })
    this.#lifecycle = new MemoryLifecycle({ store, clock, ...(maxBatchBytes === undefined ? {} : { maxBatchBytes }), ...(maxBatchMs === undefined ? {} : { maxBatchMs }), ...(monotonic === undefined ? {} : { monotonic }) })
  }

  #authorize(context, signal) {
    if (this.#disposed || this.#controller.signal.aborted || signal?.aborted) throw new MemoryError('MAINTENANCE_CANCELLED')
    return this.#store._authorize(context, 'memory.manage')
  }

  #idle(context, captured, signal) {
    this.#authorize(context, signal)
    const value = this.#activity(), now = lifecycleTime(this.#clock())
    if (!value || value.scope_coverage !== 'memory_space' || typeof value !== 'object' || value && typeof value.then === 'function' || identityKeys.some((key) => value[key] !== context[key]) ||
      !Number.isSafeInteger(value.epoch) || value.epoch < 0 || typeof value.running !== 'boolean' || typeof value.disposed !== 'boolean' ||
      !Number.isSafeInteger(value.queued_inputs) || value.queued_inputs < 0 || !Number.isSafeInteger(value.inflight_requests) || value.inflight_requests < 0) throw new MemoryError('INVALID_HOST_ACTIVITY')
    if (value.disposed || value.running || value.queued_inputs || value.inflight_requests) throw new MemoryError('HOST_NOT_IDLE')
    const idleSince = lifecycleTime(value.idle_since)
    if (idleSince > now || now - idleSince < this.#policy.idleMs) throw new MemoryError('HOST_NOT_IDLE')
    if (captured && (captured.epoch !== value.epoch || captured.idle_since !== value.idle_since || identityKeys.some((key) => captured[key] !== value[key]))) throw new MemoryError('HOST_ACTIVITY_CHANGED')
    return Object.freeze({ ...Object.fromEntries(identityKeys.map((key) => [key, value[key]])), epoch: value.epoch, idle_since: value.idle_since })
  }

  async initialize(context) {
    this.#authorize(context)
    return this.#store.managedTransaction(`maintenance-baseline-${digest(identityKeys.map((key) => context[key])).slice(0, 40)}`, { action: 'initializeLifecycleMaintenance' }, ({ manifest }) => {
      this.#authorize(context)
      const existing = loadMaintenanceState(this.#store.root, this.#store.memorySpaceId)
      if (existing) return { changes: [], result: { status: 'unchanged', state: existing } }
      const state = createMaintenanceBaseline({ memorySpaceId: this.#store.memorySpaceId, now: this.#clock(), revisionWatermark: manifest.revision_watermark })
      return { changes: [], maintenance_descriptor: { schema_version: 1, memory_space_id: this.#store.memorySpaceId, expected_generation: 0, next: state }, result: { status: 'initialized', state } }
    }, context, { authorize: () => this.#authorize(context) })
  }

  async runOnce(args = {}, context, { signal } = {}) {
    try {
      assertOnly(args, ['force'])
      if (args.force !== undefined && typeof args.force !== 'boolean') throw new MemoryError('INVALID_MAINTENANCE_FORCE')
      this.#authorize(context, signal)
      await this.initialize(context)
      const snapshot = await this.#store.managedRead(context, ({ manifest }) => ({ state: loadMaintenanceState(this.#store.root, this.#store.memorySpaceId), watermark: manifest.revision_watermark }))
      const due = evaluateMaintenanceDue(snapshot.state, { now: this.#clock(), revisionWatermark: snapshot.watermark, days: this.#policy.days, writes: this.#policy.writes })
      if (!due.due && !args.force) return { status: 'skipped', reason_code: 'NOT_DUE', due, changed: 0 }
      const activity = this.#idle(context, null, signal)
      const assertIdle = () => this.#idle(context, activity, signal)
      const plan = await this.#lifecycle.preview({ mode: 'maintenance', automatic_cold: this.#policy.automaticCold,
        min_age_days: this.#policy.minAgeDays, batch_limit: this.#policy.batchLimit, scan_limit: this.#policy.scanLimit, cursor: snapshot.state.scan_cursor }, context)
      if (plan.status) throw new MemoryError(plan.reason_code)
      assertIdle()
      let applied = { status: 'committed', results: [], affected_ids: [] }
      if (plan.actions.length) {
        applied = await this.#lifecycle.apply({ operation_id: `maintenance-${digest([snapshot.state.generation, plan.checksum]).slice(0, 48)}`, plan }, context, { authorize: assertIdle, signal })
        if (applied.status !== 'committed') return { ...applied, reason_code: applied.reason_code ?? 'MAINTENANCE_INCOMPLETE' }
      }
      const completed = !plan.next_cursor, checkedAt = new Date(lifecycleTime(this.#clock())).toISOString()
      const expected = snapshot.state
      const stateCheck = () => {
        assertIdle()
        if (digest(loadMaintenanceState(this.#store.root, this.#store.memorySpaceId)) !== digest(expected)) throw new MemoryError('MAINTENANCE_CAS_CONFLICT')
      }
      const saved = await this.#store.managedTransaction(`maintenance-state-${digest([expected.generation, plan.checksum, checkedAt]).slice(0, 48)}`,
        { action: 'completeLifecycleMaintenanceBatch', plan_checksum: plan.checksum, generation: expected.generation }, ({ manifest }) => {
          stateCheck()
          const next = { ...expected, generation: expected.generation + 1, last_checked_at: checkedAt, scan_cursor: plan.next_cursor, scan_revision_watermark: completed ? null : expected.scan_revision_watermark ?? snapshot.watermark,
            ...(completed ? { last_completed_at: checkedAt, processed_revision_watermark: expected.scan_revision_watermark ?? snapshot.watermark } : {}) }
          return { changes: [], maintenance_descriptor: { schema_version: 1, memory_space_id: this.#store.memorySpaceId, expected_generation: expected.generation, next },
            result: { status: 'checked', reason_code: completed ? applied.affected_ids.length ? 'MAINTENANCE_COMPLETED' : 'CHECKED_NO_CHANGES' : 'BATCH_INCOMPLETE', state: next, changed: applied.affected_ids.length, affected_ids: applied.affected_ids, completed } }
        }, context, { authorize: stateCheck })
      return saved
    } catch (error) { return failure(error) }
  }

  start() {
    if (this.#disposed) throw new MemoryError('MAINTENANCE_CANCELLED')
    if (!this.#policy.automatic) return { status: 'disabled' }
    if (typeof this.#contextFactory !== 'function') throw new MemoryError('TRUSTED_CONTEXT_FACTORY_REQUIRED')
    if (this.#timer || this.#running) return { status: 'running' }
    const schedule = () => { if (!this.#disposed) { this.#timer = this.#setTimer(() => { this.#timer = null; this.#running = Promise.resolve().then(() => this.runOnce({}, this.#contextFactory())).catch(() => null).finally(() => { this.#running = null; schedule() }) }, this.#policy.intervalMs); this.#timer?.unref?.() } }
    schedule(); return { status: 'running' }
  }

  async dispose() {
    this.#disposed = true; this.#controller.abort()
    if (this.#timer) this.#clearTimer(this.#timer)
    this.#timer = null
    await this.#running
  }
}
