import test from 'node:test'
import assert from 'node:assert/strict'
import { createInjectedSurfaceController, INJECTED_CONTEXT_NAMES } from '../src/persona/injected-surface.js'

const own = new Set(INJECTED_CONTEXT_NAMES)
const joinContextSections = (sections) => sections.length
  ? `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${sections.map((section) => section.text).join('\n\n')}`
  : ''
const framed = (sections, intro = 'The following information describes your current session:') =>
  `<system-reminder>\n${intro}\n\n${sections.map((section) => section.text).join('\n\n')}\n</system-reminder>`
const freeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}
const snapshot = (sections, text, { id } = {}) => freeze({ role: 'user', id,
  source: { kind: 'runtime-context', form: 'snapshot', sections },
  content: [{ type: 'text', text }] })
const userText = (text) => freeze({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })

/** Minimal Session stand-in with the surface and append contract the controller checks. */
function fakeSession({ events = [], firstLiveSeq = 0 } = {}) {
  const log = [], nodes = []
  let clock = 1
  const append = (type, data, intent) => {
    const event = { type, seq: log.length, time: clock++, data }
    log.push(event)
    const surfaceOp = intent?.surfaceOp
    if (surfaceOp === 'append' || surfaceOp === undefined) nodes.push(event.seq)
    else if (surfaceOp?.op === 'replace') {
      const index = nodes.indexOf(surfaceOp.startSeq)
      if (index < 0) throw new Error('replace target is not a surface node')
      nodes[index] = event.seq
    } else throw new Error(`unsupported surface op ${JSON.stringify(surfaceOp)}`)
    return event
  }
  for (const event of events) append(event.type, event.data, { surfaceOp: 'append' })
  return {
    firstLiveSeq,
    log,
    eventAt: (seq) => log[seq],
    surface: { nodes },
    append,
  }
}

const controllerFor = (session, { live = () => true } = {}) => createInjectedSurfaceController({ session,
  checkBoundary: () => true, isAgentLoopRequest: (request) => request?.brand === 'agent-loop',
  createUserMessage: (input) => freeze({ role: 'user', ...input }), joinContextSections })

const requestFor = (messages) => freeze({ brand: 'agent-loop', messages: [...messages] })
const bindingsFor = (request, isCurrent = () => true) => request.messages
  .filter((message) => message.source?.kind === 'runtime-context')
  .flatMap((message) => message.source.sections.filter((section) => own.has(section.name))
    .map((section) => ({ message, section, isCurrent })))

test('SURFACE binds the reminder-framed snapshot the DSH 0.2.2 loop writes', () => {
  const sections = freeze([{ name: 'whale-soul:memory', text: '主人喜欢白桃乌龙茶' }, { name: 'fixture:other', text: 'OTHER_LITERAL' }])
  const message = snapshot(sections, framed(sections))
  const session = fakeSession({ events: [{ type: 'user/message', data: message }] })
  const controller = controllerFor(session)
  try {
    assert.notEqual(message.content[0].text, joinContextSections(sections))
    assert.equal(controller.bind(requestFor([message]), bindingsFor(requestFor([message]))), true)
  } finally { controller.dispose() }
})

test('SURFACE keeps accepting the earlier joinContextSections rendering of a restored snapshot', () => {
  const sections = freeze([{ name: 'whale-soul:growth', text: 'GROWTH_CONTEXT_CANARY' }])
  const message = snapshot(sections, joinContextSections(sections))
  const session = fakeSession({ events: [{ type: 'user/message', data: message }] })
  const controller = controllerFor(session)
  try { assert.equal(controller.bind(requestFor([message]), bindingsFor(requestFor([message]))), true) }
  finally { controller.dispose() }
})

