import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import { MemoryError, digest } from '../memory/v2/contracts.js'
import { acquireRootLock, atomicWrite } from '../memory/v2/transactions.js'
import { inspectMemoryRoot } from '../memory/v2/root-format.js'
import { MemoryStoreV2 } from '../memory/v2/store.js'
import { MemoryTransfer } from '../memory/v2/transfer.js'
import { PersonaState } from './state.js'
import { getWhaleCore } from './core.js'
import { resolveMemoryStorageRoot } from '../paths.js'

const json = value => `${JSON.stringify(value, null, 2)}\n`
const checked = result => {
  if (!['ok', 'committed', 'unchanged'].includes(result?.status)) throw new MemoryError(result?.reason_code ?? 'LEGACY_UPGRADE_CONVERSION_FAILED')
  return result
}
function snapshot(root) {
  const files = []
  let bytes = 0
  const walk = (path = '') => {
    for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
      const name = join(path, entry.name), file = join(root, name)
      if (entry.isSymbolicLink()) throw new MemoryError('UNSAFE_STORAGE_PATH')
      if (entry.isDirectory()) walk(name)
      else if (entry.isFile()) {
        const data = readFileSync(file); bytes += data.length
        if (bytes > 256 * 1024 * 1024 || files.length >= 20_000) throw new MemoryError('LEGACY_UPGRADE_LIMIT_EXCEEDED')
        files.push({ path: name, sha256: digest(data) })
      } else throw new MemoryError('INVALID_LEGACY_ROOT')
    }
  }
  walk()
  return digest(files.sort((a, b) => a.path.localeCompare(b.path)))
}
function legacy(root, space) {
  try { inspectMemoryRoot(root, space); return false }
  catch (error) { if (error.code === 'LEGACY_MIGRATION_REQUIRED') return true; throw error }
}

