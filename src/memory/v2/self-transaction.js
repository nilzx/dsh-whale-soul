import { MemoryError, assertId, assertOnly, digest } from './contracts.js'
import { validateImportedSelfDescriptor } from './self-transfer.js'
import { buildSelfDescriptor, listSelfHeads, loadSelfHead, pruneSelfFiles, readSelfFiles, selfAnchor, selfFileReferences, verifySelfFiles } from './self-integrity.js'

const fail = (code) => { throw new MemoryError(code) }
const bytes = (data) => Buffer.isBuffer(data) ? data : Buffer.from(data)
function growthPath(path) { return /^self\/([^/]+)\/(manifest\.json|(?:traits|proposals)\/[^/]+\.json|history\/[^/]+\/[1-9][0-9]*\.json)$/.exec(path) }

/** Complete bundles are derived inside the real root lock, before PREPARE. */
export function prepareSelfTransaction(root, spaceId, built, operationId, purgeState) {
  const anchors = (built.persona_descriptors ?? (built.persona_descriptor ? [built.persona_descriptor] : [])).map((item) => item.anchor)
  const removed = new Set([...(purgeState.evidence_ids ?? []),...(purgeState.related_evidence_ids ?? []),...(built.purge_descriptor?.evidence_ids ?? []),...(built.purge_descriptor?.related_evidence_ids ?? []),...anchors.flatMap((anchor) => anchor.revoked_ids)])
  const touched = new Set(anchors.map((anchor) => anchor.agent_identity_id))
  for (const change of built.changes) { const match = growthPath(change.path); if (match) touched.add(assertId(match[1])) }
  for (const head of listSelfHeads(root,spaceId)) if (head.files.some((file) => [...file.evidence_refs,...file.maintenance_refs].some((id) => removed.has(id)))) touched.add(head.agent_identity_id)
  let restore = null
  if (built.self_restoration) {
    restore = built.self_restoration; assertOnly(restore,['agent_identity_id','expected_generation','files_hash']); assertId(restore.agent_identity_id)
    touched.add(restore.agent_identity_id)
  }
  const imports = built.self_imports ?? []
  imports.forEach(validateImportedSelfDescriptor)
  const changes = [...built.changes], descriptors = [], sources = []
  for (const agentId of touched) {
    const old = loadSelfHead(root,spaceId,agentId)
    let anchor
    try { anchor = selfAnchor(root,spaceId,agentId,anchors) } catch (error) {
      // A neutral managed extension may retain an unbound opaque namespace.
      // It grants no self authority and cannot later be adopted as a baseline.
      if (error.code === 'PERSONA_ANCHOR_REQUIRED' && !old && restore?.agent_identity_id !== agentId) continue
      throw error
    }
    const initializing = !old && anchors.some((entry) => entry.agent_identity_id === agentId) && !(built.persona_descriptors ?? (built.persona_descriptor ? [built.persona_descriptor] : [])).find((entry) => entry.anchor.agent_identity_id === agentId)?.expected_revision
    let original = readSelfFiles(root,spaceId,agentId)
    const sourceHash = digest([...original].map(([path,data]) => [path,digest(data)])), headHash = digest(old)
    sources.push(() => {
      if (digest(loadSelfHead(root,spaceId,agentId)) !== headHash || digest([...readSelfFiles(root,spaceId,agentId)].map(([path,data]) => [path,digest(data)])) !== sourceHash) fail('SELF_SOURCE_CHANGED')
    })
    if (restore?.agent_identity_id === agentId) {
      if (!old || old.generation !== restore.expected_generation || old.files_hash !== restore.files_hash) fail('SELF_RESTORE_CONFLICT')
      original = new Map()
    } else if (old) {
      const currentAnchor = selfAnchor(root,spaceId,agentId)
      const verified = new Map(original)
      for (const [path,data] of verified) {
        if (old.files.some(file=>file.path===path)) continue
        if (changes.some(change=>change.path===`self/${agentId}/${path}`&&change.data===null) && removed.size && selfFileReferences(data,[...removed])) verified.delete(path)
      }
      verifySelfFiles(old,verified,currentAnchor)
      original = verified
    } else if (!initializing || original.size) fail('SELF_INTEGRITY_UPGRADE_REQUIRED')
    let next = new Map(original)
    for (const change of changes) {
      const match = growthPath(change.path)
      if (match?.[1] === agentId) { if (change.data === null) next.delete(match[2]); else next.set(match[2],bytes(change.data)) }
      else if (change.data === null && [`self/${agentId}`,`self/${agentId}/traits`,`self/${agentId}/proposals`,`self/${agentId}/history`].includes(change.path)) {
        const prefix = change.path.slice(`self/${agentId}`.length).replace(/^\//,'')
        for (const path of next.keys()) if (!prefix || path.startsWith(`${prefix}/`)) next.delete(path)
      }
    }
    if (restore?.agent_identity_id === agentId) verifySelfFiles(old,next,anchor)
    next = pruneSelfFiles(next,[...removed])
    const imported = imports.find(item => item.next.agent_identity_id === agentId)
    if (imported) {
      if (old || original.size) fail('SELF_IMPORT_CONFLICT')
      verifySelfFiles(imported.next, next, anchor)
      continue
    }
    const descriptor = buildSelfDescriptor({root,spaceId,anchor,files:next,operationId,previous:old,initialize:initializing})
    if (!old || old.files_hash !== descriptor.next.files_hash || old.core_version !== anchor.core_version || restore?.agent_identity_id === agentId) descriptors.push(descriptor)
    // The prune is part of this same durable write set, never a new baseline
    // formed from a self-authored manifest during a later read.
    for (const path of new Set([...original.keys(),...next.keys()])) {
      const data = next.get(path)
      if (data && original.has(path) && digest(original.get(path)) === digest(data)) continue
      const relative = `self/${agentId}/${path}`, index = changes.findIndex((change) => change.path === relative)
      const change = {path:relative,data:data ?? null}
      if (index < 0) changes.push(change); else changes[index] = change
    }
  }
  return {changes,self_descriptors:descriptors,authorizeSelf:() => sources.forEach((check) => check())}
}
