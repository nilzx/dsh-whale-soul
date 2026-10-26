import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { MemoryError, assertId, digest } from './contracts.js'
import { commitPersonaDescriptor, reconcilePersonaState } from './persona-ledger.js'
import { commitPurgeDescriptor, filterRecoveryChanges, getPurgeState, pathIsPurged, reconcilePurgeState, referencesPurged, validateManagedPurgeArtifacts } from './purge-ledger.js'

function syncDir(path) {
  let fd
  try { fd = openSync(path, 'r'); fsyncSync(fd) } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EBADF'].includes(error?.code)) throw error
  } finally { if (fd !== undefined) closeSync(fd) }
}

export function atomicWrite(path, data) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp-${randomUUID()}`
  let fd
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, data)
    fsyncSync(fd)
    closeSync(fd); fd = undefined
    renameSync(temporary, path)
    syncDir(dirname(path))
  } finally {
    if (fd !== undefined) closeSync(fd)
    rmSync(temporary, { force: true })
  }
}

export function readJson(path, fallback = undefined) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch (error) {
    if (error?.code === 'ENOENT' && fallback !== undefined) return fallback
    throw new MemoryError('INVALID_STORAGE_JSON')
  }
}

function alive(owner) {
  if (owner.hostname !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid < 1) return true
  try { process.kill(owner.pid, 0); return true } catch (error) { return error?.code !== 'ESRCH' }
}

function createLockCandidate(root, owner) {
  const candidate = join(root, `.lock-candidate-${owner.token}`)
  mkdirSync(candidate, { mode: 0o700 })
  atomicWrite(join(candidate, 'owner.json'), JSON.stringify(owner))
  return candidate
}

export function retireExpectedLock(path, expectedToken, root, { requireDead = false } = {}) {
  const retired = join(root, `.retired-lock-${randomUUID()}`)
  try { renameSync(path, retired) } catch (error) { if (error?.code === 'ENOENT') return false; throw error }
  const moved = readJson(join(retired, 'owner.json'), null)
  if (moved?.token !== expectedToken || (requireDead && alive(moved))) {
    // A late publisher may have replaced the inspected owner. Preserve it and
    // restore its lock; never recursively delete an unexpected live owner.
    if (!existsSync(path)) renameSync(retired, path)
    throw new MemoryError(requireDead && alive(moved) ? 'LIVE_LOCK_OWNER' : 'LOCK_OWNER_CONFLICT')
  }
  rmSync(retired, { recursive: true, force: true })
  syncDir(root)
  return true
}

function managementGate(root) { return join(root, '.administration/repair.lock') }

export async function acquireRootLock(root, { waitMs = 2000 } = {}) {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  if (lstatSync(root).isSymbolicLink()) throw new MemoryError('UNSAFE_STORAGE_PATH')
  const lockPath = join(root, '.writer.lock')
  const owner = { token: randomUUID(), pid: process.pid, hostname: hostname(), acquired_at: new Date().toISOString() }
  const candidate = createLockCandidate(root, owner)
  const deadline = Date.now() + waitMs
  const releaseOwned = () => {
    const current = readJson(join(lockPath, 'owner.json'), null)
    if (current?.token === owner.token) retireExpectedLock(lockPath, owner.token, root)
  }
  try {
    for (;;) {
      if (existsSync(managementGate(root))) {
        if (Date.now() >= deadline) {
          const gateOwner = readJson(join(managementGate(root), 'owner.json'), null)
          throw new MemoryError(gateOwner && !alive(gateOwner) ? 'MANAGEMENT_RECOVERY_REQUIRED' : 'WRITER_BUSY')
        }
        await new Promise((fulfil) => setTimeout(fulfil, 8))
        continue
      }
      if (readJson(join(lockPath, 'owner.json'), null)?.token === owner.token) return releaseOwned
      if (!existsSync(candidate)) createLockCandidate(root, owner)
      try {
        renameSync(candidate, lockPath)
        syncDir(root)
        if (existsSync(managementGate(root))) {
          const current = readJson(join(lockPath, 'owner.json'), null)
          if (current?.token === owner.token) retireExpectedLock(lockPath, owner.token, root)
          await new Promise((fulfil) => setTimeout(fulfil, 8))
          continue
        }
        return releaseOwned
      } catch (error) {
        if (!['ENOTEMPTY', 'EEXIST', 'EPERM'].includes(error?.code)) throw error
      }
      const previous = readJson(join(lockPath, 'owner.json'), null)
      if (!previous) {
        // A retiring directory and a newly published owner may cross this read.
        // Retry the observation without stealing; a stable ownerless lock stays
        // fail-closed once the bounded acquisition deadline is reached.
        if (!existsSync(lockPath)) continue
        if (Date.now() >= deadline) throw new MemoryError('LOCK_RECOVERY_REQUIRED')
        await new Promise((fulfil) => setTimeout(fulfil, 8))
        continue
      }
      if (!alive(previous)) {
        // A separate reaper serializes stale-owner recovery. Its own crash is
        // fail-closed and requires a trusted repair, never a time-based steal.
        const reaper = join(root, '.writer-recovery.lock')
        const reaperOwner = { ...owner, token: randomUUID() }
        const reaperCandidate = createLockCandidate(root, reaperOwner)
        let reaping = false
        try {
          try { renameSync(reaperCandidate, reaper); reaping = true } catch (error) {
            if (!['ENOTEMPTY', 'EEXIST', 'EPERM'].includes(error?.code)) throw error
          }
          if (reaping) {
            const current = readJson(join(lockPath, 'owner.json'), null)
            if (!existsSync(managementGate(root)) && current?.token === previous.token && !alive(current)) {
              retireExpectedLock(lockPath, previous.token, root, { requireDead: true })
            }
          }
        } finally {
          rmSync(reaperCandidate, { recursive: true, force: true })
          if (reaping) retireExpectedLock(reaper, reaperOwner.token, root)
        }
      }
      if (Date.now() >= deadline) throw new MemoryError('WRITER_BUSY')
      await new Promise((fulfil) => setTimeout(fulfil, 8))
    }
  } finally { rmSync(candidate, { recursive: true, force: true }) }
}

export class TransactionEngine {
  constructor({ root, lockRoot = root, memorySpaceId = null, faultInjector, generationProvider, recoveryGuard = () => true, lockWaitMs = 2000 }) {
    this.root = resolve(root)
    this.lockRoot = resolve(lockRoot)
    this.faultInjector = faultInjector
    this.memorySpaceId = memorySpaceId ?? this.root.split(/[\\/]/).pop()
    this.generationProvider = generationProvider ?? (() => getPurgeState(this.lockRoot, this.memorySpaceId).generation)
    this.recoveryGuard = recoveryGuard
    this.lockWaitMs = lockWaitMs
  }

  resolvePath(path) {
    if (typeof path !== 'string' || !path || isAbsolute(path)) throw new MemoryError('UNSAFE_STORAGE_PATH')
    const target = resolve(this.root, path)
    const rel = relative(this.root, target)
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) throw new MemoryError('UNSAFE_STORAGE_PATH')
    const fromLockRoot = relative(this.lockRoot, target)
    if (fromLockRoot === '..' || fromLockRoot.startsWith(`..${sep}`) || isAbsolute(fromLockRoot)) throw new MemoryError('UNSAFE_STORAGE_PATH')
    let current = this.lockRoot
    const pieces = fromLockRoot.split(sep)
    for (const part of ['', ...pieces]) {
      if (part) current = join(current, part)
      let stat
      try { stat = lstatSync(current) } catch (error) { if (error?.code !== 'ENOENT') throw error }
      if (stat?.isSymbolicLink()) throw new MemoryError('UNSAFE_STORAGE_PATH')
    }
    return target
  }

  async locked(callback) {
    const release = await acquireRootLock(this.lockRoot, { waitMs: this.lockWaitMs })
    try { return await callback() } finally { release() }
  }

  _checkpoint(point, info = {}) { this.faultInjector?.(point, info) }

  _apply(transaction) {
    commitPurgeDescriptor(this.lockRoot, this.root, transaction.purge_descriptor, atomicWrite)
    if (transaction.purge_descriptor) this._checkpoint('after_purge_ledger', { operation_id: transaction.operation_id })
    const personaDescriptors = transaction.persona_descriptors ?? (transaction.persona_descriptor ? [transaction.persona_descriptor] : [])
    for (let index = 0; index < personaDescriptors.length; index++) {
      commitPersonaDescriptor(this.lockRoot, this.root, personaDescriptors[index], atomicWrite)
      this._checkpoint('after_persona_descriptor', { index, operation_id: transaction.operation_id })
    }
    if (personaDescriptors.length) this._checkpoint('after_persona_ledger', { operation_id: transaction.operation_id })
    const state = getPurgeState(this.lockRoot, this.memorySpaceId)
    const changes = filterRecoveryChanges(transaction.changes, state, readJson(join(this.root, 'manifest.json'), null), { filterDerived: transaction.generation < state.generation && !transaction.purge_descriptor })
    for (let index = 0; index < changes.length; index++) {
      const change = changes[index]
      const path = this.resolvePath(change.path)
      if (change.data === null) { rmSync(path, { recursive: true, force: true }); if (existsSync(dirname(path))) syncDir(dirname(path)) }
      else atomicWrite(path, Buffer.from(change.data, 'base64'))
      this._checkpoint('after_apply', { index, operation_id: transaction.operation_id })
    }
    reconcilePurgeState(this.lockRoot, this.root, atomicWrite)
    reconcilePersonaState(this.lockRoot, this.root, atomicWrite)
  }

  _recover() {
    const journal = join(this.root, 'journal')
    if (!existsSync(journal)) return
    for (const dirent of readdirSync(journal, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!dirent.isDirectory()) continue
      const path = this.resolvePath(`journal/${assertId(dirent.name)}`)
      const transaction = readJson(join(path, 'prepared.json'), null)
      const committed = existsSync(join(path, 'COMMIT'))
      if (committed && (!transaction || transaction.transaction_id !== dirent.name || readFileSync(join(path, 'COMMIT'), 'utf8') !== dirent.name || !Array.isArray(transaction.changes) || !/^[a-f0-9]{64}$/.test(transaction.receipt_key))) throw new MemoryError('JOURNAL_REPAIR_REQUIRED')
      if (!committed) { rmSync(path, { recursive: true, force: true }); continue }
      if (!this.recoveryGuard(transaction)) {
        rmSync(path, { recursive: true, force: true })
        continue
      }
      try {
        this._apply(transaction)
        atomicWrite(this.resolvePath(`operations/${transaction.receipt_key}.json`), JSON.stringify(transaction.receipt, null, 2))
        rmSync(path, { recursive: true, force: true })
        syncDir(journal)
      } catch { throw new MemoryError('COMMIT_RECOVERY_REQUIRED') }
    }
  }

  async read(callback) {
    return this.locked(() => { this._recover(); reconcilePurgeState(this.lockRoot, this.root, atomicWrite); reconcilePersonaState(this.lockRoot, this.root, atomicWrite); return callback() })
  }

  async run(operationId, request, build, { authorize = () => {} } = {}) {
    assertId(operationId, 'operation_id')
    return this.locked(async () => {
      this._recover()
      reconcilePurgeState(this.lockRoot, this.root, atomicWrite)
      reconcilePersonaState(this.lockRoot, this.root, atomicWrite)
      authorize()
      const receiptKey = digest(operationId)
      const requestHash = digest(request)
      const receiptPath = this.resolvePath(`operations/${receiptKey}.json`)
      const existing = readJson(receiptPath, null)
      if (existing) {
        if (existing.request_hash !== requestHash) throw new MemoryError('OPERATION_CONFLICT')
        const state = getPurgeState(this.lockRoot, this.memorySpaceId)
        if (existing.result.reason_code !== 'PURGED' && (existing.result.affected_ids ?? []).some((id) => state.record_ids.includes(id))) {
          return { api_version: existing.result.api_version, operation_id: operationId, status: 'purged', reason_code: 'PURGED_BY_MANAGEMENT', affected_ids: [], pending: false, replayed: true }
        }
        return { ...existing.result, replayed: true }
      }
      const built = await build()
      authorize()
      if (built?.purge_descriptor) validateManagedPurgeArtifacts(this.lockRoot, this.memorySpaceId)
      if (!built || !Array.isArray(built.changes)) throw new MemoryError('INVALID_TRANSACTION')
      const changes = built.changes.map((change) => {
        this.resolvePath(change.path)
        return { path: change.path, data: change.data === null ? null : Buffer.from(change.data).toString('base64') }
      })
      const purgeState = getPurgeState(this.lockRoot, this.memorySpaceId)
      if (!built.purge_descriptor && purgeState.generation) for (const change of changes) {
        if (change.data === null) continue
        if (pathIsPurged(change.path, purgeState)) throw new MemoryError('PURGED_CONTENT')
        if (/^(records|self|candidates|evidence)\//.test(change.path) && change.path.endsWith('.json') && !change.path.endsWith('/manifest.json')) {
          let value
          try { value = JSON.parse(Buffer.from(change.data, 'base64').toString('utf8')) } catch { continue }
          if (referencesPurged(value, purgeState)) throw new MemoryError('PURGED_CONTENT')
        }
      }
      const transaction = {
        transaction_id: randomUUID(), operation_id: operationId, receipt_key: receiptKey,
        generation: this.generationProvider(), changes,
        ...(built.purge_descriptor ? { purge_descriptor: built.purge_descriptor } : {}),
        ...(built.persona_descriptor ? { persona_descriptor: built.persona_descriptor } : {}),
        ...(built.persona_descriptors ? { persona_descriptors: built.persona_descriptors } : {}),
        receipt: { operation_id: operationId, request_hash: requestHash, result: built.result },
      }
      const path = this.resolvePath(`journal/${transaction.transaction_id}`)
      mkdirSync(path, { recursive: true, mode: 0o700 })
      atomicWrite(join(path, 'prepared.json'), JSON.stringify(transaction))
      try {
        this._checkpoint('after_prepare', { operation_id: operationId })
        authorize()
      } catch (error) {
        // A synchronous cancellation has a live owner that can remove its
        // uncommitted body now. Abrupt process death still uses startup redo.
        rmSync(path, { recursive: true, force: true })
        syncDir(dirname(path))
        throw error
      }
      atomicWrite(join(path, 'COMMIT'), transaction.transaction_id)
      try {
        this._checkpoint('after_commit', { operation_id: operationId })
        this._apply(transaction)
        atomicWrite(receiptPath, JSON.stringify(transaction.receipt, null, 2))
        this._checkpoint('after_receipt', { operation_id: operationId })
        rmSync(path, { recursive: true, force: true })
        syncDir(dirname(path))
        return built.result
      } catch { throw new MemoryError('COMMIT_RECOVERY_REQUIRED') }
    })
  }
}