test('SURFACE tolerates reworded host intros but never a body that disagrees with the sections', () => {
  const sections = freeze([{ name: 'whale-soul:memory', text: 'MEMORY_CANARY' }])
  for (const text of [
    framed(sections, 'The following information describes your current session. It replaces earlier versions of this context.'),
    framed(sections, 'Some future single-line intro'),
  ]) {
    const message = snapshot(sections, text)
    const session = fakeSession({ events: [{ type: 'user/message', data: message }] })
    const controller = controllerFor(session)
    try { assert.equal(controller.bind(requestFor([message]), bindingsFor(requestFor([message]))), true) }
    finally { controller.dispose() }
  }
  for (const text of [
    framed([{ name: 'whale-soul:memory', text: 'FORGED_BODY' }]),
    framed(sections).replace('</system-reminder>', '\n</system-reminder>'),
    framed(sections, 'Intro\n\nwith a blank line'),
    'MEMORY_CANARY',
    'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nFORGED_BODY',
  ]) {
    const message = snapshot(sections, text)
    const session = fakeSession({ events: [{ type: 'user/message', data: message }] })
    const controller = controllerFor(session)
    try { assert.throws(() => controller.bind(requestFor([message]), bindingsFor(requestFor([message]))), { code: 'INJECTED_SURFACE_UNVERIFIED' }) }
    finally { controller.dispose() }
  }
})

test('SURFACE cleanup rewrites only this plugin sections in the current host framing', () => {
  const sections = freeze([{ name: 'whale-soul:memory', text: 'REVOKED_CANARY' }, { name: 'fixture:other', text: 'OTHER_LITERAL' }])
  const message = snapshot(sections, framed(sections))
  const session = fakeSession({ events: [{ type: 'user/message', data: message }] })
  const controller = controllerFor(session)
  try {
    const request = requestFor([message])
    let live = true
    controller.bind(request, bindingsFor(request, () => live))
    live = false
    const original = JSON.stringify(session.eventAt(0))
    const result = controller.clean()
    assert.equal(result.status, 'clean')
    assert.equal(result.replaced_count, 1)
    assert.equal(result.unknown_count, 0)
    assert.deepEqual(result.replacements[0].sections, ['whale-soul:memory'])
    assert.equal(JSON.stringify(session.eventAt(0)), original)
    const current = session.eventAt(session.surface.nodes[0]).data
    assert.deepEqual(current.source.sections.map((section) => section.name), ['fixture:other'])
    assert.equal(current.source.sections[0].text, 'OTHER_LITERAL')
    assert.match(current.content[0].text, /^<system-reminder>\n/)
    assert.match(current.content[0].text, /OTHER_LITERAL\n<\/system-reminder>$/)
    assert.equal(controller.clean().replaced_count, 0)
  } finally { controller.dispose() }
})

test('SURFACE cleanup withdraws a restored legacy snapshot and still reports unknown history', () => {
  const legacySections = freeze([{ name: 'whale-soul:memory', text: 'OLD_CANARY' }])
  const legacy = snapshot(legacySections, joinContextSections(legacySections))
  const unknown = snapshot(freeze([{ name: 'whale-soul:growth', text: 'HAND_EDITED' }]), '<system-reminder>\nnot a host rendering\n</system-reminder>')
  const session = fakeSession({ firstLiveSeq: 2,
    events: [{ type: 'user/message', data: legacy }, { type: 'user/message', data: unknown }] })
  const controller = controllerFor(session)
  try {
    const result = controller.clean()
    assert.equal(result.unknown_count, 1)
    assert.equal(result.status, 'unverified_remains')
    assert.equal(result.replaced_count, 1)
    const current = session.eventAt(session.surface.nodes[0]).data
    assert.deepEqual(current.source.sections, [])
    assert.equal(current.content[0].text, '<system-reminder>\nCurrent runtime context: none. Earlier runtime-context snapshots no longer apply.\n</system-reminder>')
    assert.equal(JSON.stringify(session.eventAt(1)), JSON.stringify({ type: 'user/message', seq: 1, time: 2, data: unknown }))
  } finally { controller.dispose() }
})

test('SURFACE still refuses a live snapshot that this controller never bound', () => {
  const sections = freeze([{ name: 'whale-soul:memory', text: 'LIVE' }])
  const message = snapshot(sections, framed(sections))
  const session = fakeSession({ firstLiveSeq: 0, events: [{ type: 'user/message', data: message }] })
  const controller = controllerFor(session)
  try {
    const result = controller.clean()
    assert.equal(result.status, 'unverified_remains')
    assert.equal(result.unknown_count, 1)
    assert.equal(result.replaced_count, 0)
  } finally { controller.dispose() }
})
