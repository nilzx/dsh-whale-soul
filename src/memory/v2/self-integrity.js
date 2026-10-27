import { constants, closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from 'node:fs'
import { join, parse, relative, resolve, sep } from 'node:path'
import { MemoryError, assertId, assertOnly, digest, timestamp } from './contracts.js'
import { getPersonaAnchor, loadPersonaLedger, validatePersonaAnchor } from './persona-ledger.js'

const HASH = /^[a-f0-9]{64}$/, LIMIT = 16 * 1024 * 1024
const SCOPE = ['memory_space_id', 'binding_id', 'persona_id', 'agent_identity_id', 'subject_id', 'core_version']
const HEAD_FIELDS = ['schema_version', ...SCOPE, 'generation', 'parent_hash', 'operation_id', 'files', 'files_hash']
const json = (v) => `${JSON.stringify(v, null, 2)}\n`
const fail = (code) => { throw new MemoryError(code) }
const clone = (v) => JSON.parse(JSON.stringify(v))
const ids = (value, maximum = 64) => {
  if (!Array.isArray(value) || value.length > maximum || new Set(value).size !== value.length) fail('INVALID_SELF_STRUCTURE')
  value.forEach((id) => assertId(id)); return value
}
function object(value) { return value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype }
function safe(root, target, file = false) {
  const base = resolve(root), path = resolve(target), rel = relative(base, path)
  if (rel === '..' || rel.startsWith(`..${sep}`)) fail('UNSAFE_STORAGE_PATH')
  let current = parse(path).root
  for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part)
    let stat
    try { stat = lstatSync(current) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    if (stat.isSymbolicLink() || current !== path && !stat.isDirectory() || current === path && file && !stat.isFile()) fail('UNSAFE_STORAGE_PATH')
  }
  return path
}
function readBytes(path) {
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const before = fstatSync(fd)
    if (!before.isFile() || before.nlink !== 1 || before.size > LIMIT) fail('UNSAFE_SELF_FILE')
    const bytes = readFileSync(fd), after = fstatSync(fd)
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) fail('SELF_SOURCE_UNSTABLE')
    return bytes
  } finally { if (fd !== undefined) closeSync(fd) }
}
function parseJson(bytes) { try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { fail('INVALID_SELF_STRUCTURE') } }
function bounded(value, maximum) { if (typeof value !== 'string' || !value.trim() || !value.isWellFormed() || value.length > maximum) fail('INVALID_SELF_STRUCTURE') }
function integer(value, minimum = 0) { if (!Number.isSafeInteger(value) || value < minimum) fail('INVALID_SELF_STRUCTURE') }
function scopeOf(anchor) { return Object.fromEntries(SCOPE.map((key) => [key, anchor[key]])) }
function headPath(root, spaceId, agentId) { assertId(spaceId); assertId(agentId); return safe(root, join(root, '.administration/self-heads', spaceId, `${agentId}.json`), true) }
export function selfAnchor(root, spaceId, agentId, future = []) {
  const candidate = future.find((item) => item.agent_identity_id === agentId && item.memory_space_id === spaceId)
  if (candidate) return validatePersonaAnchor(candidate)
  const space = loadPersonaLedger(root).spaces[spaceId] ?? {}
  const matches = Object.values(space).filter((item) => item.agent_identity_id === agentId)
  if (matches.length !== 1) fail('PERSONA_ANCHOR_REQUIRED')
  return validatePersonaAnchor(matches[0])
}
function validPath(path) {
  return path === 'manifest.json' || /^(?:traits|proposals)\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/.test(path) || /^history\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[1-9][0-9]*\.json$/.test(path)
}
export function validateSelfHead(head) {
  assertOnly(head, HEAD_FIELDS)
  if (!object(head) || head.schema_version !== 1 || SCOPE.some((key) => !Object.hasOwn(head, key))) fail('INVALID_SELF_HEAD')
  for (const key of SCOPE.filter((key) => key !== 'core_version')) assertId(head[key])
  if (typeof head.core_version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(head.core_version)) fail('INVALID_SELF_HEAD')
  integer(head.generation, 1); assertId(head.operation_id)
  if (head.parent_hash !== null && !HASH.test(head.parent_hash) || !Array.isArray(head.files) || head.files.length > 4096) fail('INVALID_SELF_HEAD')
  const seen = new Set()
  for (const file of head.files) {
    assertOnly(file, ['path', 'sha256', 'bytes', 'evidence_refs', 'maintenance_refs'])
    if (!validPath(file.path) || seen.has(file.path) || !HASH.test(file.sha256)) fail('INVALID_SELF_HEAD')
    seen.add(file.path); integer(file.bytes); if (file.bytes > LIMIT) fail('INVALID_SELF_HEAD')
    ids(file.evidence_refs, 128); ids(file.maintenance_refs, 128)
  }
  if (head.files_hash !== digest(head.files) || Buffer.byteLength(JSON.stringify(head)) > LIMIT) fail('INVALID_SELF_HEAD')
  return head
}
export function loadSelfHead(root, spaceId, agentId) {
  const path = headPath(root, spaceId, agentId)
  if (!existsSync(path)) return null
  const head = validateSelfHead(parseJson(readBytes(path)))
  if (head.memory_space_id !== spaceId || head.agent_identity_id !== agentId) fail('SELF_SCOPE_CONFLICT')
  return head
}
export function listSelfHeads(root, spaceId) {
  assertId(spaceId)
  const folder = safe(root, join(root, '.administration/self-heads', spaceId))
  if (!existsSync(folder)) return []
  return readdirSync(folder, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)).map((entry) => {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json')) fail('UNSAFE_STORAGE_PATH')
    return loadSelfHead(root, spaceId, assertId(entry.name.slice(0,-5)))
  })
}
export function readSelfFiles(root, spaceId, agentId) {
  const base = safe(root, join(root, 'spaces', assertId(spaceId), 'self', assertId(agentId))), files = new Map()
  if (!existsSync(base)) return files
  let total = 0
  const add = (path) => { const absolute = safe(root, join(base, path), true), bytes = readBytes(absolute); total += bytes.length; if (total > LIMIT || files.size >= 4096) fail('SELF_BUNDLE_TOO_LARGE'); files.set(path, bytes) }
  if (existsSync(join(base, 'manifest.json'))) add('manifest.json')
  for (const kind of ['traits','proposals','history']) {
    const folder = safe(root, join(base, kind))
    if (!existsSync(folder)) continue
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) fail('UNSAFE_STORAGE_PATH')
      if (kind !== 'history') { const path = `${kind}/${entry.name}`; if (!entry.isFile() || !validPath(path)) fail('INVALID_SELF_STRUCTURE'); add(path) }
      else {
        if (!entry.isDirectory()) fail('INVALID_SELF_STRUCTURE'); assertId(entry.name)
        for (const revision of readdirSync(safe(root, join(folder, entry.name)), { withFileTypes: true })) { const path = `history/${entry.name}/${revision.name}`; if (!revision.isFile() || revision.isSymbolicLink() || !validPath(path)) fail('INVALID_SELF_STRUCTURE'); add(path) }
      }
    }
  }
  return new Map([...files].sort(([a],[b]) => a.localeCompare(b)))
}
function validateEntity(value, kind, path, anchor) {
  const common = ['schema_version','trait_id','persona_id','agent_identity_id','core_version','dimension','scope','value','state','revision','evidence_refs','counterevidence_refs','assessment','updated_at']
  const proposal = kind === 'proposals' || kind === 'history' && object(value) && Object.hasOwn(value, 'expected_trait_revision')
  assertOnly(value, proposal ? [...common,'proposal_id','expected_trait_revision','created_at','maintenance_refs'] : [...common,'formed_at','supersedes_revision','proposal_id','review_maintenance_refs','unresolved_counterevidence'])
  if (!object(value) || value.schema_version !== 1 || value.persona_id !== anchor.persona_id || value.agent_identity_id !== anchor.agent_identity_id || !['candidate','stable','disputed','retired'].includes(value.state)) fail('INVALID_SELF_STRUCTURE')
  for (const key of ['trait_id','dimension','proposal_id']) assertId(value[key])
  if (value.trait_id !== `trait-${digest({ persona_id: value.persona_id, agent_identity_id: value.agent_identity_id, dimension: value.dimension, scope: value.scope }).slice(0,40)}`) fail('SELF_ENTITY_ID_CONFLICT')
  bounded(value.core_version, 128); bounded(value.scope, 100); bounded(value.value, 240); if (/[\r\n\u0000-\u001f]/.test(value.value)) fail('INVALID_SELF_STRUCTURE')
  integer(value.revision,1); ids(value.evidence_refs); ids(value.counterevidence_refs)
  if (value.evidence_refs.some((id) => value.counterevidence_refs.includes(id))) fail('INVALID_SELF_STRUCTURE')
  assertOnly(value.assessment,['persistable','compatible','supported','confidence','counterevidence_resolved'])
  if (['persistable','compatible','supported','counterevidence_resolved'].some((key) => typeof value.assessment?.[key] !== 'boolean') || !Number.isFinite(value.assessment.confidence) || value.assessment.confidence < 0 || value.assessment.confidence > 1) fail('INVALID_SELF_STRUCTURE')
  timestamp(value.updated_at,'self updated_at',false)
  if (proposal) {
    integer(value.expected_trait_revision); timestamp(value.created_at,'self created_at',false); ids(value.maintenance_refs)
    if (kind === 'proposals' && path !== `proposals/${value.proposal_id}.json` || kind === 'history' && path !== `history/${value.proposal_id}/${value.revision}.json`) fail('SELF_ENTITY_ID_CONFLICT')
  }
  else {
    timestamp(value.formed_at,'self formed_at',false); if (value.supersedes_revision !== null) integer(value.supersedes_revision,1)
    if (value.review_maintenance_refs !== undefined) ids(value.review_maintenance_refs)
    if (value.unresolved_counterevidence !== undefined && typeof value.unresolved_counterevidence !== 'boolean') fail('INVALID_SELF_STRUCTURE')
    if (kind === 'traits' && path !== `traits/${value.trait_id}.json` || kind === 'history' && path !== `history/${value.trait_id}/${value.revision}.json`) fail('SELF_ENTITY_ID_CONFLICT')
  }
  return value
}
export function validateSelfFiles(files, anchor) {
  validatePersonaAnchor(anchor)
  if (!(files instanceof Map) || files.size > 4096) fail('INVALID_SELF_STRUCTURE')
  if (!files.size) return []
  const manifestBytes = files.get('manifest.json'); if (!manifestBytes) fail('SELF_MANIFEST_REQUIRED')
  const manifest = parseJson(manifestBytes)
  assertOnly(manifest,['schema_version','persona_id','agent_identity_id','revision','traits','proposals','maintenance'])
  if (manifest.schema_version !== 1 || manifest.persona_id !== anchor.persona_id || manifest.agent_identity_id !== anchor.agent_identity_id || !object(manifest.traits) || !object(manifest.proposals) || !object(manifest.maintenance)) fail('INVALID_SELF_STRUCTURE')
  integer(manifest.revision)
  for (const kind of ['traits','proposals']) for (const [id, hash] of Object.entries(manifest[kind])) {
    assertId(id); if (!HASH.test(hash)) fail('INVALID_SELF_STRUCTURE')
    const bytes = files.get(`${kind}/${id}.json`); if (!bytes || digest(parseJson(bytes)) !== hash) fail('SELF_MANIFEST_CONFLICT')
  }
  const entries = []
  for (const [path, data] of files) {
    if (!validPath(path) || !(Buffer.isBuffer(data) || typeof data === 'string')) fail('INVALID_SELF_STRUCTURE')
    const value = parseJson(data), kind = path.split('/')[0]
    if (path !== 'manifest.json') {
      validateEntity(value,kind,path,anchor)
      if (['traits','proposals'].includes(kind) && !Object.hasOwn(manifest[kind],path.split('/')[1].slice(0,-5))) fail('SELF_UNREFERENCED_FILE')
    }
    entries.push({ path, sha256: digest(data), bytes: Buffer.byteLength(data), evidence_refs: [...new Set([...(value.evidence_refs ?? []),...(value.counterevidence_refs ?? [])])].sort(), maintenance_refs: [...new Set([...(value.maintenance_refs ?? []),...(value.review_maintenance_refs ?? []),...(path === 'manifest.json' ? Object.keys(value.maintenance) : [])])].sort() })
  }
  for (const [id, attempts] of Object.entries(manifest.maintenance)) {
    assertId(id); if (!Array.isArray(attempts) || attempts.length > 20 || !anchor.credentials.some((v) => v.type === 'maintenance' && v.evidence_id === id)) fail('SELF_MAINTENANCE_CONFLICT')
    for (const attempt of attempts) {
      if (typeof attempt === 'string') { if (!Object.hasOwn(manifest.proposals,assertId(attempt))) fail('SELF_MAINTENANCE_CONFLICT'); continue }
      assertOnly(attempt,['proposal_id','reservation_id','state'])
      if (!['reserved','completed'].includes(attempt.state)) fail('SELF_MAINTENANCE_CONFLICT'); assertId(attempt.reservation_id)
      const exists = attempt.proposal_id?.startsWith('trait:') ? Object.hasOwn(manifest.traits,assertId(attempt.proposal_id.slice(6))) : Object.hasOwn(manifest.proposals,assertId(attempt.proposal_id))
      if (!exists) fail('SELF_MAINTENANCE_CONFLICT')
    }
  }
  return entries.sort((a,b) => a.path.localeCompare(b.path))
}
export function verifySelfFiles(head, files, anchor) {
  validateSelfHead(head)
  if (SCOPE.some((key) => head[key] !== anchor[key])) fail('SELF_SCOPE_CONFLICT')
  if (files.size !== head.files.length || head.files.some((entry) => !files.has(entry.path) || digest(files.get(entry.path)) !== entry.sha256 || Buffer.byteLength(files.get(entry.path)) !== entry.bytes)) fail('EXTERNAL_SELF_CHANGE')
  if (digest(validateSelfFiles(files,anchor)) !== head.files_hash) fail('EXTERNAL_SELF_CHANGE')
  return files
}
export function verifySelfIntegrity(root, spaceId, agentId) {
  const anchor = selfAnchor(root,spaceId,agentId), head = loadSelfHead(root,spaceId,agentId)
  if (!head) fail('SELF_INTEGRITY_UPGRADE_REQUIRED')
  return { head, anchor, files: verifySelfFiles(head,readSelfFiles(root,spaceId,agentId),anchor) }
}
export function buildSelfDescriptor({ root, spaceId, anchor, files, operationId, previous, initialize = false }) {
  const old = previous === undefined ? loadSelfHead(root,spaceId,anchor.agent_identity_id) : previous
  if (!old && !initialize) fail('SELF_INTEGRITY_UPGRADE_REQUIRED')
  if (old && SCOPE.filter((key) => key !== 'core_version').some((key) => old[key] !== anchor[key])) fail('SELF_SCOPE_CONFLICT')
  const entries = validateSelfFiles(files,anchor)
  const generation = (old?.generation ?? 0) + 1; integer(generation,1); assertId(operationId)
  const next = { schema_version:1,...scopeOf(anchor),generation,parent_hash:old ? digest(old) : null,operation_id:operationId,files:entries,files_hash:digest(entries) }
  return { expected_generation:old?.generation ?? 0,next }
}
export function validateSelfDescriptor(descriptor) {
  assertOnly(descriptor,['expected_generation','next']); integer(descriptor.expected_generation); validateSelfHead(descriptor.next)
  if (descriptor.next.generation !== descriptor.expected_generation + 1 || descriptor.expected_generation === 0 && descriptor.next.parent_hash !== null || descriptor.expected_generation > 0 && descriptor.next.parent_hash === null) fail('INVALID_SELF_DESCRIPTOR')
  return descriptor
}
export function commitSelfDescriptor(root, spaceRoot, descriptor, write) {
  validateSelfDescriptor(descriptor)
  const next = descriptor.next
  if (resolve(spaceRoot) !== resolve(root,'spaces',next.memory_space_id)) fail('SELF_SPACE_MISMATCH')
  const old = loadSelfHead(root,next.memory_space_id,next.agent_identity_id)
  if (old && digest(old) === digest(next)) return
  if ((old?.generation ?? 0) !== descriptor.expected_generation || (old ? digest(old) : null) !== next.parent_hash) fail('SELF_HEAD_CONFLICT')
  const anchor = selfAnchor(root,next.memory_space_id,next.agent_identity_id)
  if (SCOPE.some((key) => next[key] !== anchor[key])) fail('SELF_SCOPE_CONFLICT')
  write(headPath(root,next.memory_space_id,next.agent_identity_id),json(next))
}

