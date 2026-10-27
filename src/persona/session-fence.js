import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { MemoryError, assertId, assertOnly, digest } from '../memory/v2/contracts.js'
import { acquireRootLock, atomicWrite } from '../memory/v2/transactions.js'
import { readSessionBindings, validateSessionMirror, validateSessionOwner } from '../memory/v2/session-bindings.js'
import { canonicalProtectionPath } from './protection.js'

const PROJECTION_KEY = 'whaleSoulIdentityBoundary'
const metadataTypes = new Set(['agent-preset/selected', 'agent/options', 'agent/model-selected'])
const proofs = new WeakSet()
const json = (value) => `${JSON.stringify(value, null, 2)}\n`
const clone = (value) => JSON.parse(JSON.stringify(value))
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = (code) => { throw new MemoryError(code, `${code}：无法确认这个会话属于当前个体，请新建会话后继续；现有记忆不会因此重置。`) }
function initialPermissionMetadata(event) {
  const data = event.data
  if (!plain(data)) return false
  const keys = Object.keys(data)
  if (event.type === 'permission/preset') return keys.length === 1 && keys[0] === 'preset' && typeof data.preset === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(data.preset)
  if (event.type !== 'sandbox/mode' && event.type !== 'approval/policy') return false
  const key = event.type === 'sandbox/mode' ? 'mode' : 'policy'
  if (keys.some((entry) => entry !== key && entry !== 'source') || !Object.hasOwn(data, key) || Object.hasOwn(data, 'source') && data.source !== 'delegation') return false
  return (key === 'mode' ? ['read-only', 'workspace-write', 'danger-full-access'] : ['ask', 'never']).includes(data[key])
}
// The Web host pins these payload-free knobs before publishing a fresh Session.
// Unknown events and metadata carrying extra content remain material history.
function material(event) { return !metadataTypes.has(event.type) && !initialPermissionMetadata(event) }
function metadata(event) {
  return { seq: event.seq, time: event.time, type: event.type }
}
function validateProjection(value) {
  assertOnly(value, ['schema_version', 'inherited', 'last_seq', 'material_count', 'first_material'])
  if (!plain(value) || value.schema_version !== 1 || typeof value.inherited !== 'boolean' || !Number.isSafeInteger(value.last_seq) || value.last_seq < -1 || !Number.isSafeInteger(value.material_count) || value.material_count < 0) fail('SESSION_PROJECTION_INVALID')
  if (value.first_material !== null) {
    assertOnly(value.first_material, ['seq', 'time', 'type'])
    if (!plain(value.first_material) || !Number.isSafeInteger(value.first_material.seq) || value.first_material.seq < 0 || typeof value.first_material.type !== 'string' || !Number.isFinite(value.first_material.time)) fail('SESSION_PROJECTION_INVALID')
  }
  return value
}
const projection = (z) => Object.freeze({ key: PROJECTION_KEY, stateVersion: 1,
  stateSchema: z.object({ schema_version: z.literal(1), inherited: z.boolean(), last_seq: z.number().int().min(-1), material_count: z.number().int().nonnegative(),
    first_material: z.object({ seq: z.number().int().nonnegative(), time: z.number().finite(), type: z.string().max(200) }).strict().nullable() }).strict(),
  init: (header, inherited) => ({ schema_version: 1, inherited: header.isSeeded === true || inherited > 0, last_seq: -1, material_count: 0, first_material: null }),
  apply: (state, event) => ({ ...state, last_seq: event.seq, ...(material(event) ? { material_count: state.material_count + 1, first_material: state.first_material ?? metadata(event) } : {}) }),
})

