import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { MemoryError, assertId, digest } from './contracts.js'

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

function retireLock(path, root) {
  const retired = join(root, `.retired-lock-${randomUUID()}`)
  renameSync(path, retired)
  rmSync(retired, { recursive: true, force: true })
  syncDir(root)
}

export async function acquireRootLock(root, { waitMs = 2000 } = {}) {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  if (lstatSync(root).isSymbolicLink()) throw new MemoryError('UNSAFE_STORAGE_PATH')
  const lockPath = join(root, '.writer.lock')
  const owner = { token: randomUUID(), pid: process.pid, hostname: hostname(), acquired_at: new Date().toISOString() }
  const candidate = createLockCandidate(root, owner)
  const deadline = Date.now() + waitMs
  try {
    for (;;) {
      try {
        renameSync(candidate, lockPath)
        syncDir(root)
        return () => {
          const current = readJson(join(lockPath, 'owner.json'), null)
          if (current?.token === owner.token) retireLock(lockPath, root)
        }
      } catch (error) {
        if (!['ENOTEMPTY', 'EEXIST', 'EPERM'].includes(error?.code)) throw error
      }
      const previous = readJson(join(lockPath, 'owner.json'), null)
      if (!previous) {
        if (!existsSync(lockPath)) continue
        throw new MemoryError('LOCK_RECOVERY_REQUIRED')
      }
      if (!alive(previous)) {
        // A separate reaper serializes stale-owner recovery. Its own crash is
        // fail-closed and requires a trusted repair, never a time-based steal.
        const reaper = join(root, '.writer-recovery.lock')
        const reaperCandidate = createLockCandidate(root, { ...owner, token: randomUUID() })
        let reaping = false
        try {
          try { renameSync(reaperCandidate, reaper); reaping = true } catch (error) {
            if (!['ENOTEMPTY', 'EEXIST', 'EPERM'].includes(error?.code)) throw error
          }
          if (reaping) {
            const current = readJson(join(lockPath, 'owner.json'), null)
            if (current?.token === previous.token && !alive(current)) {
              const stale = join(root, `.stale-lock-${randomUUID()}`)
              renameSync(lockPath, stale)
              rmSync(stale, { recursive: true, force: true })
            }
          }
        } finally {
          rmSync(reaperCandidate, { recursive: true, force: true })
          if (reaping) retireLock(reaper, root)
        }
      }
      if (Date.now() >= deadline) throw new MemoryError('WRITER_BUSY')
      await new Promise((fulfil) => setTimeout(fulfil, 8))
    }
  } finally { rmSync(candidate, { recursive: true, force: true }) }
}

export class TransactionEngine {
  constructor({ root, lockRoot = root, faultInjector, generationProvider = () => 0, recoveryGuard = () => true, lockWaitMs = 2000 }) {
    this.root = resolve(root)
    this.lockRoot = resolve(lockRoot)
    this.faultInjector = faultInjector
    this.generationProvider = generationProvider
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
    for (let index = 0; index < transaction.changes.length; index++) {
      const change = transaction.changes[index]
      const path = this.resolvePath(change.path)
      if (change.data === null) { rmSync(path, { recursive: true, force: true }); if (existsSync(dirname(path))) syncDir(dirname(path)) }
      else atomicWrite(path, Buffer.from(change.data, 'base64'))
      this._checkpoint('after_apply', { index, operation_id: transaction.operation_id })
    }
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
      if (transaction.generation < this.generationProvider() || !this.recoveryGuard(transaction)) {
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
    return this.locked(() => { this._recover(); return callback() })
  }

  async run(operationId, request, build, { authorize = () => {} } = {}) {
    assertId(operationId, 'operation_id')
    return this.locked(async () => {
      this._recover()
      authorize()
      const receiptKey = digest(operationId)
      const requestHash = digest(request)
      const receiptPath = this.resolvePath(`operations/${receiptKey}.json`)
      const existing = readJson(receiptPath, null)
      if (existing) {
        if (existing.request_hash !== requestHash) throw new MemoryError('OPERATION_CONFLICT')
        return { ...existing.result, replayed: true }
      }
      const built = await build()
      authorize()
      if (!built || !Array.isArray(built.changes)) throw new MemoryError('INVALID_TRANSACTION')
      const changes = built.changes.map((change) => {
        this.resolvePath(change.path)
        return { path: change.path, data: change.data === null ? null : Buffer.from(change.data).toString('base64') }
      })
      const transaction = {
        transaction_id: randomUUID(), operation_id: operationId, receipt_key: receiptKey,
        generation: this.generationProvider(), changes,
        receipt: { operation_id: operationId, request_hash: requestHash, result: built.result },
      }
      const path = this.resolvePath(`journal/${transaction.transaction_id}`)
      mkdirSync(path, { recursive: true, mode: 0o700 })
      atomicWrite(join(path, 'prepared.json'), JSON.stringify(transaction))
      this._checkpoint('after_prepare', { operation_id: operationId })
      authorize()
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
