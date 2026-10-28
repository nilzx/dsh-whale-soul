import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { MemoryError, digest } from '../memory/v2/contracts.js'
import { acquireRootLock, atomicWrite } from '../memory/v2/transactions.js'
import { MemoryStoreV2 } from '../memory/v2/store.js'
import { rebuildMemorySnapshot, getMemoryRebuildSpec } from '../memory/v2/rebuild.js'
import { getPersonaAnchor, personaBinding } from '../memory/v2/persona-ledger.js'
import { commitSourceProtection, sourceProtectionSnapshot } from '../memory/v2/source-protection.js'
import { PersonaState } from './state.js'
import { getWhaleCore } from './core.js'

const jobs = new Map()
const json = value => `${JSON.stringify(value, null, 2)}\n`
export const isMemoryDataError = error => !/SCOPE|CONTEXT|CAPABILITY|NOT_FOUND|PURGED|CONFLICT/.test(error?.code ?? '') && /(?:LEGACY_|EXTERNAL_CHANGE|MIXED_MEMORY|SESSION_(?:MIRROR|BINDING)|MEMORY_ROOT|MEMORY_SPACE|STORAGE_JSON|RECORD_|PERSONA_|SELF_|LIFECYCLE_INTEGRITY|INTEGRITY_|SOURCE_PROTECTION|UNSUPPORTED_(?:FORMAT|API|SPACE|RECORD|SELF)|INVALID_(?:ROOT|SPACE|MANIFEST|MEMORY|RECORD|PERSONA|SELF|STABILITY|TRANSFER))/.test(error?.code ?? '')
function files(root, base = '') {
  const rows = []
  for (const entry of readdirSync(join(root, base), { withFileTypes: true })) {
    const path = join(base, entry.name)
    if (entry.isSymbolicLink()) throw new MemoryError('UNSAFE_STORAGE_PATH')
    if (entry.isDirectory()) rows.push(...files(root, path))
    else if (entry.isFile()) rows.push({ path, bytes: lstatSync(join(root, path)).size, sha256: digest(readFileSync(join(root, path))) })
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path))
}
const hash = root => digest(files(root))
function inside(root, name) {
  const path = resolve(root, name)
  if (!path.startsWith(`${resolve(root)}${sep}`)) throw new MemoryError('REPAIR_MEMORY_PATH_REQUIRED')
  let current = resolve(root)
  for (const part of path.slice(current.length + 1).split(sep)) {
    current = join(current, part)
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new MemoryError('REPAIR_MEMORY_PATH_REQUIRED')
  }
  return path
}
async function delay(ms, signal) {
  signal?.throwIfAborted()
  await new Promise((done, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); done() }, ms)
    const abort = () => { clearTimeout(timer); reject(signal.reason ?? new Error('Cancelled')) }
    signal?.addEventListener('abort', abort, { once: true })
  })
}
const schema = properties => ({ type: 'object', properties, additionalProperties: false })