/** Only records event structure, never message text, hashes, or attachment data. */
export function observeSessionIdentityBoundary(ctx, ownsAgent, z) {
  const registry = ctx?.get?.('sessionProjections'), agents = ctx?.get?.('agents'), sessions = ctx?.get?.('sessions')
  if (!registry?.register || !registry?.stateOf || !agents?.get || typeof sessions?.list !== 'function' || typeof ownsAgent !== 'function' || typeof z?.object !== 'function') fail('TRUSTED_SESSION_BINDINGS_REQUIRED')
  const eventContext = ctx.root
  const original = (value) => value?.[Symbol.for('cordis.original')] ?? value
  if (!eventContext?.on || original(eventContext.get('sessions')) !== original(sessions) || original(eventContext.get('agents')) !== original(agents)) fail('TRUSTED_SESSION_BINDINGS_REQUIRED')
  const disposeProjection = registry.register(projection(z)), seen = new WeakMap(), coverage = new WeakMap()
  for (const session of sessions.list()) coverage.set(session, { next: session.seq, complete: session.seq === 0, first: null })
  const disposeEvents = eventContext.on('session/event', (session, event) => {
    let history = coverage.get(session)
    if (!history) coverage.set(session, history = { next: 0, complete: event.seq === 0, first: null })
    if (event.seq !== history.next) history.complete = false
    history.next = event.seq + 1
    if (material(event) && history.first === null) history.first = metadata(event)
    const agent = agents.get(session.id)
    if (!agent || agent.session !== session || ownsAgent(agent) !== true || !material(event)) return
    if (!seen.has(session)) seen.set(session, metadata(event))
  })
  let disposed = false
  return Object.freeze({ registry,
    ownsFirst(session, first) { const observed = seen.get(session); return !disposed && observed?.seq === first?.seq && observed?.time === first?.time && observed?.type === first?.type },
    coversPrefix(session, first) {
      let history = coverage.get(session)
      if (!history && session.seq === 0) coverage.set(session, history = { next: 0, complete: true, first: null })
      return !disposed && history?.complete === true && history.next === session.seq && (first === null ? history.first === null : history.first?.seq === first.seq && history.first?.time === first.time && history.first?.type === first.type)
    },
    dispose() { if (disposed) return; disposed = true; disposeEvents(); disposeProjection() },
  })
}

/** Actual Agent/Session/Projection adapter; a plain argument cannot mint its proof. */
export function createSessionBoundary({ agent, observer, scopeChainOf, ownsAgent } = {}) {
  if (!agent?.ctx?.get || !observer?.registry?.stateOf || typeof scopeChainOf !== 'function' || typeof ownsAgent !== 'function') fail('TRUSTED_SESSION_BINDINGS_REQUIRED')
  const session = agent.session, registry = agent.ctx.get('agents'), sessions = agent.ctx.get('sessions')
  if (registry?.get(agent.id) !== agent || sessions?.get(session?.id) !== session || agent.id !== session.id || !plain(session.header)) fail('LIVE_AGENT_REQUIRED')
  const chain = scopeChainOf(agent)
  if (!Array.isArray(chain) || chain[0] !== agent || chain.length < 2) fail('SESSION_SCOPE_REQUIRED')
  const expectedChain = [...chain], header = session.header
  assertId(session.id)
  if (header.id !== session.id || !Number.isSafeInteger(header.createdAt) || header.createdAt < 0) fail('SESSION_HEADER_INVALID')
  const headerHash = digest({ id: header.id, createdAt: header.createdAt, version: header.version, isSeeded: header.isSeeded === true, parentSession: header.parentSession ?? null })
  const live = () => {
    const current = scopeChainOf(agent)
    if (agent.session !== session || session.header !== header || registry.get(agent.id) !== agent || sessions.get(session.id) !== session || ownsAgent(agent) !== true || current.length !== expectedChain.length || current.some((key, index) => key !== expectedChain[index])) fail('SESSION_SCOPE_CHANGED')
  }
  return Object.freeze({ agent, session,
    checkLive: live,
    proof() {
      live()
      const state = validateProjection(observer.registry.stateOf(session, PROJECTION_KEY))
      if (state.last_seq !== session.seq - 1) fail('SESSION_PROJECTION_STALE')
      const fresh = session.firstLiveSeq === 0 && session.firstLifecycleSeq === 0 && session.inheritedEventCount === 0
      const claimable = fresh && !state.inherited && observer.coversPrefix(session, state.first_material) && (state.first_material === null || observer.ownsFirst(session, state.first_material))
      const proof = Object.freeze({ session_id: session.id, session_key: `session-${digest(session.id).slice(0, 40)}`, header_hash: headerHash,
        bound_seq: session.seq, claimable, material_count: state.material_count, checkLive: live })
      proofs.add(proof); return proof
    },
  })
}

