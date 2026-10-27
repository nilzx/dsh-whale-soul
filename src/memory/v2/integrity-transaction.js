import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MemoryError, assertId } from './contracts.js'
import { buildRecordDescriptor, buildRecordStateDescriptor, loadRecordHead } from './record-integrity.js'

export const RECORD_FILES = Object.freeze(['meta.json', 'gist.md', 'detail.md', 'evidence.jsonl', 'integrity.json'])

/** Derive durable anchors only from a complete host-authorized write bundle. */
export function descriptorsForChanges(root, spaceId, changes, operationId, explicit = [], purgeDescriptor = null) {
  const result = [...explicit]
  const covered = new Set(explicit.map((item) => item.next.record_id))
  const current = new Map(), history = new Map(), locations = new Map()
  for (const change of changes) {
    if (change.data === null) continue
    let match = /^(cold\/)?records\/([^/]+)\/(meta\.json|gist\.md|detail\.md|evidence\.jsonl|integrity\.json)$/.exec(change.path)
    if (match) {
      const id = assertId(match[2]), location = match[1] ? 'cold' : 'records'
      if (locations.has(id) && locations.get(id) !== location) throw new MemoryError('AMBIGUOUS_RECORD_LOCATION')
      locations.set(id, location)
      const files = current.get(id) ?? {}; files[match[3]] = change.data; current.set(id, files)
      continue
    }
    match = /^(cold\/)?records\/([^/]+)\/revisions\/([^/]+)\/(meta\.json|gist\.md|detail\.md|evidence\.jsonl|integrity\.json)$/.exec(change.path)
    if (match) {
      const id = assertId(match[2]), revision = assertId(match[3]), location = match[1] ? 'cold' : 'records'
      if (locations.has(id) && locations.get(id) !== location) throw new MemoryError('AMBIGUOUS_RECORD_LOCATION')
      locations.set(id, location)
      const byRecord = history.get(id) ?? new Map()
      const files = byRecord.get(revision) ?? {}; files[match[4]] = change.data; byRecord.set(revision, files); history.set(id, byRecord)
    }
  }
  for (const [id, files] of current) {
    if (covered.has(id)) continue
    if (RECORD_FILES.some((name) => files[name] === undefined)) throw new MemoryError('COMPLETE_RECORD_BUNDLE_REQUIRED')
    let meta
    try { meta = JSON.parse(String(files['meta.json'])) } catch { throw new MemoryError('RECORD_BUNDLE_INVALID') }
    let head = loadRecordHead(root, spaceId, id)
    if (!head && meta.revision > 1) {
      const bundles = [...(history.get(id)?.values() ?? [])].map((entry) => {
        if (RECORD_FILES.some((name) => entry[name] === undefined)) throw new MemoryError('INTEGRITY_HISTORY_REQUIRED')
        try { return { files: entry, meta: JSON.parse(String(entry['meta.json'])) } } catch { throw new MemoryError('RECORD_BUNDLE_INVALID') }
      }).sort((a, b) => a.meta.revision - b.meta.revision)
      for (const bundle of bundles.filter((item) => item.meta.revision < meta.revision)) {
        const descriptor = buildRecordDescriptor({ root, spaceId, meta: bundle.meta, files: bundle.files, operationId, mode: 'baseline', previousHead: head })
        result.push(descriptor); head = descriptor.next
      }
      if (!head || head.head_revision !== meta.revision - 1) throw new MemoryError('INTEGRITY_HISTORY_REQUIRED')
    }
    const mode = head?.head_revision_id === meta.revision_id ? 'repair' : 'append'
    result.push(buildRecordDescriptor({ root, spaceId, meta, files, operationId, mode, previousHead: head, ...(locations.get(id) === 'cold' || head?.schema_version === 2 ? { bundleLocation: locations.get(id) } : {}) }))
  }
  for (const id of purgeDescriptor?.record_ids ?? []) {
    if (covered.has(id)) continue
    const head = loadRecordHead(root, spaceId, id)
    if (head && head.state !== 'purged') result.push(buildRecordStateDescriptor({ root, spaceId, recordId: id, state: 'purged', changeId: null, operationId }))
  }
  return result
}

export function readBundleAt(store, relativeBase) {
  return Object.fromEntries(RECORD_FILES.map((name) => [name, readFileSync(store.engine.resolvePath(`${relativeBase}/${name}`))]))
}
