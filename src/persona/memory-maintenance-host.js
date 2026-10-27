import { MemoryError, digest, failure } from '../memory/v2/contracts.js'
import { MemoryMaintenance } from '../memory/v2/maintenance.js'
import { assertMaintenanceWriterPort, discoverMaintenanceWriterPorts, maintenanceRoot, observeMaintenanceWriterPorts } from '../memory/v2/maintenance-writers.js'
import { readSessionBindings } from '../memory/v2/session-bindings.js'

const managers = new WeakMap(), registrations = new WeakSet()
const original = (value) => value?.[Symbol.for('cordis.original')] ?? value
const fail = (code) => { throw new MemoryError(code) }
const safeCode = (error) => /^[A-Z][A-Z0-9_]{0,99}$/.test(error?.code ?? '') ? error.code : 'MEMORY_MAINTENANCE_HOST_FAILURE'
const scopeKeys = ['memory_space_id', 'subject_id', 'persona_id', 'agent_identity_id']
const policyOf = (config) => Object.freeze({ automaticCold: config.automaticCold === true, days: config.maintenanceDays ?? 7, writes: config.maintenanceWrites ?? 40,
  idleMs: config.idleMs ?? 300000, minAgeDays: config.memoryColdAfterDays ?? 30, batchLimit: config.memoryMaintenanceBatchLimit ?? 32,
  scanLimit: config.memoryMaintenanceScanLimit ?? 256, maxBatchMs: config.memoryMaintenanceTimeoutMs ?? 5000, maxBatchBytes: config.memoryMaintenanceMaxBytes ?? 64 * 1024 * 1024 })

