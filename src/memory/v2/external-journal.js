import { closeSync, constants, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { MemoryError, assertId, assertOnly, digest, stableStringify } from './contracts.js'
import { RECORD_FILES } from './integrity-transaction.js'

const json = (value) => `${JSON.stringify(value, null, 2)}\n`
const identity = (path) => { try { const st = lstatSync(path); return { dev: st.dev, ino: st.ino, directory: st.isDirectory(), symlink: st.isSymbolicLink() } } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
const same = (actual, expected) => actual && !actual.symlink && actual.directory && actual.dev === expected.dev && actual.ino === expected.ino

function validate(value) {
  assertOnly(value, ['schema_version', 'action', 'record_id', 'change_id', 'source_identity', 'source_change_id', 'bundle_hash', 'publication_id', 'resolution'])
  if (value.schema_version !== 1 || !['capture', 'publish'].includes(value.action)) throw new MemoryError('INVALID_EXTERNAL_DESCRIPTOR')
  assertId(value.record_id); assertId(value.change_id)
  if (value.source_change_id !== undefined) assertId(value.source_change_id)
  if (value.action === 'capture' && (!value.source_identity || !Number.isSafeInteger(value.source_identity.dev) || !Number.isSafeInteger(value.source_identity.ino))) throw new MemoryError('INVALID_EXTERNAL_DESCRIPTOR')
  if (value.action === 'publish' && (!/^[a-f0-9]{64}$/.test(value.bundle_hash) || !/^[a-f0-9]{64}$/.test(value.publication_id))) throw new MemoryError('INVALID_EXTERNAL_DESCRIPTOR')
  if (value.resolution !== undefined) {
    assertOnly(value.resolution, ['status', 'operation_id', 'revision_id'])
    if (!['adopted', 'restored'].includes(value.resolution.status)) throw new MemoryError('INVALID_EXTERNAL_DESCRIPTOR')
    assertId(value.resolution.operation_id); assertId(value.resolution.revision_id)
  }
}

/** A committed capture never overwrites either a new record or an existing capture. */
export function applyExternalCapture(engine, value, write, checkpoint = () => {}) {
  validate(value)
  if (value.action !== 'capture') throw new MemoryError('INVALID_EXTERNAL_DESCRIPTOR')
  const current = engine.resolvePath(value.source_change_id ? `quarantine/${value.record_id}/${value.source_change_id}/source` : `records/${value.record_id}`)
  const saved = engine.resolvePath(`quarantine/${value.record_id}/${value.change_id}/source`)
  const marker = engine.resolvePath(`external-changes/${value.record_id}/${value.change_id}/capture.json`)
  const old = identity(saved), present = identity(current)
  let status
  if (same(old, value.source_identity)) status = present ? 'source_recreated' : 'captured'
  else if (old) status = 'capture_target_conflict'
  else if (!present) status = 'source_missing'
  else if (!same(present, value.source_identity)) status = 'source_identity_changed'
  else {
    mkdirSync(dirname(saved), { recursive: true, mode: 0o700 })
    checkpoint('before_external_detach', { record_id: value.record_id })
    renameSync(current, saved)
    checkpoint('after_external_detach', { record_id: value.record_id })
    status = same(identity(saved), value.source_identity) ? 'captured' : 'source_identity_changed'
  }
  write(marker, json({ schema_version: 1, status, record_id: value.record_id, change_id: value.change_id }))
  return status
}

/** Exclusive creation plus the root clean-head barrier is the publish commit. */
export function applyExternalPublish(engine, value, write, checkpoint = () => {}) {
  validate(value)
  if (value.action !== 'publish') throw new MemoryError('INVALID_EXTERNAL_DESCRIPTOR')
  const stage = engine.resolvePath(`external-changes/${value.record_id}/${value.change_id}/staged/${value.publication_id}`)
  const current = engine.resolvePath(`records/${value.record_id}`)
  const marker = engine.resolvePath(`external-changes/${value.record_id}/${value.change_id}/publication-${value.publication_id}.json`)
  const ownership = () => {
    try {
      const saved = JSON.parse(readFileSync(marker, 'utf8'))
      return saved.publication_id === value.publication_id && same(identity(current), saved)
    } catch { return false }
  }
  const isOurPublication = () => {
    try {
      if (identity(current)?.symlink || !identity(current)?.directory) return false
      if (!ownership()) return false
      const hashes = Object.fromEntries(RECORD_FILES.map((name) => [name, digest(readFileSync(engine.resolvePath(`records/${value.record_id}/${name}`)))]))
      return digest(hashes) === value.bundle_hash
    } catch { return false }
  }
  if (existsSync(current) && isOurPublication()) return 'published'
  if (!identity(stage)?.directory || identity(stage)?.symlink) return 'publication_stage_missing'
  let ours = false
  if (existsSync(current)) {
    ours = ownership()
    if (!ours) return 'publication_conflict'
  } else {
    try { mkdirSync(current, { mode: 0o700 }) } catch (error) { if (error.code === 'EEXIST') return 'publication_conflict'; throw error }
    const own = identity(current)
    write(marker, json({ publication_id: value.publication_id, dev: own.dev, ino: own.ino }))
  }
  checkpoint('before_external_publish', { record_id: value.record_id })
  const copy = (from, to) => {
    for (const entry of readdirSync(from, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink() || !entry.isFile() && !entry.isDirectory()) throw new MemoryError('UNSAFE_STORAGE_PATH')
      const source = join(from, entry.name), target = join(to, entry.name)
      if (entry.isDirectory()) {
        if (!existsSync(target)) mkdirSync(target, { mode: 0o700 })
        else if (!lstatSync(target).isDirectory() || lstatSync(target).isSymbolicLink()) throw new MemoryError('EXTERNAL_PUBLICATION_CONFLICT')
        copy(source, target)
      } else {
        if (existsSync(target)) {
          if (!lstatSync(target).isFile() || lstatSync(target).isSymbolicLink() || digest(readFileSync(source)) !== digest(readFileSync(target))) throw new MemoryError('EXTERNAL_PUBLICATION_CONFLICT')
        } else copyFileSync(source, target, constants.COPYFILE_EXCL)
      }
    }
  }
  try { copy(stage, current) } catch (error) { if (error.code === 'EXTERNAL_PUBLICATION_CONFLICT' || ['EEXIST', 'ENOTDIR', 'ENOENT'].includes(error.code)) return 'publication_conflict'; throw error }
  checkpoint('after_external_publish', { record_id: value.record_id })
  return isOurPublication() ? 'published' : 'publication_conflict'
}

export function applyRootUpgrade(root, upgrade, write) {
  assertOnly(upgrade, ['expected_hash', 'manifest'])
  if (!/^[a-f0-9]{64}$/.test(upgrade.expected_hash) || upgrade.manifest?.api_version !== '1.1.0') throw new MemoryError('INVALID_ROOT_UPGRADE')
  const path = join(resolve(root), 'manifest.json')
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new MemoryError('UNSAFE_STORAGE_PATH')
  const data = readFileSync(path), previous = JSON.parse(data)
  if (stableStringify(previous) === stableStringify(upgrade.manifest)) return
  if (digest(data) !== upgrade.expected_hash || previous.api_version !== '1.0.0') throw new MemoryError('ROOT_UPGRADE_CONFLICT')
  write(path, json(upgrade.manifest))
}
