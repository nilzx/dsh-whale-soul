import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { MemoryError, assertId, assertOnly, digest } from './contracts.js'

export const SESSION_BINDINGS_PATH = '.administration/session-bindings.json'
const json = (value) => `${JSON.stringify(value, null, 2)}\n`
export function validateSessionOwner(owner) {
  assertOnly(owner, ['memory_space_id', 'binding_id', 'persona_id', 'agent_identity_id', 'subject_id'])
  Object.values(owner).forEach((value) => assertId(value))
  if (Object.keys(owner).length !== 5) throw new MemoryError('INVALID_SESSION_OWNER')
  return owner
}
export function validateSessionMirror(value) {
  assertOnly(value, ['schema_version', 'session_key', 'session_id', 'header_hash', 'authority_id', 'reservation_id', 'root_id', 'owner', 'bound_seq'])
  if (value.schema_version !== 1 || !/^[a-f0-9]{64}$/.test(value.header_hash) || !Number.isSafeInteger(value.bound_seq) || value.bound_seq < 0) throw new MemoryError('INVALID_SESSION_BINDING')
  for (const key of ['session_key', 'session_id', 'authority_id', 'reservation_id', 'root_id']) assertId(value[key])
  if (value.session_key !== `session-${digest(value.session_id).slice(0, 40)}`) throw new MemoryError('INVALID_SESSION_BINDING')
  validateSessionOwner(value.owner)
  return value
}
function safe(root) {
  for (const path of [root, join(root, '.administration'), join(root, SESSION_BINDINGS_PATH)]) {
    try { if (lstatSync(path).isSymbolicLink()) throw new MemoryError('UNSAFE_STORAGE_PATH') } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return join(root, SESSION_BINDINGS_PATH)
}
export function readSessionBindings(root) {
  const path = safe(root)
  if (!existsSync(path)) return null
  let ledger
  try { ledger = JSON.parse(readFileSync(path, 'utf8')) } catch { throw new MemoryError('SESSION_BINDINGS_REPAIR_REQUIRED') }
  assertOnly(ledger, ['schema_version', 'root_id', 'revision', 'sessions'])
  if (ledger.schema_version !== 1 || !Number.isSafeInteger(ledger.revision) || ledger.revision < 1 || !ledger.sessions || typeof ledger.sessions !== 'object' || Array.isArray(ledger.sessions)) throw new MemoryError('SESSION_BINDINGS_REPAIR_REQUIRED')
  assertId(ledger.root_id)
  for (const [key, entry] of Object.entries(ledger.sessions)) {
    validateSessionMirror(entry)
    if (key !== entry.session_key || entry.root_id !== ledger.root_id) throw new MemoryError('SESSION_BINDINGS_REPAIR_REQUIRED')
  }
  return ledger
}
export function validateSessionDescriptor(descriptor) {
  assertOnly(descriptor, ['memory_space_id', 'root_id', 'expected_revision', 'entry'])
  assertId(descriptor.memory_space_id); assertId(descriptor.root_id)
  if (!Number.isSafeInteger(descriptor.expected_revision) || descriptor.expected_revision < 0) throw new MemoryError('INVALID_SESSION_DESCRIPTOR')
  if (descriptor.entry !== null) {
    validateSessionMirror(descriptor.entry)
    if (descriptor.entry.root_id !== descriptor.root_id || descriptor.entry.owner.memory_space_id !== descriptor.memory_space_id) throw new MemoryError('INVALID_SESSION_DESCRIPTOR')
  }
  return descriptor
}
/** Root mirror installation is host-only and follows durable memory COMMIT. */
export function commitSessionDescriptor(root, spaceRoot, descriptor, write) {
  if (!descriptor) return
  validateSessionDescriptor(descriptor)
  if (resolve(spaceRoot) !== resolve(root, 'spaces', descriptor.memory_space_id)) throw new MemoryError('SESSION_SPACE_MISMATCH')
  const previous = readSessionBindings(root)
  if (previous && previous.root_id !== descriptor.root_id) throw new MemoryError('SESSION_ROOT_CONFLICT')
  if (descriptor.entry && previous?.sessions[descriptor.entry.session_key]) {
    if (digest(previous.sessions[descriptor.entry.session_key]) !== digest(descriptor.entry)) throw new MemoryError('SESSION_IDENTITY_CONFLICT')
    return
  }
  if (descriptor.entry === null && previous) return
  if ((previous?.revision ?? 0) !== descriptor.expected_revision) throw new MemoryError('SESSION_BINDING_REVISION_CONFLICT')
  const ledger = { schema_version: 1, root_id: descriptor.root_id, revision: (previous?.revision ?? 0) + 1,
    sessions: { ...(previous?.sessions ?? {}), ...(descriptor.entry ? { [descriptor.entry.session_key]: descriptor.entry } : {}) } }
  write(safe(root), json(ledger))
}