function safeFile(root, name) {
  if (canonicalProtectionPath(root) !== root) fail('UNSAFE_SESSION_AUTHORITY_PATH')
  for (const path of [root, join(root, name)]) {
    try { if (lstatSync(path).isSymbolicLink()) fail('UNSAFE_SESSION_AUTHORITY_PATH') } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return join(root, name)
}
function readAuthority(root) {
  const path = safeFile(root, 'authority.json')
  if (existsSync(root) && readdirSync(root).some((name) => name !== 'authority.json' && !/^(?:\.writer(?:-recovery)?\.lock|\.(?:lock-candidate|retired-lock)-[a-f0-9-]{36})$/.test(name))) fail('SESSION_AUTHORITY_REPAIR_REQUIRED')
  if (!existsSync(path)) return null
  let value
  try { value = JSON.parse(readFileSync(path, 'utf8')) } catch { fail('SESSION_AUTHORITY_REPAIR_REQUIRED') }
  assertOnly(value, ['schema_version', 'authority_id', 'revision', 'sessions'])
  if (value.schema_version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1 || !plain(value.sessions)) fail('SESSION_AUTHORITY_REPAIR_REQUIRED')
  assertId(value.authority_id)
  for (const [key, entry] of Object.entries(value.sessions)) {
    assertOnly(entry, ['mirror', 'status', 'mirror_hash'])
    validateSessionMirror(entry.mirror)
    if (key !== entry.mirror.session_key || entry.mirror.authority_id !== value.authority_id || !['reserved', 'confirmed'].includes(entry.status) || entry.status === 'confirmed' && entry.mirror_hash !== digest(entry.mirror) || entry.status === 'reserved' && entry.mirror_hash !== null) fail('SESSION_AUTHORITY_REPAIR_REQUIRED')
  }
  return value
}
/** Host services consult this restriction even after a persona role unloads. */
export function sessionAuthorityEntry(home, sessionId) {
  assertId(sessionId)
  return readAuthority(join(canonicalProtectionPath(home), 'whale-soul', 'session-authority', 'v1'))?.sessions[`session-${digest(sessionId).slice(0, 40)}`] ?? null
}

/** Two durable sides: host reservation -> memory COMMIT mirror -> host confirmation. */
export class SessionIdentityFence {
  #store; #owner; #boundary; #home; #root; #isCurrent; #fault; #ready = false; #disposed = false; #pending
  constructor({ store, owner, boundary, home, isCurrent, faultInjector } = {}) {
    if (!store?.initialized || !boundary?.proof || typeof home !== 'string' || !isAbsolute(home) || typeof isCurrent !== 'function') fail('TRUSTED_SESSION_BINDINGS_REQUIRED')
    validateSessionOwner(owner)
    this.#store = store; this.#owner = Object.freeze(clone(owner)); this.#boundary = boundary
    this.#home = canonicalProtectionPath(home); this.#root = join(this.#home, 'whale-soul', 'session-authority', 'v1')
    this.#isCurrent = isCurrent; this.#fault = faultInjector
  }
  #live() {
    if (this.#disposed || this.#isCurrent() !== true) fail('SESSION_AUTHORITY_CONTEXT_CHANGED')
    this.#boundary.checkLive()
  }
  #checkpoint(point) { this.#fault?.(point, { session_id: this.#boundary.session.id }) }
  #context() { return this.#store.issueContext({ ...this.#owner, session_id: this.#boundary.session.id, capabilities: ['memory.manage'] }) }
  async #rootIdentity() {
    const result = await this.#store.managedTransaction(`session-root-${randomUUID()}`, { action: 'sessionRootIdentity' }, () => {
      this.#live()
      const current = readSessionBindings(this.#store.root)
      if (current) return { changes: [], result: { status: 'ready', root_id: current.root_id } }
      const rootId = `root-${randomUUID()}`
      return { changes: [], session_descriptor: { memory_space_id: this.#owner.memory_space_id, root_id: rootId, expected_revision: 0, entry: null }, result: { status: 'ready', root_id: rootId } }
    }, this.#context(), { authorize: () => this.#live() })
    this.#live(); return result.root_id
  }
  async #locked(operation) {
    this.#live()
    safeFile(this.#root, 'authority.json')
    mkdirSync(this.#root, { recursive: true, mode: 0o700 })
    const release = await acquireRootLock(this.#root)
    try { this.#live(); return await operation() } finally { release() }
  }
  #match(entry, proof, rootId) {
    if (!proofs.has(proof)) fail('UNTRUSTED_SESSION_PROOF')
    if (entry.mirror.header_hash !== proof.header_hash) fail('SESSION_HEADER_CONFLICT')
    if (digest(entry.mirror.owner) !== digest(this.#owner)) fail('SESSION_IDENTITY_CONFLICT')
    if (entry.mirror.root_id !== rootId) fail('SESSION_MEMORY_ROOT_CONFLICT')
    if (this.#boundary.session.seq < entry.mirror.bound_seq) fail('SESSION_HISTORY_TRUNCATED')
  }
  inspect() {
    this.#live()
    const proof = this.#boundary.proof(), host = readAuthority(this.#root), root = readSessionBindings(this.#store.root), entry = host?.sessions[proof.session_key]
    if (!proofs.has(proof)) fail('UNTRUSTED_SESSION_PROOF')
    if (!entry) {
      if (root?.sessions[proof.session_key]) fail('SESSION_AUTHORITY_MISSING')
      if (!proof.claimable) fail('SESSION_IDENTITY_UNVERIFIED')
      return { status: 'unsealed' }
    }
    this.#match(entry, proof, root?.root_id)
    const mirror = root?.sessions[proof.session_key]
    if (entry.status === 'confirmed' && mirror && digest(mirror) === entry.mirror_hash) { this.#ready = true; return { status: 'confirmed' } }
    this.#ready = false; return { status: 'reserved' }
  }
  async authorize({ seal = true } = {}) {
    this.#live()
    const current = this.inspect()
    if (current.status === 'confirmed' || !seal && current.status === 'unsealed') return current
    if (this.#pending) return this.#pending
    const task = this.#authorize(); this.#pending = task
    try { return await task } finally { if (this.#pending === task) this.#pending = null }
  }
  async #authorize() {
    const proof = this.#boundary.proof(), rootId = await this.#rootIdentity()
    this.#live()
    const mirror = await this.#locked(() => {
      let host = readAuthority(this.#root)
      if (!host) host = { schema_version: 1, authority_id: `authority-${randomUUID()}`, revision: 0, sessions: {} }
      const existing = host.sessions[proof.session_key]
      if (existing) { this.#match(existing, proof, rootId); return existing.mirror }
      if (!proof.claimable) fail('SESSION_IDENTITY_UNVERIFIED')
      const value = { schema_version: 1, session_key: proof.session_key, session_id: proof.session_id, header_hash: proof.header_hash,
        authority_id: host.authority_id, reservation_id: `reservation-${randomUUID()}`, root_id: rootId, owner: this.#owner, bound_seq: proof.bound_seq }
      validateSessionMirror(value)
      host = { ...host, revision: host.revision + 1, sessions: { ...host.sessions, [proof.session_key]: { mirror: value, status: 'reserved', mirror_hash: null } } }
      this.#live(); atomicWrite(safeFile(this.#root, 'authority.json'), json(host)); this.#checkpoint('after_host_reservation')
      return value
    })
    this.#live()
    const verifyReservation = () => {
      this.#live()
      const entry = readAuthority(this.#root)?.sessions[proof.session_key]
      if (!entry || digest(entry.mirror) !== digest(mirror)) fail('SESSION_AUTHORITY_CHANGED')
    }
    await this.#store.managedTransaction(`session-fence-${mirror.reservation_id}`, { action: 'sessionFenceMirror', reservation: mirror.reservation_id }, () => {
      this.#live()
      const host = readAuthority(this.#root), entry = host?.sessions[proof.session_key]
      if (!entry || digest(entry.mirror) !== digest(mirror)) fail('SESSION_AUTHORITY_CHANGED')
      const ledger = readSessionBindings(this.#store.root)
      if (!ledger || ledger.root_id !== rootId) fail('SESSION_ROOT_CONFLICT')
      const previous = ledger.sessions[proof.session_key]
      if (previous && digest(previous) !== digest(mirror)) fail('SESSION_IDENTITY_CONFLICT')
      return { changes: [], ...(previous ? {} : { session_descriptor: { memory_space_id: this.#owner.memory_space_id, root_id: rootId, expected_revision: ledger.revision, entry: mirror } }),
        result: { status: 'session_mirrored', session_key: proof.session_key, reservation_id: mirror.reservation_id } }
    }, this.#context(), { authorize: verifyReservation })
    this.#checkpoint('after_memory_mirror')
    await this.#locked(() => {
      const host = readAuthority(this.#root), entry = host?.sessions[proof.session_key], root = readSessionBindings(this.#store.root)
      if (!entry || digest(entry.mirror) !== digest(mirror) || digest(root?.sessions[proof.session_key]) !== digest(mirror)) fail('SESSION_AUTHORITY_CHANGED')
      if (entry.status !== 'confirmed') {
        const next = { ...host, revision: host.revision + 1, sessions: { ...host.sessions, [proof.session_key]: { mirror, status: 'confirmed', mirror_hash: digest(mirror) } } }
        this.#live(); atomicWrite(safeFile(this.#root, 'authority.json'), json(next)); this.#checkpoint('after_host_confirmation')
      }
    })
    this.#ready = true; this.checkSync(); return { status: 'confirmed' }
  }
  checkSync() {
    this.#live()
    if (!this.#ready || this.inspect().status !== 'confirmed') fail('SESSION_IDENTITY_NOT_CONFIRMED')
    return true
  }
  dispose() { this.#disposed = true; this.#ready = false }
}
