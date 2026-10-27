#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { API_VERSION, FORMAT_VERSION, MemoryStoreV2, MemoryAdministration, MemoryTransfer, PersonaSelfAdministration, validateTransferArchive } from './memory/v2/index.js'

const HELP = `Whale Soul local owner management

Every data command requires --root ABSOLUTE_PATH --space SPACE_ID.
Import, migration and purge are previews unless --apply is present. No default data root is used.

  status
  export --out ABSOLUTE_FILE [--opaque-policy omit|include-reviewed]
  import --archive ABSOLUTE_FILE --identity-mode preserve
         [--accept-purge-state] [--accept-persona-state] [--accept-integrity-state] [--accept-self-integrity]
         [--accept-legacy-baseline] [--allow-maturity-reset] [--apply]
  migrate-v1 --source ABSOLUTE_PATH --source-quiescent
         --subject SUBJECT_ID --persona PERSONA_ID --agent-identity AGENT_ID
         [--snapshot SHA256] [--opaque-policy omit|preserve-local] [--apply]
  upgrade-self --source ABSOLUTE_PATH --source-quiescent
         --legacy-self-policy preserve-opaque [--snapshot SHA256] [--apply]
  purge --record RECORD_ID@EXPECTED_REVISION [--record ...]
         [--include-legacy-narratives] [--apply]
  purge --pending-item EVIDENCE_ID [--apply]

Import, migrate-v1, upgrade-self and purge accept --operation-id ID for explicit idempotent retries.
Run this command as the local owner outside the persona's restricted tool process.
There is no command to edit the core, fabricate a source, or rewrite arbitrary history.
`
const id = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
const fail = (code) => { throw Object.assign(new Error(code), { code }) }
const json = (value) => `${JSON.stringify(value, null, 2)}\n`
const hash = (value) => createHash('sha256').update(value).digest('hex')
const booleanOptions = new Set(['apply', 'source-quiescent', 'accept-purge-state', 'accept-persona-state', 'accept-integrity-state', 'accept-self-integrity', 'accept-legacy-baseline', 'allow-maturity-reset', 'include-legacy-narratives'])
const allowed = {
  status: [], export: ['out', 'opaque-policy', 'apply'],
  import: ['archive', 'identity-mode', 'accept-purge-state', 'accept-persona-state', 'accept-integrity-state', 'accept-self-integrity', 'accept-legacy-baseline', 'allow-maturity-reset', 'apply', 'operation-id'],
  'migrate-v1': ['source', 'source-quiescent', 'subject', 'persona', 'agent-identity', 'snapshot', 'opaque-policy', 'apply', 'operation-id'],
  'upgrade-self': ['source', 'source-quiescent', 'snapshot', 'legacy-self-policy', 'apply', 'operation-id'],
  purge: ['record', 'pending-item', 'include-legacy-narratives', 'apply', 'operation-id'],
}
function absolute(value, name) {
  if (typeof value !== 'string' || !isAbsolute(value)) fail(`ABSOLUTE_${name}_REQUIRED`)
  const path = resolve(value)
  if (dirname(path) === path) fail(`UNSAFE_${name}`)
  let current = path
  const missing = []
  while (true) {
    try {
      const stat = lstatSync(current)
      if (current === path && stat.isSymbolicLink()) fail('UNSAFE_STORAGE_SYMLINK')
      return resolve(realpathSync(current), ...missing)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      missing.unshift(basename(current)); current = dirname(current)
    }
  }
}
function parse(argv) {
  if (argv.length > 2048) fail('TOO_MANY_ARGUMENTS')
  if (argv.length === 1 && ['help', '--help', '-h'].includes(argv[0])) return { help: true }
  const command = argv[0]
  if (!Object.hasOwn(allowed, command)) fail('COMMAND_REQUIRED')
  const options = { record: [] }
  const keys = new Set(['root', 'space', ...allowed[command]])
  for (let index = 1; index < argv.length; index++) {
    const token = argv[index]
    if (!/^--[a-z][a-z-]*$/.test(token)) fail('INVALID_ARGUMENT')
    const key = token.slice(2)
    if (!keys.has(key)) fail('UNSUPPORTED_OPTION')
    if (key !== 'record' && Object.hasOwn(options, key)) fail('DUPLICATE_OPTION')
    const value = booleanOptions.has(key) ? true : argv[++index]
    if (value === undefined || typeof value === 'string' && value.startsWith('--')) fail('OPTION_VALUE_REQUIRED')
    if (key === 'record') options.record.push(value); else options[key] = value
  }
  options.root = absolute(options.root, 'ROOT')
  if (!id(options.space)) fail('SPACE_ID_REQUIRED')
  if (options['operation-id'] !== undefined && !id(options['operation-id'])) fail('INVALID_OPERATION_ID')
  if (command === 'export') {
    options.out = absolute(options.out, 'OUTPUT_FILE')
    const rel = relative(options.root, options.out)
    if (rel === '' || !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel) && !['exports', 'backups'].includes(rel.split(sep)[0])) fail('UNSAFE_EXPORT_DESTINATION')
    if (existsSync(options.out)) fail('OUTPUT_ALREADY_EXISTS')
  }
  if (command === 'import') {
    options.archive = absolute(options.archive, 'ARCHIVE_FILE')
    if (options['identity-mode'] !== 'preserve') fail('EXPLICIT_IDENTITY_MODE_REQUIRED')
  }
  if (command === 'migrate-v1') {
    options.source = absolute(options.source, 'SOURCE')
    if (!options['source-quiescent']) fail('SOURCE_QUIESCENCE_REQUIRED')
    for (const key of ['subject', 'persona', 'agent-identity']) if (!id(options[key])) fail('EXPLICIT_MIGRATION_IDENTITY_REQUIRED')
    if (options.snapshot !== undefined && !/^[a-f0-9]{64}$/.test(options.snapshot)) fail('INVALID_SOURCE_SNAPSHOT')
    if (options.apply && !options.snapshot) fail('SOURCE_SNAPSHOT_REQUIRED')
  }
  if (command === 'upgrade-self') {
    options.source = absolute(options.source, 'SOURCE')
    if (!options['source-quiescent']) fail('SOURCE_QUIESCENCE_REQUIRED')
    if (options['legacy-self-policy'] !== 'preserve-opaque') fail('EXPLICIT_LEGACY_SELF_POLICY_REQUIRED')
    if (options.snapshot !== undefined && !/^[a-f0-9]{64}$/.test(options.snapshot)) fail('INVALID_SOURCE_SNAPSHOT')
    if (options.apply && !options.snapshot) fail('SOURCE_SNAPSHOT_REQUIRED')
  }
  if (command === 'purge') {
    if (options['pending-item'] !== undefined) {
      if (options.record.length) fail('MUTUALLY_EXCLUSIVE_PURGE_TARGETS')
      if (!id(options['pending-item'])) fail('INVALID_EVIDENCE_ID')
      if (options['include-legacy-narratives']) fail('UNSUPPORTED_PENDING_ITEM_SCOPE')
    } else if (!options.record.length || options.record.length > 1000) fail('PRECISE_PURGE_SCOPE_REQUIRED')
    options.targets = options.record.map((value) => {
      const match = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})@([1-9][0-9]*)$/.exec(value)
      if (!match || !Number.isSafeInteger(Number(match[2]))) fail('EXPECTED_REVISION_REQUIRED')
      return { record_id: match[1], expected_revision: Number(match[2]) }
    })
    if (new Set(options.targets.map((item) => item.record_id)).size !== options.targets.length) fail('DUPLICATE_PURGE_TARGET')
  }
  const policy = options['opaque-policy']
  if (policy !== undefined && !(command === 'export' ? ['omit', 'include-reviewed'] : ['omit', 'preserve-local']).includes(policy)) fail('UNSUPPORTED_OPAQUE_POLICY')
  return { command, options }
}
function leaf(path) {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) fail('UNSAFE_STORAGE_SYMLINK')
  return stat
}
function readJson(path) {
  if (!leaf(path).isFile() || lstatSync(path).size > 128 * 1024 * 1024) fail('INVALID_MANAGEMENT_FILE')
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch (error) { if (error.code === 'EACCES' || error.code === 'EPERM') throw error; fail('INVALID_MANAGEMENT_JSON') }
}
function validateRoot(root, space, allowNew) {
  if (!existsSync(root)) { if (allowNew) return false; fail('MEMORY_ROOT_NOT_FOUND') }
  if (!leaf(root).isDirectory()) fail('INVALID_MEMORY_ROOT')
  const manifest = join(root, 'manifest.json')
  if (!existsSync(manifest)) {
    if (allowNew && readdirSync(root).length === 0) return false
    fail('MEMORY_ROOT_MANIFEST_REQUIRED')
  }
  const value = readJson(manifest)
  if (value.format_version !== FORMAT_VERSION || !Array.isArray(value.spaces) || value.spaces.some((entry) => !id(entry))) fail('UNSUPPORTED_MEMORY_ROOT')
  if (!allowNew && (!value.spaces.includes(space) || !existsSync(join(root, 'spaces', space, 'manifest.json')))) fail('MEMORY_SPACE_NOT_FOUND')
  const administration = join(root, '.administration')
  if (existsSync(administration)) {
    if (!leaf(administration).isDirectory()) fail('INVALID_ADMINISTRATION_ROOT')
    if (readdirSync(administration).some((entry) => !['purge-ledger.json', 'persona-ledger.json', 'session-bindings.json', 'record-heads', 'self-heads', 'repair.lock'].includes(entry))) fail('UNSUPPORTED_MANAGED_REFERENCE')
  }
  const journal = join(root, 'spaces', space, 'journal')
  if (existsSync(journal) && readdirSync(journal).length) fail('MANAGEMENT_RECOVERY_REQUIRED')
  return true
}
function ownerContext(store) {
  return store.issueContext({ agent_identity_id: 'local-owner-management', persona_id: 'local-owner-management', subject_id: 'local-owner-management',
    capabilities: ['memory.manage'] })
}
function assertIdle(root, space) {
  if (!existsSync(root)) return
  const store = new MemoryStoreV2({ root, memory_space_id: space })
  const locks = new MemoryAdministration({ store }).inspectLocks(ownerContext(store))
  if (locks.writer || locks.recovery || locks.management) fail('MANAGEMENT_REQUIRES_STOPPED_WRITERS')
}
function snapshot(root, space) {
  const entries = [], limits = { bytes: 0, files: 0 }
  const walk = (relativePath) => {
    const path = join(root, relativePath)
    let stat
    try { stat = leaf(path) } catch (error) { if (error?.code === 'ENOENT') return; throw error }
    if (stat.isDirectory()) { for (const name of readdirSync(path).sort()) walk(join(relativePath, name)); return }
    if (!stat.isFile() || stat.size > 128 * 1024 * 1024) fail('MANAGEMENT_PREVIEW_BUDGET_EXCEEDED')
    const data = readFileSync(path)
    limits.bytes += data.length; limits.files++
    if (limits.bytes > 256 * 1024 * 1024 || limits.files > 20000) fail('MANAGEMENT_PREVIEW_BUDGET_EXCEEDED')
    entries.push({ path: relativePath, data, sha256: hash(data) })
  }
  for (const path of ['manifest.json', '.administration/purge-ledger.json', '.administration/persona-ledger.json', '.administration/session-bindings.json', '.administration/record-heads', '.administration/self-heads', `spaces/${space}`, 'exports', 'backups']) walk(path)
  return { entries, checksum: hash(JSON.stringify(entries.map(({ path, sha256 }) => ({ path, sha256 })))) }
}
async function services(root, space) {
  const store = await new MemoryStoreV2({ root, memory_space_id: space }).initialize()
  const context = ownerContext(store), administration = new MemoryAdministration({ store })
  const transfer = new MemoryTransfer({ store, importGuard: administration.assertImportAllowed.bind(administration) })
  return { store, context, administration, transfer, selfAdministration: new PersonaSelfAdministration({ store }) }
}
function checked(result) {
  if (result?.status === 'rejected' || result?.status === 'unavailable' || result?.pending || result?.status === 'conflict') fail(result.reason_code ?? 'MANAGEMENT_OPERATION_FAILED')
  return result
}
function archiveSummary(result) {
  if (result.status !== 'ok') return result
  const archive = result.archive
  return { status: 'ok', record_count: result.record_ids.length, record_ids: result.record_ids, file_count: archive.files.length,
    checksum: archive.checksum, revision_watermark: archive.revision_watermark, purge_generation: archive.purge_generation,
    identities: Object.keys(archive.manifest.identities), identity_bindings: Object.entries(archive.manifest.identities).map(([key, value]) => ({ agent_identity_id: key,
      ...(id(value?.persona_id) ? { persona_id: value.persona_id } : {}), ...(id(value?.subject_id) ? { subject_id: value.subject_id } : {}) })),
    persona_anchor_count: archive.persona_state?.anchors.length ?? 0, self_anchor_count: archive.self_integrity_state?.heads.length ?? 0,
    item_bindings: (archive.persona_state?.anchors ?? []).flatMap((anchor) => (anchor.items ?? []).map((item) => ({ evidence_id: item.evidence_id,
      agent_identity_id: anchor.agent_identity_id, persona_id: anchor.persona_id, subject_id: anchor.subject_id,
      status: archive.purge_state?.evidence_ids.includes(item.evidence_id) || archive.purge_state?.related_evidence_ids.includes(item.evidence_id) ? 'purged'
        : anchor.revoked_ids.includes(item.evidence_id) || anchor.revoked_ids.includes(item.event_evidence_id) ? 'revoked'
          : item.outbox_outcome?.status ?? 'approved_unverified' }))),
    item_reference_check: 'not_performed; purgePendingItem must verify absence of current and historical record references',
    export_policy: archive.manifest.export_policy }
}
async function action(command, options, service, applying) {
  const { context, administration, transfer } = service
  if (command === 'status') return archiveSummary(checked(await transfer.exportSpace({ opaque_policy: 'omit' }, context)))
  if (command === 'export') {
    const result = checked(await transfer.exportSpace({ ...(options['opaque-policy'] ? { opaque_policy: options['opaque-policy'].replaceAll('-', '_') } : {}) }, context))
    return { ...archiveSummary(result), output_file: options.out, file_written: false, ...(result.status === 'ok' ? { exportArchive: result.archive } : {}) }
  }
  if (command === 'import') return checked(await transfer.importSpace({ operation_id: options['operation-id'] ?? randomUUID(), archive: options.loadedArchive,
    identity_mode: 'preserve', accept_purge_state: options['accept-purge-state'] === true, accept_persona_state: options['accept-persona-state'] === true,
    allow_maturity_reset: options['allow-maturity-reset'] === true, accept_self_integrity: options['accept-self-integrity'] === true, accept_integrity_state: options['accept-integrity-state'] === true, accept_legacy_baseline: options['accept-legacy-baseline'] === true }, context))
  if (command === 'migrate-v1') {
    const input = { operation_id: options['operation-id'] ?? randomUUID(), source_root: options.source,
      source_quiescent: true, identity: { subject_id: options.subject, persona_id: options.persona, agent_identity_id: options['agent-identity'] },
      ...(options['opaque-policy'] ? { opaque_policy: options['opaque-policy'].replaceAll('-', '_') } : {}) }
    if (applying) return checked(await transfer.migrateV1({ ...input, expected_snapshot: options.snapshot }, context))
    const preview = checked(await transfer.migrateV1({ ...input, dry_run: true }, context))
    if (preview.opaque_files.length && !options['opaque-policy']) return { ...preview, status: 'review_required', reason_code: 'OPAQUE_REVIEW_REQUIRED', apply_check: 'not_performed' }
    const simulated = checked(await transfer.migrateV1({ ...input, expected_snapshot: options.snapshot ?? preview.source_snapshot }, context))
    return { ...preview, apply_check: 'passed_in_shadow', simulated_status: simulated.status }
  }
  if (command === 'upgrade-self') {
    const input = { operation_id: options['operation-id'] ?? randomUUID(), source_root: options.source, source_quiescent: true, legacy_self_policy: 'preserve_opaque' }
    if (applying) return checked(await service.selfAdministration.upgradeLegacySelf({ ...input, dry_run: false, expected_snapshot: options.snapshot }, context))
    const preview = checked(await service.selfAdministration.upgradeLegacySelf({ ...input, dry_run: true }, context))
    const simulated = checked(await service.selfAdministration.upgradeLegacySelf({ ...input, dry_run: false, expected_snapshot: options.snapshot ?? preview.source_snapshot }, context))
    return { ...preview, apply_check: 'passed_in_shadow', simulated_status: simulated.status }
  }
  if (options['pending-item']) return { ...checked(await administration.purgePendingItem({ operation_id: options['operation-id'] ?? randomUUID(), evidence_id: options['pending-item'] }, context)),
    scope: { pending_item: options['pending-item'] } }
  return { ...checked(await administration.purgeScope({ operation_id: options['operation-id'] ?? randomUUID(), record_ids: options.targets.map((item) => item.record_id),
    expected_revisions: Object.fromEntries(options.targets.map((item) => [item.record_id, item.expected_revision])),
    ...(options['include-legacy-narratives'] ? { include_legacy_narratives: true } : {}) }, context)),
    scope: { records: options.targets, include_legacy_narratives: options['include-legacy-narratives'] === true } }
}