/** Repair jobs own memory data only; the model never receives a plugin or shell write tool. */
export function repairPersonaMemory(options) {
  const root = resolve(options.root), pluginRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
  if (root === pluginRoot || root.startsWith(`${pluginRoot}${sep}`) || pluginRoot.startsWith(`${root}${sep}`)) throw new MemoryError('REPAIR_MEMORY_DIRECTORY_REQUIRED')
  if (jobs.has(root)) return jobs.get(root)
  const promise = (async () => {
    for (;;) {
      try { return await repair({ ...options, root }) }
      catch (error) {
        if (options.signal?.aborted) throw error
        try { options.onStatus?.('retrying') } catch {}
        await delay(options.retryDelayMs ?? 30_000, options.signal)
      }
    }
  })().finally(() => jobs.delete(root))
  jobs.set(root, promise)
  return promise
}
async function repair({ root, cause, runAgent, signal, retryDelayMs = 30_000, onStatus,
  memorySpaceId = 'owner', subjectId = 'owner', individualKey = 'default', stabilityMode = 'auto', core = getWhaleCore() }) {
  const jobRoot = `${root}.repair`, source = join(jobRoot, 'source'), target = join(jobRoot, 'target'), journal = join(jobRoot, 'job.json')
  const lock = `${root}.repair-lock`, statusFile = `${root}.repair-status.json`
  const release = await acquireRootLock(lock, { waitMs: 30_000 })
  let job, valid = false, validation
  const status = state => {
    atomicWrite(statusFile, json({ schema_version: 1, job_id: job?.id, state, attempts: job?.attempts ?? 0,
      error_code: cause?.code ?? null, updated_at: new Date().toISOString() }))
    try { onStatus?.(state) } catch {}
  }
  const save = () => atomicWrite(journal, json(job))
  const finish = () => {
    if (existsSync(root) && existsSync(target)) throw new MemoryError('REPAIR_PUBLISH_CONFLICT')
    if (!existsSync(root) && existsSync(target) && existsSync(job.backup)) renameSync(target, root)
    if (!existsSync(root) || existsSync(target)) throw new MemoryError('REPAIR_PUBLISH_INCOMPLETE')
    status('completed')
    rmSync(jobRoot, { recursive: true, force: true })
    return { status: 'repaired', backupRoot: job.backup, validation }
  }
  try {
    if (existsSync(journal)) {
      job = JSON.parse(readFileSync(journal, 'utf8'))
      if (job.root !== root || job.schema_version !== 1) throw new MemoryError('INVALID_MEMORY_REPAIR_JOB')
      if (job.phase === 'prepared' && existsSync(root) && existsSync(target) && !existsSync(job.backup)) {
        if (hash(root) !== job.original_hash) throw new MemoryError('REPAIR_SOURCE_CHANGED')
        renameSync(root, job.backup); job.phase = 'preserved'; save()
      }
      if (['prepared', 'preserved', 'published'].includes(job.phase)) return finish()
    } else {
      const id = randomUUID()
      job = { schema_version: 1, id, root, backup: `${root}.repair-backup-${id}`, phase: 'repairing', attempts: 0,
        original_hash: hash(root) }
      mkdirSync(jobRoot, { recursive: true, mode: 0o700 })
      cpSync(root, source, { recursive: true, errorOnExist: true, force: false, dereference: false })
      save()
    }
    const scaffold = join(jobRoot, 'scaffold')
    const scaffoldStore = new MemoryStoreV2({ root: scaffold, memory_space_id: memorySpaceId })
    const scaffoldState = new PersonaState({ store: scaffoldStore, persona_id: core.persona_id, core_version: core.version,
      mode: stabilityMode, subject_id: subjectId, individual_key: individualKey })
    await scaffoldState.initialize()
    const defaultAnchor = getPersonaAnchor(scaffold, memorySpaceId, personaBinding(core.persona_id, subjectId, individualKey))
    const backupNames = readdirSync(dirname(root), { withFileTypes: true }).filter(entry => entry.isDirectory() &&
      (entry.name.startsWith(`${basename(root)}.repair-backup-`) || entry.name === `${basename(root)}.legacy-v1` || entry.name.startsWith(`${basename(root)}-v1-preserved-`))).map(entry => entry.name)
    const sourceSpaces = existsSync(join(source, 'spaces')) ? readdirSync(join(source, 'spaces'), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name) : []
    const spacesToRepair = [...new Set([...sourceSpaces, memorySpaceId])]
    const tools = {
      list_backups: { description: 'List preserved backups of this memory directory.', schema: schema({}), execute: () => backupNames },
      read_backup: { description: 'Read a file from a listed backup and make its bytes available as a source_path for recovery.',
        schema: schema({ backup: { type: 'string' }, path: { type: 'string' } }), execute: ({ backup, path }) => {
          if (!backupNames.includes(backup)) throw new MemoryError('REPAIR_BACKUP_NOT_FOUND')
          const file = inside(join(dirname(root), backup), path), sourcePath = join('recovered-backups', backup, path)
          const data = readFileSync(file); atomicWrite(inside(source, sourcePath), data)
          return { source_path: sourcePath, bytes: data.length, content: data.toString('utf8').slice(0, 64_000) }
        } },
      read_current_spec: { description: 'Read the current memory snapshot specification and the default identity for data without an identity.', schema: schema({}), execute: () => ({
        ...getMemoryRebuildSpec(), memory_space_id: memorySpaceId, spacesToRepair, multiSpaceSnapshot: 'For more than one space, submit {spaces:[{memorySpaceId,snapshot}],sessionBindings?,sourceProtection?}; include every listed space. The optional sessionBindings/sourceProtection apply to the whole root.', defaultPersona: { anchor: defaultAnchor, files: [] },
        cause: { code: cause?.code, message: cause?.message }, resume_snapshot: existsSync(join(jobRoot, 'snapshot.json')) ? JSON.parse(readFileSync(join(jobRoot, 'snapshot.json'))) : null }) },
      list_source: { description: 'List preserved memory files by optional prefix, with pagination. Paths are relative to the original memory root.',
        schema: schema({ prefix: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }), execute: ({ prefix = '', offset = 0, limit = 200 } = {}) => {
          const rows = files(source).filter(row => row.path.startsWith(prefix)), end = offset + Math.min(500, Math.max(1, limit))
          return { files: rows.slice(offset, end), total: rows.length, nextOffset: end < rows.length ? end : null }
        } },
      read_source: { description: 'Read a preserved UTF-8 memory file. Large prose can be retained using source_path references without retyping.',
        schema: schema({ path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }), execute: ({ path, offset = 0, limit = 32_000 }) => {
          const data = readFileSync(inside(source, path)), content = data.toString('utf8')
          return { path, bytes: data.length, content: content.slice(Math.max(0, offset), Math.max(0, offset) + Math.min(64_000, limit)), totalCharacters: content.length }
        } },
      write_snapshot: { description: 'Save a normalized snapshot following read_current_spec. Do not include hashes, plugin code, repair reports or invented memories.',
        schema: schema({ snapshot: { type: 'object', additionalProperties: true } }), execute: ({ snapshot }) => {
          atomicWrite(join(jobRoot, 'snapshot.json'), json(snapshot)); valid = false; return { saved: true }
        } },
      validate_current: { description: 'Materialize and validate the saved snapshot using the current memory implementation; errors are returned for further repair.',
        schema: schema({}), execute: async () => {
          try {
            const snapshot = JSON.parse(readFileSync(join(jobRoot, 'snapshot.json'), 'utf8'))
            rmSync(target, { recursive: true, force: true })
            const requested = snapshot.spaces ?? [{ memorySpaceId, snapshot }]
            if (!Array.isArray(requested) || spacesToRepair.some(space => !requested.some(item => item.memorySpaceId === space))) throw new MemoryError('REPAIR_SPACES_REQUIRED')
            const ids = new Set(), results = []
            let sharedSessions = snapshot.sessionBindings
            let sharedProtection = snapshot.sourceProtection
            for (const entry of requested) {
              if (ids.has(entry.memorySpaceId)) throw new MemoryError('REPAIR_DUPLICATE_SPACE')
              const current = { ...entry.snapshot }
              if (sharedSessions !== undefined) current.sessionBindings = sharedSessions
              if (sharedProtection !== undefined) current.sourceProtection = sharedProtection
              results.push(await rebuildMemorySnapshot({ root: target, sourceRoot: source, memorySpaceId: entry.memorySpaceId,
                snapshot: current, appendSpace: ids.size > 0, operationId: `memory-repair-${digest({ job: job.id, space: entry.memorySpaceId }).slice(0, 40)}` }))
              ids.add(entry.memorySpaceId)
              for (const [name, key] of [['session-bindings.json', 'session'], ['source-protection.json', 'protection']]) {
                const path = join(target, '.administration', name)
                if (existsSync(path)) { const value = JSON.parse(readFileSync(path, 'utf8')); if (key === 'session') sharedSessions = value; else sharedProtection = value }
              }
            }
            validation = { status: 'rebuilt', recordCount: results.reduce((sum, item) => sum + item.recordCount, 0),
              unresolvedCount: results.reduce((sum, item) => sum + (item.unresolvedCount ?? 0), 0), spaces: [...ids] }
            const store = await new MemoryStoreV2({ root: target, memory_space_id: memorySpaceId }).initialize()
            const state = new PersonaState({ store, persona_id: core.persona_id, core_version: core.version, mode: stabilityMode, subject_id: subjectId, individual_key: individualKey })
            await state.initialize()
            const records = store._records(); if (records.warnings.length) throw new MemoryError('REPAIR_RECORD_VALIDATION_FAILED')
            valid = true; return { valid: true, ...validation }
          } catch (error) { valid = false; return { valid: false, errors: [{ code: error.code ?? 'INVALID_REPAIR_SNAPSHOT', message: error.message }] } }
        } },
    }
    for (;;) {
      signal?.throwIfAborted(); job.attempts++; save(); status('repairing')
      const result = await runAgent({ tools, signal })
      if (result.status === 'completed' && valid) break
      status('retrying')
      await delay(Math.min(5 * 60_000, retryDelayMs * Math.max(1, job.attempts)), signal)
    }
    if (hash(root) !== job.original_hash) {
      // A concurrent writer changed the source: refresh the preserved input and
      // let the repair Agent reconcile it instead of publishing an older view.
      rmSync(source, { recursive: true, force: true }); cpSync(root, source, { recursive: true }); job.original_hash = hash(root)
      rmSync(join(jobRoot, 'snapshot.json'), { force: true }); rmSync(target, { recursive: true, force: true }); save()
      status('retrying')
      throw new MemoryError('REPAIR_SOURCE_CHANGED')
    }
    const previousProtection = sourceProtectionSnapshot(target).state
    commitSourceProtection(target, { expected_generation: previousProtection?.generation ?? 0, next: { schema_version: 1, generation: (previousProtection?.generation ?? 0) + 1,
      sources: [...(previousProtection?.sources ?? []), { canonical_root: job.backup, source_snapshot: job.original_hash, operation_id: `memory-repair-${job.id}` }] } }, atomicWrite)
    job.phase = 'prepared'; save()
    renameSync(root, job.backup); job.phase = 'preserved'; save()
    renameSync(target, root); job.phase = 'published'; save()
    return finish()
  } finally {
    release()
    try { rmdirSync(lock) } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error }
  }
}
