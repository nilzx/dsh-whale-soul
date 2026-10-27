import { MemoryError, digest } from '../memory/v2/contracts.js'

export const INJECTED_CONTEXT_NAMES = Object.freeze(['whale-soul:memory', 'whale-soul:owner-reviewed-memory', 'whale-soul:growth', 'whale-soul:memory-operation'])
const own = new Set(INJECTED_CONTEXT_NAMES)
const fail = (code) => { throw new MemoryError(code) }
const same = (left, right) => digest(left) === digest(right)

/**
 * Host-only surface authority. A name/text match alone cannot register a row:
 * binding requires the exact official main envelope and active Session object.
 */
export function createInjectedSurfaceController({ session, checkBoundary, isAgentLoopRequest, createUserMessage, joinContextSections,
  maxTrackedMessages = 128, maxReplacements = 32 } = {}) {
  if (typeof session?.append !== 'function' || typeof session?.eventAt !== 'function' || !session?.surface ||
    typeof checkBoundary !== 'function' || typeof isAgentLoopRequest !== 'function' || typeof createUserMessage !== 'function' || typeof joinContextSections !== 'function') fail('INJECTED_SURFACE_BINDINGS_REQUIRED')
  if (!Number.isInteger(maxTrackedMessages) || maxTrackedMessages < 1 || maxTrackedMessages > 256 ||
    !Number.isInteger(maxReplacements) || maxReplacements < 1 || maxReplacements > 64) fail('INJECTED_SURFACE_INVALID_BUDGET')
  const tracked = new Map(), append = session.append
  let disposed = false, totalReplacements = 0
  const check = (signal) => {
    if (disposed) fail('INJECTED_SURFACE_DISPOSED')
    if (signal?.aborted) fail('INJECTED_SURFACE_CANCELLED')
    const decision = checkBoundary()
    if (decision && typeof decision.then === 'function') { Promise.resolve(decision).catch(() => {}); fail('INJECTED_SURFACE_ASYNC_BOUNDARY') }
    if (decision !== true) fail('INJECTED_SURFACE_BOUNDARY_CHANGED')
  }
  const nodes = () => [...session.surface.nodes]
  const current = (callback) => {
    const result = callback()
    if (result && typeof result.then === 'function') { Promise.resolve(result).catch(() => {}); fail('INJECTED_SURFACE_ASYNC_AUTHORITY') }
    if (typeof result !== 'boolean') fail('INJECTED_SURFACE_INVALID_AUTHORITY')
    return result
  }
  const exactMessage = (message) => message?.source?.kind === 'runtime-context' && message.source.form === 'snapshot' &&
    Array.isArray(message.source.sections) && message.content?.length === 1 && message.content[0].type === 'text' &&
    message.content[0].text === joinContextSections(message.source.sections)
  const activeMessages = () => {
    const found = new Map()
    for (const seq of nodes()) {
      const event = session.eventAt(seq)
      if (event?.type === 'user/message' && event.data.source?.kind === 'runtime-context') found.set(event.data, { seq, event })
    }
    return found
  }
  return Object.freeze({
    bind(request, bindings) {
      check()
      if (isAgentLoopRequest(request) !== true || !Object.isFrozen(request) || !Object.isFrozen(request.messages) ||
        !Array.isArray(bindings) || bindings.length > 256) fail('INJECTED_SURFACE_UNVERIFIED')
      const active = activeMessages(), activeSeqs = new Set(nodes())
      for (const seq of tracked.keys()) if (!activeSeqs.has(seq)) tracked.delete(seq)
      const groups = new Map()
      for (const binding of bindings) {
        const { message, section, isCurrent } = binding
        if (!request.messages.includes(message) || !exactMessage(message) || !Object.isFrozen(message) ||
          !Object.isFrozen(message.source.sections) || !Object.isFrozen(section) || !message.source.sections.includes(section) ||
          !own.has(section.name) || typeof isCurrent !== 'function' || current(isCurrent) !== true) fail('INJECTED_SURFACE_UNVERIFIED')
        const location = active.get(message)
        if (!location) fail('INJECTED_SURFACE_UNVERIFIED')
        let group = groups.get(location.seq)
        if (!group) groups.set(location.seq, group = { ...location, message, eventHash: digest(location.event), source: message.source, sections: new Map() })
        group.sections.set(section, isCurrent)
      }
      for (const group of groups.values()) if (group.message.source.sections.some((section) => own.has(section.name) && !group.sections.has(section))) fail('INJECTED_SURFACE_UNVERIFIED')
      if (new Set([...tracked.keys(), ...groups.keys()]).size > maxTrackedMessages) fail('INJECTED_SURFACE_TRACKING_BUDGET')
      check()
      for (const [seq, group] of groups) tracked.set(seq, group)
      return true
    },
    clean({ signal } = {}) {
      if (signal !== undefined && !(signal instanceof AbortSignal)) fail('INJECTED_SURFACE_INVALID_SIGNAL')
      check(signal)
      const initialNodes = nodes(), activeSeqs = new Set(initialNodes), plans = []
      let unknown = 0
      for (const seq of initialNodes) {
        const event = session.eventAt(seq)
        if (event?.type !== 'user/message' || event.data.source?.kind !== 'runtime-context' || !event.data.source.sections?.some((section) => own.has(section.name))) continue
        if (!tracked.has(seq)) unknown++
      }
      for (const [seq, entry] of tracked) {
        if (!activeSeqs.has(seq)) { tracked.delete(seq); continue }
        if (session.eventAt(seq) !== entry.event || entry.event.data !== entry.message || entry.message.source !== entry.source ||
          digest(entry.event) !== entry.eventHash || !exactMessage(entry.message)) fail('INJECTED_SURFACE_CHANGED')
        const removed = []
        for (const section of entry.message.source.sections) if (own.has(section.name)) {
          const authority = entry.sections.get(section)
          if (!authority) fail('INJECTED_SURFACE_UNVERIFIED')
          if (!current(authority)) removed.push(section)
        }
        if (!removed.length) continue
        const retained = entry.message.source.sections.filter((section) => !removed.includes(section))
        plans.push({ seq, entry, retained, removed })
      }
      if (plans.length > maxReplacements) fail('INJECTED_SURFACE_REPLACEMENT_BUDGET')
      check(signal)
      let expectedNodes = initialNodes
      const replaced = []
      for (const plan of plans) {
        check(signal)
        if (!same(nodes(), expectedNodes) || session.eventAt(plan.seq) !== plan.entry.event || digest(plan.entry.event) !== plan.entry.eventHash) fail('INJECTED_SURFACE_CHANGED')
        const text = joinContextSections(plan.retained) || 'Previous memory and growth sections from this plugin have been withdrawn.'
        const replacement = createUserMessage({ source: { ...plan.entry.source, sections: plan.retained }, content: [{ type: 'text', text }] })
        if (replacement?.role !== 'user' || replacement.source?.kind !== 'runtime-context' || !same(replacement.source.sections, plan.retained) ||
          replacement.content?.length !== 1 || replacement.content[0].type !== 'text' || replacement.content[0].text !== text) fail('INJECTED_SURFACE_REPLACEMENT_UNCONFIRMED')
        const event = Reflect.apply(append, session, ['user/message', replacement, {
          surfaceOp: { op: 'replace', startSeq: plan.seq, endSeq: plan.seq }, sourceEventSeqs: [plan.seq],
        }])
        expectedNodes = expectedNodes.map((seq) => seq === plan.seq ? event.seq : seq)
        if (!same(nodes(), expectedNodes) || digest(session.eventAt(plan.seq)) !== plan.entry.eventHash || event.data?.role !== 'user' ||
          event.data.source?.kind !== 'runtime-context' || !same(event.data.source.sections, plan.retained) ||
          event.data.content?.length !== 1 || event.data.content[0].type !== 'text' || event.data.content[0].text !== text) fail('INJECTED_SURFACE_REPLACEMENT_UNCONFIRMED')
        tracked.delete(plan.seq)
        totalReplacements++
        replaced.push(Object.freeze({ original_seq: plan.seq, replacement_seq: event.seq, sections: Object.freeze(plan.removed.map((section) => section.name)) }))
      }
      check(signal)
      return Object.freeze({ status: unknown ? 'unverified_remains' : 'clean', replaced_count: replaced.length, unknown_count: unknown, replacements: Object.freeze(replaced) })
    },
    status: () => Object.freeze({ disposed, tracked_messages: tracked.size, total_replacements: totalReplacements }),
    dispose() { disposed = true; tracked.clear() },
  })
}