/** Standalone local-owner entry; it is deliberately not registered as an Agent tool. */
export async function runManagement(argv) {
  const parsed = parse(argv)
  if (parsed.help) return { exitCode: 0, text: HELP }
  const { command, options } = parsed, allowNew = ['import', 'migrate-v1', 'upgrade-self'].includes(command)
  if (command === 'import') {
    options.loadedArchive = readJson(options.archive); validateTransferArchive(options.loadedArchive)
    if (options.loadedArchive.memory_space_id !== options.space) fail('TRANSFER_SPACE_MISMATCH')
    if (options.loadedArchive.purge_state !== undefined && !options['accept-purge-state']) fail('PURGE_STATE_ACCEPTANCE_REQUIRED')
    if (options.loadedArchive.persona_state !== undefined && !options['accept-persona-state']) fail('PERSONA_STATE_ACCEPTANCE_REQUIRED')
    if (options.loadedArchive.integrity_state !== undefined && !options['accept-integrity-state']) fail('INTEGRITY_STATE_ACCEPTANCE_REQUIRED')
    if (options.loadedArchive.transfer_version === 1 && !options['accept-legacy-baseline']) fail('LEGACY_BASELINE_ACCEPTANCE_REQUIRED')
    if (options.loadedArchive.self_integrity_state !== undefined && !options['accept-self-integrity']) fail('SELF_INTEGRITY_ACCEPTANCE_REQUIRED')
  }
  validateRoot(options.root, options.space, allowNew); assertIdle(options.root, options.space)
  if (options.apply && command !== 'export') {
    const result = await action(command, options, await services(options.root, options.space), true)
    return { exitCode: result.status === 'review_required' ? 2 : 0, result: { api_version: API_VERSION, command, mode: 'apply', ...result } }
  }
  const before = snapshot(options.root, options.space)
  const temporary = mkdtempSync(join(realpathSync(tmpdir()), 'whale-management-preview-')), shadow = join(temporary, 'root')
  try {
    for (const entry of before.entries) { const path = join(shadow, entry.path); mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, entry.data, { flag: 'wx', mode: 0o600 }) }
    const copied = snapshot(shadow, options.space)
    if (copied.checksum !== before.checksum) fail('MANAGEMENT_SHADOW_COPY_MISMATCH')
    let result
    try { result = await action(command, options, await services(shadow, options.space), false) }
    finally {
      assertIdle(options.root, options.space)
      if (snapshot(options.root, options.space).checksum !== before.checksum) fail('MANAGEMENT_SOURCE_CHANGED')
    }
    let sourceUnchanged = true
    if (command === 'export' && result.exportArchive) {
      mkdirSync(dirname(options.out), { recursive: true, mode: 0o700 })
      writeFileSync(options.out, json(result.exportArchive), { flag: 'wx', mode: 0o600 })
      const rel = relative(options.root, options.out)
      sourceUnchanged = rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
      const { exportArchive, ...summary } = result
      result = { ...summary, file_written: true }
    }
    return { exitCode: result.status === 'review_required' ? 2 : 0, result: { api_version: API_VERSION, command, mode: command === 'export' ? 'export' : 'preview', source_snapshot: before.checksum,
      source_unchanged: sourceUnchanged, writes_applied: false, ...result } }
  } finally { rmSync(temporary, { recursive: true, force: true }) }
}
export async function managementMain(argv = process.argv.slice(2)) {
  try { const result = await runManagement(argv); process.stdout.write(result.text ?? json(result.result)); return result.exitCode }
  catch (error) {
    const fsCode = ['EACCES', 'EPERM'].includes(error?.code) ? 'MANAGEMENT_FS_DENIED' : error?.code === 'EEXIST' ? 'OUTPUT_ALREADY_EXISTS' : 'MANAGEMENT_FAILED'
    const code = /^[A-Z][A-Z0-9_]{0,99}$/.test(error?.code ?? '') ? (['EACCES', 'EPERM', 'EEXIST', 'ENOENT', 'ENOTDIR'].includes(error.code) ? fsCode : error.code) : fsCode
    process.stdout.write(json({ api_version: API_VERSION, status: 'unavailable', reason_code: code, writes_applied: argv.includes('--apply') && argv[0] !== 'export' ? null : false,
      ...(argv[0] === 'export' ? { file_written: null } : {}) }))
    return 1
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await managementMain()