function managerFor(ctx) {
  const host = ctx.root
  if (!host?.on || !host?.effect || typeof host.get !== 'function') fail('TRUSTED_MAINTENANCE_HOST_REQUIRED')
  let manager = managers.get(host)
  if (manager) return manager
  const agents = original(host.get('agents')), sessions = original(host.get('sessions')), projections = original(host.get('sessionProjections')), llm = original(host.get('llm'))
  if (!agents?.list || !agents?.get || !sessions?.list || !sessions?.get || !projections?.stateOf || !llm?.ctx?.on) fail('TRUSTED_MAINTENANCE_HOST_REQUIRED')
  const groups = new Map(), streams = new WeakMap(), ports = new Set(), portDisposers = [], ids = new WeakMap()
  let identitySerial = 0, serial = 0, disposed = false
  const objectId = (value) => { if (!value || !['object', 'function'].includes(typeof value)) fail('INVALID_LIVE_MAINTENANCE_OBJECT'); if (!ids.has(value)) ids.set(value, ++identitySerial); return ids.get(value) }
  const currentServices = () => !disposed && original(host.get('agents')) === agents && original(host.get('sessions')) === sessions && original(host.get('sessionProjections')) === projections && original(host.get('llm')) === llm
  const bump = (group, reason) => { group.epoch++; group.idleSince = Date.now(); group.lastReason = reason; group.active?.controller.abort(new MemoryError('HOST_ACTIVITY_CHANGED')); for (const lease of group.active?.leases ?? []) lease.cancel() }
  const related = (group, agent) => [...group.entries].filter((entry) => !entry.disposed && entry.ownsAgent(agent) === true)
  const ledgerFor = (group) => readSessionBindings(group.root)
  const boundTo = (group, sessionId) => Object.values(ledgerFor(group)?.sessions ?? {}).some((mirror) => mirror.session_id === sessionId && mirror.owner.memory_space_id === group.spaceId)
  const changed = (agent, reason) => {
    for (const group of groups.values()) {
      try { if (related(group, agent).length || boundTo(group, agent?.session?.id ?? agent?.id)) bump(group, reason) }
      catch { bump(group, 'COVERAGE_UNVERIFIED') }
    }
  }
  const collect = (group, { fences = true } = {}) => {
    if (!currentServices() || group.invalid) fail('MEMORY_MAINTENANCE_SERVICE_CHANGED')
    const bindings = ledgerFor(group), bound = new Map(Object.values(bindings?.sessions ?? {}).filter((mirror) => mirror.owner.memory_space_id === group.spaceId).map((mirror) => [mirror.session_id, mirror]))
    const members = [], passive = [], all = agents.list()
    if (!Array.isArray(all) || new Set(all).size !== all.length) fail('MEMORY_MAINTENANCE_COVERAGE_UNVERIFIED')
    let queued = 0, inflight = 0, running = false, pending = 0
    for (const entry of group.entries) {
      if (entry.disposed || entry.runtime.disposed || original(entry.ctx.get('agents')) !== agents || original(entry.ctx.get('sessions')) !== sessions || original(entry.ctx.get('llm')) !== llm || original(entry.ctx.get('whaleMemory')) !== original(entry.provider)) fail('MEMORY_MAINTENANCE_SERVICE_CHANGED')
      entry.runtime.memoryProvider.assertAvailable()
      const activity = entry.runtime.memoryMaintenanceState()
      if (!Number.isSafeInteger(activity.pending_work) || activity.pending_work < 0 || typeof activity.reflection_running !== 'boolean') fail('MEMORY_MAINTENANCE_COVERAGE_UNVERIFIED')
      pending += activity.pending_work; running ||= activity.reflection_running
      if (!entry.port) fail('MEMORY_MAINTENANCE_COVERAGE_UNVERIFIED')
    }
    for (const agent of all) {
      const owners = related(group, agent), mirror = bound.get(agent.id)
      if (!owners.length && !mirror) continue
      if (!owners.length) fail('MEMORY_MAINTENANCE_UNKNOWN_BOUND_AGENT')
      if (owners.length !== 1) fail('MEMORY_MAINTENANCE_AGENT_OWNER_AMBIGUOUS')
      const entry = owners[0], session = agent.session
      if (agents.get(agent.id) !== agent || sessions.get(agent.id) !== session || session?.id !== agent.id || original(agent.ctx.get('agents')) !== agents || original(agent.ctx.get('sessions')) !== sessions || typeof agent.runMaintenance !== 'function') fail('MEMORY_MAINTENANCE_COVERAGE_UNVERIFIED')
      const chain = entry.scopeChainOf(agent)
      if (!Array.isArray(chain) || chain[0] !== agent || chain.length < 2) fail('MEMORY_MAINTENANCE_SCOPE_CHANGED')
      if (!['idle', 'running'].includes(agent.status)) fail('MEMORY_MAINTENANCE_COVERAGE_UNVERIFIED')
      const nextTurn = agent.inbox?.nextTurn, nextStep = agent.inbox?.nextStep, inbox = projections.stateOf(session, 'inbox')
      if (!Array.isArray(nextTurn) || !Array.isArray(nextStep) || !Array.isArray(inbox?.['next-turn']) || !Array.isArray(inbox?.['next-step']) || nextTurn.length !== inbox['next-turn'].length || nextStep.length !== inbox['next-step'].length) fail('MEMORY_MAINTENANCE_INBOX_UNVERIFIED')
      if (fences) entry.runtime.checkSession(agent)
      queued += nextTurn.length + nextStep.length; inflight += streams.get(agent) ?? 0; running ||= agent.status === 'running'
      members.push({ agent, session, entry, signature: [agent.id, objectId(agent), objectId(session), objectId(session.header), session.seq, chain.map(objectId), agent.status, nextTurn.map((item) => item.id), nextStep.map((item) => item.id), streams.get(agent) ?? 0] })
      bound.delete(agent.id)
    }
    for (const [sessionId] of bound) {
      const session = sessions.get(sessionId)
      // Historical unloaded sessions are not live in this host. This says
      // nothing about a second process; that deployment remains unsupported.
      if (!session) continue
      const inbox = projections.stateOf(session, 'inbox'), turn = projections.stateOf(session, 'turnBoundary')
      if (!Array.isArray(inbox?.['next-turn']) || !Array.isArray(inbox?.['next-step']) || !turn || turn.openTurnStartSeq !== null) fail('MEMORY_MAINTENANCE_UNKNOWN_BOUND_SESSION')
      queued += inbox['next-turn'].length + inbox['next-step'].length
      passive.push([sessionId, objectId(session), session.seq, inbox['next-turn'].map((item) => item.id), inbox['next-step'].map((item) => item.id)])
    }
    members.sort((a, b) => a.agent.id.localeCompare(b.agent.id))
    const writerPorts = [...new Set([...group.entries].map((entry) => entry.port).filter(Boolean).concat(discoverMaintenanceWriterPorts({ root: group.root, memory_space_id: group.spaceId })))]
    const owners = new Set(group.entries)
    const writerState = writerPorts.map((port) => {
      const snapshot = port.snapshot({ root: group.root, memory_space_id: group.spaceId })
      if (snapshot.protocol_version !== '1.0.0' || !Array.isArray(snapshot.writers)) fail('MEMORY_MAINTENANCE_COVERAGE_UNVERIFIED')
      for (const writer of snapshot.writers) if (!writer.retired && (!writer.admitted || !owners.has(writer.owner) || writer.host !== host)) fail('MEMORY_MAINTENANCE_UNKNOWN_WRITER')
      return [objectId(port), snapshot.generation]
    })
    return { members, writerPorts, queued: queued + pending, inflight, running, signature: digest({ members: members.map((member) => member.signature), passive, writers: writerState, bindings: bindings ? digest(bindings) : null, pending, running }) }
  }
  const getActivity = (group, entry) => {
    const active = group.active
    if (!active || active.entry !== entry) fail('HOST_MAINTENANCE_REQUIRED')
    if (active.epoch !== group.epoch) fail('HOST_ACTIVITY_CHANGED')
    for (const lease of active.leases) lease.check()
    const view = collect(group)
    if (view.signature !== active.signature) fail('HOST_ACTIVITY_CHANGED')
    return { scope_coverage: 'memory_space', ...entry.runtime.state.identity, epoch: group.epoch, idle_since: new Date(group.idleSince).toISOString(), running: view.running,
      disposed: disposed || entry.disposed || entry.runtime.disposed, queued_inputs: view.queued, inflight_requests: view.inflight }
  }
  const schedule = (group) => {
    if (disposed || group.invalid || group.active || group.preparing || ![...group.entries].some((entry) => entry.automatic)) return
    const enabled = [...group.entries].filter((entry) => entry.automatic)
    if (new Set(enabled.map((entry) => digest(entry.policy))).size > 1) { clearTimeout(group.timer); group.timer = null; group.lastReason = 'MEMORY_MAINTENANCE_POLICY_CONFLICT'; return }
    if (group.timer) return
    const interval = Math.min(...enabled.map((entry) => entry.interval))
    group.timer = setTimeout(() => {
      group.timer = null
      const entry = [...group.entries].find((candidate) => candidate.automatic && agents.list().some((agent) => candidate.ownsAgent(agent) === true))
      const agent = entry && agents.list().filter((agent) => entry.ownsAgent(agent) === true).sort((a, b) => a.id.localeCompare(b.id))[0]
      const task = entry && agent ? run(entry, agent, {}) : Promise.resolve({ status: 'skipped', reason_code: 'NO_LIVE_MAINTENANCE_AGENT' })
      task.then((result) => { group.lastReason = result.reason_code ?? result.status }).catch((error) => { group.lastReason = safeCode(error) }).finally(() => schedule(group))
    }, interval)
    group.timer.unref?.()
  }
  const run = async (entry, agent, { force = false, signal } = {}) => {
    const group = entry.group; let preparing = false, ticket
    try {
      if (typeof force !== 'boolean' || disposed || entry.disposed || entry.runtime.disposed) fail('MEMORY_MAINTENANCE_UNAVAILABLE')
      if (group.active || group.preparing) return { status: 'busy', reason_code: 'MEMORY_MAINTENANCE_BUSY' }
      let finish
      ticket = { done: new Promise((resolve) => { finish = resolve }), finish: () => finish() }
      group.preparing = ticket; preparing = true
      if (entry.ownsAgent(agent) !== true || agents.get(agent.id) !== agent) fail('LIVE_AGENT_REQUIRED')
      const initial = collect(group, { fences: false })
      if (!initial.members.length || initial.members.some((member) => member.agent.status !== 'idle') || initial.queued || initial.inflight || initial.running) fail('HOST_NOT_IDLE')
      for (const member of initial.members) await member.entry.runtime.confirmSession(member.agent)
      const view = collect(group)
      if (initial.members.length !== view.members.length || initial.members.some((member, index) => member.agent !== view.members[index].agent || member.session !== view.members[index].session || member.entry !== view.members[index].entry)) fail('HOST_ACTIVITY_CHANGED')
      if (Date.now() - group.idleSince < entry.policy.idleMs || view.running || view.queued || view.inflight) fail('HOST_NOT_IDLE')
      if (signal?.aborted) fail('MAINTENANCE_CANCELLED')
      const active = { entry, controller: new AbortController(), epoch: group.epoch, signature: view.signature, leases: [], done: ticket.done }
      group.active = active; group.preparing = false; preparing = false; clearTimeout(group.timer); group.timer = null
      const release = () => { for (const lease of active.leases.slice().reverse()) lease.release(); active.leases.length = 0 }
      try {
        // Every provider lease is acquired synchronously before any idle claim.
        for (const port of view.writerPorts.sort((a, b) => objectId(a) - objectId(b))) {
          const lease = port.acquire({ root: group.root, memory_space_id: group.spaceId, owners: new Set(group.entries), host })
          if (!lease || typeof lease.then === 'function' || !lease.signal || ['check', 'run', 'release', 'cancel', 'issueContext'].some((name) => typeof lease[name] !== 'function')) fail('MEMORY_MAINTENANCE_COVERAGE_UNVERIFIED')
          active.leases.push(lease)
        }
        const signals = [active.controller.signal, ...(signal ? [signal] : []), ...active.leases.map((lease) => lease.signal)]
        const body = async () => {
          const combined = AbortSignal.any(signals), cancel = () => { for (const lease of active.leases) lease.cancel() }
          combined.addEventListener('abort', cancel, { once: true })
          try {
            if (combined.aborted) fail('MAINTENANCE_CANCELLED')
            // Locate by provider identity rather than relying on sort order.
            const index = active.leasePorts.indexOf(entry.port), ownerLease = active.leases[index]
            if (!ownerLease) fail('MEMORY_MAINTENANCE_COVERAGE_UNVERIFIED')
            const ctx = ownerLease.issueContext(entry.runtime.store, { ...entry.runtime.state.identity, session_id: agent.session.id, capabilities: ['memory.manage'] })
            return await entry.service.runOnce({ force }, ctx, { signal: combined })
          } finally { combined.removeEventListener('abort', cancel); release() }
        }
        active.leasePorts = view.writerPorts
        let task = body
        for (const member of view.members.slice().reverse()) {
          const next = task
          task = () => {
            try { return member.agent.runMaintenance(async (claimSignal) => { signals.push(claimSignal); return next() }) }
            catch { fail('MEMORY_MAINTENANCE_AGENT_BUSY') }
          }
        }
        let claimed = task
        for (const lease of active.leases.slice().reverse()) { const next = claimed; claimed = () => lease.run(next) }
        return await claimed()
      } finally { release(); if (group.active === active) group.active = null; schedule(group) }
    } catch (error) { return failure(error) }
    finally { if (preparing) { group.preparing = false; schedule(group) } ticket?.finish() }
  }
  const streamDispose = llm.ctx.on('llm/stream', (options, next) => {
    const agent = options.sessionId ? agents.get(options.sessionId) : null
    const affected = agent ? [...groups.values()].filter((group) => related(group, agent).length || boundTo(group, agent.id)) : []
    if (!affected.length) return next()
    return (async function* () {
      streams.set(agent, (streams.get(agent) ?? 0) + 1)
      for (const group of affected) bump(group, 'llm-stream-start')
      let iterator, ended = false
      try {
        const stream = await next(); iterator = stream[Symbol.asyncIterator]()
        while (true) { const item = await iterator.next(); if (item.done) { ended = true; return } yield item.value }
      } finally {
        try { if (iterator && !ended) await iterator.return?.() }
        finally { streams.set(agent, Math.max(0, (streams.get(agent) ?? 1) - 1)); for (const group of affected) bump(group, 'llm-stream-end') }
      }
    })()
  })
  const disposers = [streamDispose,
    host.on('agent/created', ({ agent }) => changed(agent, 'agent-created'), { global: true }),
    host.on('agent/disposed', ({ agent }) => changed(agent, 'agent-disposed'), { global: true }),
    host.on('agent/status', ({ agent }) => changed(agent, 'agent-status'), { global: true }),
    host.on('session/event', (session) => { const agent = agents.get(session.id); if (agent) changed(agent, 'session-event'); else for (const group of groups.values()) if (boundTo(group, session.id)) bump(group, 'bound-session-event') }, { global: true }),
    host.on('session/disposed', (session) => { for (const group of groups.values()) if (boundTo(group, session.id)) bump(group, 'session-disposed') }, { global: true }),
    host.on('internal/service', () => { for (const group of groups.values()) if (!currentServices() || [...group.entries].some((entry) => original(entry.ctx.get('whaleMemory')) !== original(entry.provider))) { group.invalid = true; clearTimeout(group.timer); group.timer = null; bump(group, 'service-changed') } }, { global: true }),
  ]
  const stopCatalog = observeMaintenanceWriterPorts((port) => {
    if (ports.has(port)) return
    let stop
    try { stop = port.subscribe((event) => { for (const group of groups.values()) if (event.root === group.root && event.memory_space_id === group.spaceId) bump(group, event.reason) }) }
    catch (error) { if (error.code === 'MEMORY_PROVIDER_UNAVAILABLE') return; throw error }
    ports.add(port); portDisposers.push(stop)
    for (const group of groups.values()) bump(group, 'provider-created')
  })
  manager = { host, groups, run,
    register(entry) {
      const root = maintenanceRoot(entry.runtime.store.root), spaceId = entry.runtime.store.memorySpaceId, key = `${root}\0${spaceId}`
      let group = groups.get(key)
      if (!group) groups.set(key, group = { root, spaceId, entries: new Set(), epoch: 0, idleSince: Date.now(), active: null, timer: null, invalid: false, lastReason: null })
      entry.id = ++serial; entry.group = group; group.entries.add(entry)
      try { entry.port = assertMaintenanceWriterPort(entry.provider); entry.retire = entry.port.admitStore(entry.runtime.store, { owner: entry, host, isCurrent: () => !entry.disposed && !entry.runtime.disposed && currentServices() && original(entry.ctx.get('whaleMemory')) === original(entry.provider) }) }
      catch (error) { if (error.code !== 'MEMORY_MAINTENANCE_COVERAGE_UNVERIFIED') { group.entries.delete(entry); throw error } entry.port = null }
      try { entry.service = new MemoryMaintenance({ store: entry.runtime.store, getActivity: () => getActivity(group, entry), ...entry.policy }) }
      catch (error) { entry.disposed = true; entry.retire?.(); group.entries.delete(entry); if (!group.entries.size) groups.delete(key); throw error }
      bump(group, 'runtime-registered'); schedule(group)
      return { notify: (reason = 'runtime-work') => bump(group, reason),
        run: (agent, args) => run(entry, agent, args),
        status: () => ({ boundary: 'single-host-process', automatic: [...group.entries].some((candidate) => candidate.automatic), timer_active: !!group.timer, running: !!group.active, registered_runtimes: group.entries.size, reason_code: group.invalid ? 'MEMORY_MAINTENANCE_SERVICE_CHANGED' : new Set([...group.entries].filter((candidate) => candidate.automatic).map((candidate) => digest(candidate.policy))).size > 1 ? 'MEMORY_MAINTENANCE_POLICY_CONFLICT' : group.lastReason }),
        async dispose() { if (entry.disposed) return; const running = group.active ?? group.preparing; entry.disposed = true; bump(group, 'runtime-disposed'); entry.retire?.(); group.entries.delete(entry); await entry.service.dispose(); if (running?.done) await running.done; if (!group.entries.size) { clearTimeout(group.timer); group.timer = null; groups.delete(key) } else schedule(group) },
      }
    } }
  managers.set(host, manager)
  host.effect(() => async () => { disposed = true; stopCatalog(); for (const dispose of portDisposers) dispose(); for (const dispose of disposers) dispose(); for (const group of groups.values()) { clearTimeout(group.timer); group.timer = null; group.active?.controller.abort() } await Promise.allSettled([...groups.values()].map((group) => (group.active ?? group.preparing)?.done).filter(Boolean)) }, 'whale-soul.memory-maintenance-host()')
  return manager
}

export function installMemoryMaintenanceHost(ctx, { runtime, ownsAgent, scopeChainOf, config = {} } = {}) {
  if (!runtime?.store || !runtime?.state || typeof runtime.memoryMaintenanceState !== 'function' || typeof ownsAgent !== 'function' || typeof scopeChainOf !== 'function') fail('TRUSTED_MAINTENANCE_HOST_REQUIRED')
  const interval = config.memoryMaintenanceCheckIntervalMs ?? 60000
  if (!Number.isSafeInteger(interval) || interval < 1 || interval > 3600000) fail('INVALID_MAINTENANCE_POLICY')
  const manager = managerFor(ctx), entry = { ctx, runtime, ownsAgent, scopeChainOf, provider: runtime.memoryProvider, policy: policyOf(config), automatic: config.autoMemoryMaintenance === true, interval, disposed: false }
  const registration = Object.freeze(manager.register(entry)); registrations.add(registration); return registration
}

export const isMemoryMaintenanceHost = (value) => registrations.has(value)