function references(value, removed, key = '') {
  if (typeof value === 'string') return ['evidence_id','evidence_refs','counterevidence_refs','maintenance_refs','review_maintenance_refs'].includes(key) && removed.has(value)
  if (Array.isArray(value)) return value.some((v) => references(v,removed,key))
  return value && typeof value === 'object' && Object.entries(value).some(([k,v]) => references(v,removed,k))
}
export function selfFileReferences(bytes, removedIds) { return references(parseJson(bytes),new Set(removedIds)) }
/** Prune only references revoked by committed or currently committing authority. */
export function pruneSelfFiles(files, removedIds) {
  const removed = new Set(removedIds), next = new Map(files)
  if (!removed.size || !next.size) return next
  for (const [path,bytes] of next) if (path !== 'manifest.json' && references(parseJson(bytes),removed)) next.delete(path)
  const manifest = parseJson(next.get('manifest.json')); let changed = false
  for (const kind of ['traits','proposals']) for (const id of Object.keys(manifest[kind])) if (!next.has(`${kind}/${id}.json`)) { delete manifest[kind][id]; changed = true }
  for (const [id,attempts] of Object.entries(manifest.maintenance)) {
    const kept = removed.has(id) ? [] : attempts.filter((attempt) => typeof attempt === 'string' ? Object.hasOwn(manifest.proposals,attempt) : attempt.proposal_id.startsWith('trait:') ? Object.hasOwn(manifest.traits,attempt.proposal_id.slice(6)) : Object.hasOwn(manifest.proposals,attempt.proposal_id))
    if (kept.length !== attempts.length || removed.has(id)) { if (removed.has(id)) delete manifest.maintenance[id]; else manifest.maintenance[id] = kept; changed = true }
  }
  if (changed) { manifest.revision++; next.set('manifest.json',Buffer.from(json(manifest))) }
  return next
}

