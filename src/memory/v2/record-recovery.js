import { closeSync, constants, fsyncSync, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { digest } from './contracts.js'
import { loadRecordHead, verifyRecordBundle } from './record-integrity.js'
import { getPurgeState } from './purge-ledger.js'

const FILES = ['meta.json', 'gist.md', 'detail.md', 'evidence.jsonl', 'integrity.json']
const PATH = /^records\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})(?:\/revisions\/([A-Za-z0-9][A-Za-z0-9._-]{0,127}))?\/(meta\.json|gist\.md|detail\.md|evidence\.jsonl|integrity\.json)$/
const MAX_FILE_BYTES = 64 * 1024 * 1024

function existing(path, expected) {
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES) return { different: true }
    const data = readFileSync(fd)
    return digest(data) === expected ? { data } : { different: true }
  } catch (error) { if (error.code === 'ENOENT') return { missing: true }; return { different: true } }
  finally { if (fd !== undefined) closeSync(fd) }
}

function exclusiveWrite(engine, relativePath, data, expected) {
  const path = engine.resolvePath(relativePath)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  let fd
  try {
    fd = openSync(engine.resolvePath(relativePath), 'wx', 0o600)
    writeFileSync(fd, data); fsyncSync(fd); closeSync(fd); fd = undefined
    let directory
    try { directory = openSync(dirname(path), 'r'); fsyncSync(directory) } catch (error) { if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EBADF'].includes(error.code)) throw error }
    finally { if (directory !== undefined) closeSync(directory) }
    return 'written'
  } catch (error) {
    if (error.code === 'EEXIST') return existing(path, expected).data ? 'same' : 'conflict'
    throw error
  } finally { if (fd !== undefined) closeSync(fd) }
}

/**
 * A receipt proves past completion, not present bytes. Replayed completed redo
 * may fill only missing, root-anchored record bundles. It never replays a
 * descriptor, a derived index, a manifest, self data, or an existing byte.
 */
export function repairCompletedRecordChanges(engine, transaction) {
  const state = getPurgeState(engine.lockRoot, engine.memorySpaceId), groups = new Map()
  for (const change of transaction.changes) {
    if (change.data === null || typeof change.path !== 'string') continue
    const match = PATH.exec(change.path)
    if (!match || state.record_ids.includes(match[1])) continue
    const key = `${match[1]}/${match[2] ?? ''}`, group = groups.get(key) ?? { id: match[1], revisionId: match[2] ?? null, files: new Map(), invalid: false }
    if (group.files.has(match[3]) || typeof change.data !== 'string' || change.data.length > Math.ceil(MAX_FILE_BYTES / 3) * 4) group.invalid = true
    else {
      const data = Buffer.from(change.data, 'base64')
      if (data.length > MAX_FILE_BYTES || data.toString('base64') !== change.data) group.invalid = true
      else group.files.set(match[3], data)
    }
    groups.set(key, group)
  }
  const result = { repaired_files: 0, conflicts: 0, skipped_bundles: 0 }
  for (const group of groups.values()) {
    let head
    try { head = loadRecordHead(engine.lockRoot, engine.memorySpaceId, group.id) } catch { result.skipped_bundles++; continue }
    if (!head || head.state !== 'clean' || head.bundle_location !== undefined && head.bundle_location !== 'records' || group.invalid) { result.skipped_bundles++; continue }
    const revisionId = group.revisionId ?? head.head_revision_id, revision = head.revisions.find((item) => item.revision_id === revisionId)
    if (!revision) { result.skipped_bundles++; continue }
    const prefix = `records/${group.id}${group.revisionId ? `/revisions/${group.revisionId}` : ''}`
    const bundle = {}, missing = []
    let valid = true
    for (const file of FILES) {
      let present
      try { present = existing(engine.resolvePath(`${prefix}/${file}`), revision.files[file]) } catch { valid = false; break }
      if (present.different) { valid = false; break }
      if (present.missing) {
        const candidate = group.files.get(file)
        if (!candidate || digest(candidate) !== revision.files[file]) { valid = false; break }
        bundle[file] = candidate; missing.push(file)
      } else bundle[file] = present.data
    }
    if (!valid) { result.skipped_bundles++; continue }
    try { verifyRecordBundle(head, bundle, revisionId) } catch { result.skipped_bundles++; continue }
    for (const file of missing) {
      engine._checkpoint('before_completed_record_repair', { record_id: group.id, revision_id: revisionId, file })
      const status = exclusiveWrite(engine, `${prefix}/${file}`, bundle[file], revision.files[file])
      if (status === 'conflict') { result.conflicts++; break }
      if (status === 'written') {
        result.repaired_files++
        engine._checkpoint('after_completed_record_repair', { record_id: group.id, revision_id: revisionId, file })
      }
    }
  }
  return result
}
