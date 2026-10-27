import { createHash } from 'node:crypto'

export const FORMAT_VERSION = 2
export const RECORD_SCHEMA_VERSION = 2
export const API_VERSION = '1.1.0'
export const CLAIM_KINDS = ['user_statement', 'tool_observation', 'inference', 'hypothesis', 'quotation', 'role_fiction', 'legacy']
export const MEMORY_TYPES = ['identity', 'preference', 'episode', 'promise', 'emotion', 'procedure', 'fact', 'meme']
export const CAPABILITIES = ['memory.read', 'memory.write', 'memory.raw', 'memory.list', 'memory.share', 'memory.manage', 'memory.import', 'memory.export', 'memory.purge', 'self.write', 'self.evaluate']

export class MemoryError extends Error {
  constructor(code, message = code) {
    super(message)
    this.name = 'MemoryError'
    this.code = code
  }
}

export function assertId(value, label = 'id') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new MemoryError('INVALID_ID', `Invalid ${label}`)
  }
  return value
}

export function text(value, label, { max = 60_000, optional = false } = {}) {
  if (optional && (value === undefined || value === null)) return null
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new MemoryError('INVALID_TEXT', `Invalid ${label}`)
  return value.trim()
}

export function timestamp(value, label, optional = true) {
  if (optional && (value === undefined || value === null)) return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value))) throw new MemoryError('INVALID_TIME', `Invalid ${label}`)
  return new Date(value).toISOString()
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function digest(value) {
  return createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : stableStringify(value)).digest('hex')
}

export function assertOnly(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MemoryError('INVALID_ARGUMENTS')
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new MemoryError('UNSUPPORTED_FIELD')
}

export function validateRecord(meta) {
  if (!meta || meta.schema_version !== RECORD_SCHEMA_VERSION) throw new MemoryError('UNSUPPORTED_RECORD_SCHEMA')
  for (const key of ['record_id', 'revision_id', 'memory_space_id', 'subject_id', 'persona_id', 'agent_identity_id']) assertId(meta[key], key)
  if (!Number.isSafeInteger(meta.revision) || meta.revision < 1) throw new MemoryError('INVALID_REVISION')
  if (!MEMORY_TYPES.includes(meta.type) || !CLAIM_KINDS.includes(meta.claim_kind)) throw new MemoryError('INVALID_RECORD_KIND')
  if (!['active', 'archived', 'superseded'].includes(meta.status)) throw new MemoryError('INVALID_RECORD_STATUS')
  if (!Array.isArray(meta.provenance_refs) || !meta.provenance_refs.length) throw new MemoryError('EVIDENCE_REQUIRED')
  meta.provenance_refs.forEach((ref) => assertId(ref, 'evidence id'))
  timestamp(meta.created_at, 'created_at', false)
  timestamp(meta.updated_at, 'updated_at', false)
  timestamp(meta.observed_at, 'observed_at', false)
  return meta
}

export function failure(error, operationId = null) {
  const code = error instanceof MemoryError ? error.code : 'STORAGE_FAILURE'
  const pending = code === 'COMMIT_RECOVERY_REQUIRED'
  return { api_version: API_VERSION, operation_id: operationId, status: pending ? 'pending' : code.endsWith('_CONFLICT') ? 'conflict' : 'rejected', reason_code: code, affected_ids: [], revision: null, pending }
}
