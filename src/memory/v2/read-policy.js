import { retentionBlockReason } from './retention.js'

/**
 * Optional model-facing read gate. Management archives and original records
 * remain intact; preserving imported data does not grant permission to send it
 * to a model. A rejected record is omitted as a whole, including index titles.
 */
export function recordRetentionAllowed(record) {
  if (!record || typeof record !== 'object' || !record.meta || !Array.isArray(record.evidence) || !Array.isArray(record.meta.tags ?? [])) return false
  const values = [record.meta.title, record.meta.canonical_key ?? '', ...(record.meta.tags ?? []),
    record.gist, record.detail, ...record.evidence.map((item) => item?.content)]
  return values.every((value) => typeof value === 'string' && value.isWellFormed() && !retentionBlockReason(value))
}