/** Host startup only. The neutral store and management CLI retain explicit migration semantics. */
export async function preparePersonaMemory({ root, memorySpaceId = 'owner', subjectId = 'owner', individualKey = 'default',
  stabilityMode = 'auto', core = getWhaleCore(), faultInjector } = {}) {
  root = resolveMemoryStorageRoot(root)
  const stage = `${root}.upgrade-v1`, backupRoot = `${root}.legacy-v1`, journal = `${root}.upgrade-v1.json`, lock = `${root}.upgrade-v1-lock`
  if (!existsSync(journal) && (!existsSync(root) || existsSync(join(root, 'manifest.json')) || !legacy(root, memorySpaceId))) return { status: 'unchanged' }
  const release = await acquireRootLock(lock, { waitMs: 30_000 })
  let progress
  const save = () => atomicWrite(journal, json(progress))
  const cleanup = () => { rmSync(stage, { recursive: true, force: true }); rmSync(journal, { force: true }) }
  const publish = () => {
    if (existsSync(root) && existsSync(stage) && !legacy(root, memorySpaceId)) throw new MemoryError('LEGACY_UPGRADE_RECOVERY_REQUIRED')
    if (existsSync(root) && legacy(root, memorySpaceId)) {
      if (existsSync(backupRoot)) throw new MemoryError('LEGACY_UPGRADE_BACKUP_EXISTS')
      if (snapshot(root) !== progress.source_hash) throw new MemoryError('SOURCE_CHANGED')
      renameSync(root, backupRoot)
      progress.phase = 'preserved'; save(); faultInjector?.('after_preserve', { root, stage, backupRoot })
    }
    if (!existsSync(root)) {
      if (!existsSync(backupRoot) || snapshot(backupRoot) !== progress.source_hash || !existsSync(stage)) throw new MemoryError('LEGACY_UPGRADE_RECOVERY_REQUIRED')
      inspectMemoryRoot(stage, memorySpaceId)
      renameSync(stage, root)
      progress.phase = 'published'; save(); faultInjector?.('after_publish', { root, stage, backupRoot })
    }
    inspectMemoryRoot(root, memorySpaceId)
    cleanup()
  }
  try {
    if (existsSync(journal)) {
      if (lstatSync(journal).isSymbolicLink()) throw new MemoryError('UNSAFE_STORAGE_PATH')
      progress = JSON.parse(readFileSync(journal, 'utf8'))
      if (progress.schema_version !== 1 || progress.root !== root || progress.space !== memorySpaceId ||
        !['building', 'prepared', 'preserved', 'published'].includes(progress.phase)) throw new MemoryError('LEGACY_UPGRADE_RECOVERY_REQUIRED')
      if (progress.phase !== 'building') {
        publish()
        return { status: 'recovered', backupRoot, recordCount: progress.record_count }
      }
      if (!existsSync(root) || !legacy(root, memorySpaceId)) throw new MemoryError('LEGACY_UPGRADE_RECOVERY_REQUIRED')
      cleanup()
    }
    if (!legacy(root, memorySpaceId)) return { status: 'unchanged' }
    if (existsSync(stage) || existsSync(backupRoot)) throw new MemoryError('LEGACY_UPGRADE_BACKUP_EXISTS')
    progress = { schema_version: 1, root, space: memorySpaceId, phase: 'building', source_hash: snapshot(root) }
    save()
    const store = new MemoryStoreV2({ root: stage, memory_space_id: memorySpaceId })
    const state = new PersonaState({ store, persona_id: core.persona_id, core_version: core.version,
      mode: stabilityMode, subject_id: subjectId, individual_key: individualKey })
    await state.initialize()
    const context = store.issueContext({ ...state.identity, capabilities: ['memory.manage'] })
    const operationId = `auto-upgrade-v1-${progress.source_hash.slice(0, 40)}`
    let sourceSnapshot
    const transfer = new MemoryTransfer({ store, sourceProtectionBuilder: () => ({ expected_generation: 0,
      next: { schema_version: 1, generation: 1, sources: [{ canonical_root: backupRoot, source_snapshot: sourceSnapshot, operation_id: operationId }] } }) })
    const { persona_id, agent_identity_id, subject_id } = state.identity
    const args = { source_root: root, source_quiescent: true, identity: { persona_id, agent_identity_id, subject_id }, opaque_policy: 'preserve_local' }
    const preview = checked(await transfer.migrateV1({ ...args, dry_run: true }, context))
    const expected = readdirSync(join(root, 'entries'), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
    if (JSON.stringify([...preview.record_ids].sort()) !== JSON.stringify(expected)) throw new MemoryError('LEGACY_UPGRADE_INCOMPLETE_RECORDS')
    sourceSnapshot = preview.source_snapshot
    const result = checked(await transfer.migrateV1({ ...args, expected_snapshot: sourceSnapshot, operation_id: operationId }, context))
    if (JSON.stringify([...result.record_ids].sort()) !== JSON.stringify(expected)) throw new MemoryError('LEGACY_UPGRADE_INCOMPLETE_RECORDS')
    for (const id of expected) store._readRecord(id)
    if (snapshot(root) !== progress.source_hash) throw new MemoryError('SOURCE_CHANGED')
    inspectMemoryRoot(stage, memorySpaceId)
    progress = { ...progress, phase: 'prepared', record_count: expected.length }; save()
    faultInjector?.('after_convert', { root, stage, backupRoot })
    publish()
    return { status: 'upgraded', backupRoot, recordCount: expected.length, warnings: result.warnings ?? [] }
  } catch (error) {
    if (progress?.phase === 'building') cleanup()
    throw new MemoryError(error.code ?? 'LEGACY_UPGRADE_FAILED',
      `记忆自动升级未完成（${error.code ?? 'LEGACY_UPGRADE_FAILED'}）。原数据已保留在 ${existsSync(backupRoot) ? backupRoot : root}。将由独立记忆修复任务继续处理。`)
  } finally {
    release()
    try { rmdirSync(lock) } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error }
  }
}
