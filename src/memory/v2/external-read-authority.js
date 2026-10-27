import { MemoryError, assertOnly, digest, stableStringify } from './contracts.js'
import { loadRecordHead } from './record-integrity.js'
import { getPurgeState } from './purge-ledger.js'
import { recordRetentionAllowed } from './read-policy.js'
import { retrieveMemory } from './retrieval.js'

const same = (a, b) => digest(a) === digest(b)
const active = (meta) => meta.status === 'active' && (!meta.valid_from || Date.parse(meta.valid_from) <= Date.now()) &&
  (!meta.valid_to || Date.now() < Date.parse(meta.valid_to)) && (!meta.expires_at || Date.now() < Date.parse(meta.expires_at))
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Root-anchored quotation proof. It never grants interaction/growth authority. */
function quotationProof(store, record, head, seen = new Set()) {
  const meta = record.meta, external = meta.external_revision
  if (seen.size >= 16 || seen.has(meta.revision_id) || meta.claim_kind !== 'quotation' || external?.protected !== true ||
    !recordRetentionAllowed(record) || !/^change-[a-f0-9]{40}$/.test(external.change_id ?? '')) return null
  seen.add(meta.revision_id)
  const revision = head.revisions.find((item) => item.revision_id === meta.revision_id)
  if (!revision) return null
  if (external.source === 'owner_restore') {
    if (!head.revisions.some((item) => item.revision_id === external.restored_from)) return null
    const earlier = store._readRecord(meta.record_id, external.restored_from)
    if (!same(record.evidence, earlier.evidence) || !same(meta.provenance_refs, earlier.meta.provenance_refs) ||
      ['gist', 'detail'].some((field) => record[field] !== earlier[field]) ||
      ['title', 'tags'].some((field) => !same(meta[field], earlier.meta[field]))) return null
    return quotationProof(store, earlier, head, seen)
  }
  if (external.source !== 'owner_external_edit' || external.growth_eligible !== false || external.maturity_eligible !== false ||
    external.base_revision_id !== revision.parent_revision_id || !/^[a-f0-9]{64}$/.test(external.observed_hash ?? '') ||
    record.evidence.length !== 1 || meta.provenance_refs.length !== 1) return null
  const evidence = record.evidence[0]
  if (evidence.claim_kind !== 'quotation' || evidence.evidence_id !== meta.provenance_refs[0] ||
    evidence.subject_ids.length !== 1 || evidence.subject_ids[0] !== meta.subject_id || evidence.message_id !== external.change_id ||
    digest(evidence.content) !== external.patch_hash) return null
  let patch
  try { patch = JSON.parse(evidence.content) } catch { return null }
  if (!plain(patch) || Object.keys(patch).length < 1 || Object.keys(patch).length > 4 || stableStringify(patch) !== evidence.content ||
    Object.keys(patch).some((key) => !['title', 'tags', 'gist', 'detail'].includes(key)) ||
    Object.entries(patch).some(([key, value]) => !same(value, ['gist', 'detail'].includes(key) ? record[key] : meta[key])) ||
    evidence.evidence_id !== `external-${digest({ change: external.change_id, operationId: revision.operation_id, patch }).slice(0, 40)}`) return null
  return { evidence_id: evidence.evidence_id, origin_revision_id: meta.revision_id }
}

/**
 * Trusted file-provider extension. Discovery uses a neutral authorized view
 * before the persona's unknown-evidence filter; no model IDs or manage fallback.
 */