export function decodeSelfSnapshot(snapshot) {
  assertOnly(snapshot,['snapshot_format','snapshot_version','head','files','checksum'])
  const {checksum,...unsigned}=snapshot
  if(snapshot.snapshot_format!=='dsh-persona-self'||snapshot.snapshot_version!==1||checksum!==digest(unsigned)||!Array.isArray(snapshot.files)||snapshot.files.length>4096)fail('INVALID_SELF_RESTORE_SOURCE')
  validateSelfHead(snapshot.head)
  const files=new Map();let total=0
  for(const entry of snapshot.files){assertOnly(entry,['path','data']);if(!validPath(entry.path)||typeof entry.data!=='string'||Buffer.from(entry.data,'base64').toString('base64')!==entry.data||files.has(entry.path))fail('INVALID_SELF_RESTORE_SOURCE');const data=Buffer.from(entry.data,'base64');total+=data.length;if(total>LIMIT)fail('SELF_BUNDLE_TOO_LARGE');files.set(entry.path,data)}
  if(files.size!==snapshot.head.files.length||snapshot.head.files.some((entry)=>!files.has(entry.path)||digest(files.get(entry.path))!==entry.sha256||files.get(entry.path).length!==entry.bytes))fail('SELF_RESTORE_SOURCE_HASH_MISMATCH')
  return files
}
/** A managed snapshot is rewritten without revoked originals, never hidden. */
export function filterSelfSnapshot(root, spaceId, snapshot, removedIds) {
  const files=decodeSelfSnapshot(snapshot), head=snapshot.head
  if(head.memory_space_id!==spaceId)return null
  const anchor=selfAnchor(root,spaceId,head.agent_identity_id)
  if(SCOPE.filter((key)=>key!=='core_version').some((key)=>head[key]!==anchor[key]))fail('SELF_SCOPE_CONFLICT')
  const compatible={...anchor,core_version:head.core_version}
  verifySelfFiles(head,files,compatible)
  const next=pruneSelfFiles(files,removedIds)
  if(digest([...next].map(([path,data])=>[path,digest(data)]))===digest([...files].map(([path,data])=>[path,digest(data)])))return null
  const entries=validateSelfFiles(next,compatible)
  const output={...snapshot,head:{...head,generation:head.generation+1,parent_hash:digest(head),operation_id:`managed-purge-${digest(removedIds).slice(0,40)}`,files:entries,files_hash:digest(entries)},files:[...next].map(([path,data])=>({path,data:Buffer.from(data).toString('base64')}))}
  delete output.checksum;output.checksum=digest(output);return output
}