export function createExternalReadAuthority({ store, maxRecords = 10 } = {}) {
  if (typeof store?._authorize !== 'function' || typeof store?._readRecord !== 'function' || typeof store?._visible !== 'function' ||
    typeof store?.engine?.read !== 'function') throw new MemoryError('EXTERNAL_READ_STORAGE_REQUIRED')
  if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 10) throw new MemoryError('INVALID_EXTERNAL_READ_BUDGET')
  return Object.freeze({
    async prepare(args = {}, context, { signal, authorize = () => true } = {}) {
      assertOnly(args, ['query', 'at', 'subject_id', 'limit'])
      if (signal !== undefined && !(signal instanceof AbortSignal)) throw new MemoryError('INVALID_SIGNAL')
      if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 10)) throw new MemoryError('INVALID_LIMIT')
      if (typeof authorize !== 'function') throw new MemoryError('TRUSTED_AUTHORIZER_REQUIRED')
      const check = () => {
        store._authorize(context, 'memory.read')
        const decision = authorize()
        if (decision && typeof decision.then === 'function') { Promise.resolve(decision).catch(() => {}); throw new MemoryError('ASYNC_AUTHORIZER_UNSUPPORTED') }
        if (signal?.aborted || decision !== true) throw new MemoryError('EXTERNAL_READ_REVOKED')
      }
      check()
      const rows = new Map(), purgeGeneration = getPurgeState(store.root, store.memorySpaceId).generation
      // Historical quotations are deliberately not promoted by a current lease.
      if (args.at === undefined) {
        const view = await retrieveMemory(store, { ...args, limit: Math.min(args.limit ?? maxRecords, maxRecords), depth: 'gist', ...(signal ? { signal } : {}) }, context,
          { recordAllowed: recordRetentionAllowed })
        if (view.status !== 'ok' || view.isCurrent?.() !== true) throw new MemoryError('EXTERNAL_READ_UNAVAILABLE')
        await store.engine.read(() => {
          check()
          for (const item of view.items) {
            try {
              const head = loadRecordHead(store.root, store.memorySpaceId, item.meta.record_id)
              if (!head || head.state !== 'clean' || head.head_revision_id !== item.meta.revision_id) continue
              const record = store._readRecord(item.meta.record_id)
              if (!same(record.meta, item.meta) || !active(record.meta) || !store._visible(record.meta, context) ||
                record.meta.visibility?.kind === 'private' && record.meta.persona_id !== context.persona_id) continue
              const proof = quotationProof(store, record, head)
              if (proof) rows.set(record.meta.record_id, { headHash: digest(head), metaHash: digest(record.meta), proof })
            } catch { /* One malformed record cannot authorize itself or hide a valid neighbour. */ }
          }
          check()
        })
      }
      check()
      const fresh = (id) => {
        try {
          check()
          if (getPurgeState(store.root, store.memorySpaceId).generation !== purgeGeneration) return false
          const binding = rows.get(id), head = loadRecordHead(store.root, store.memorySpaceId, id)
          if (!binding || !head || head.state !== 'clean' || digest(head) !== binding.headHash) return false
          const record = store._readRecord(id)
          if (digest(record.meta) !== binding.metaHash || !active(record.meta) || !store._visible(record.meta, context) ||
            record.meta.visibility?.kind === 'private' && record.meta.persona_id !== context.persona_id) return false
          const proof = quotationProof(store, record, head)
          check()
          return Boolean(proof && same(proof, binding.proof))
        } catch { return false }
      }
      const recordIds = Object.freeze([...rows.keys()])
      return Object.freeze({
        generation: digest({ purgeGeneration, bindings: [...rows] }), recordIds,
        growth_eligible: false, maturity_eligible: false,
        isCurrent: () => { try { check(); return getPurgeState(store.root, store.memorySpaceId).generation === purgeGeneration && recordIds.every(fresh) } catch { return false } },
        evidenceAllowed(id, suppliedContext, meta) {
          const row = rows.get(meta?.record_id)
          return suppliedContext === context && Boolean(row && row.proof.evidence_id === id &&
            digest(meta) === row.metaHash && fresh(meta.record_id))
        },
        recordAllowed(record, suppliedContext) {
          const row = rows.get(record?.meta?.record_id)
          return suppliedContext === context && Boolean(row && digest(record.meta) === row.metaHash &&
            recordRetentionAllowed(record) && fresh(record.meta.record_id))
        },
      })
    },
  })
}
