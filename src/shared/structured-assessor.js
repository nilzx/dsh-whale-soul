import { MemoryError } from '../memory/v2/contracts.js'

export class PersonaAssessmentError extends MemoryError {
  constructor(code) { super(code); this.name = 'PersonaAssessmentError' }
}

// Keep the historical error constructor and name for existing host adapters.
export { PersonaAssessmentError as StructuredAssessmentError }

const fail = (code) => new PersonaAssessmentError(code)
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
function freezeJson(value) {
  if (plain(value) || Array.isArray(value)) {
    Object.values(value).forEach(freezeJson)
    Object.freeze(value)
  }
  return value
}
function boundedString(value, maximum, code, { trim = false } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || !value.isWellFormed()) throw fail(code)
  return trim ? value.trim() : value
}
function positive(value, maximum, code) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw fail(code)
  return value
}
function only(value, fields) {
  if (!plain(value) || Object.keys(value).some((key) => !fields.includes(key))) throw fail('ASSESSOR_INVALID_INPUT')
}

function assertUniqueJsonKeys(raw) {
  let offset = 0
  const whitespace = () => { while (/\s/.test(raw[offset] ?? '') && offset < raw.length) offset++ }
  const string = () => {
    const start = offset++
    while (offset < raw.length) {
      const character = raw[offset++]
      if (character === '\\') offset++
      else if (character === '"') return JSON.parse(raw.slice(start, offset))
    }
    throw fail('ASSESSOR_INVALID_JSON')
  }
  const value = (depth = 0) => {
    if (depth > 32) throw fail('ASSESSOR_INVALID_VERDICT')
    whitespace()
    if (raw[offset] === '"') { string(); return }
    if (raw[offset] === '{') {
      const keys = new Set()
      offset++; whitespace()
      if (raw[offset] === '}') { offset++; return }
      while (offset < raw.length) {
        whitespace()
        const key = string()
        if (keys.has(key)) throw fail('ASSESSOR_DUPLICATE_JSON_KEY')
        keys.add(key)
        whitespace(); offset++
        value(depth + 1); whitespace()
        if (raw[offset++] === '}') return
      }
    } else if (raw[offset] === '[') {
      offset++; whitespace()
      if (raw[offset] === ']') { offset++; return }
      while (offset < raw.length) {
        value(depth + 1); whitespace()
        if (raw[offset++] === ']') return
      }
    } else while (offset < raw.length && !/[\s,}\]]/.test(raw[offset])) offset++
  }
  value()
}

function parseVerdict(raw, validateVerdict) {
  let value
  try { value = JSON.parse(raw) } catch { throw fail('ASSESSOR_INVALID_JSON') }
  if (!plain(value)) throw fail('ASSESSOR_INVALID_VERDICT')
  assertUniqueJsonKeys(raw)
  return validateVerdict(value)
}

function resolveControls(options) {
  const hasProvider = options.provider !== undefined
  if (hasProvider !== (options.model !== undefined)) throw fail('ASSESSOR_ROUTE_PAIR_REQUIRED')
  if (options.reasoningEffort !== undefined) boundedString(options.reasoningEffort, 128, 'ASSESSOR_INVALID_REASONING')
  return Object.freeze({
    timeoutMs: positive(options.timeoutMs ?? 15_000, 60_000, 'ASSESSOR_INVALID_TIMEOUT'),
    maxInputUtf16: positive(options.maxInputUtf16 ?? 16_000, 64_000, 'ASSESSOR_INVALID_INPUT_BUDGET'),
    maxInputBytes: positive(options.maxInputBytes ?? 64_000, 256_000, 'ASSESSOR_INVALID_INPUT_BUDGET'),
    maxOutputTokens: positive(options.maxOutputTokens ?? 512, 2048, 'ASSESSOR_INVALID_OUTPUT_BUDGET'),
    maxOutputUtf16: positive(options.maxOutputUtf16 ?? 2048, 8192, 'ASSESSOR_INVALID_OUTPUT_BUDGET'),
    maxStreamUtf16: positive(options.maxStreamUtf16 ?? 16_000, 64_000, 'ASSESSOR_INVALID_OUTPUT_BUDGET'),
    maxStreamChunks: positive(options.maxStreamChunks ?? 4096, 8192, 'ASSESSOR_INVALID_OUTPUT_BUDGET'),
    ...(hasProvider ? { provider: boundedString(options.provider, 256, 'ASSESSOR_INVALID_ROUTE', { trim: true }),
      model: boundedString(options.model, 256, 'ASSESSOR_INVALID_ROUTE', { trim: true }) } : {}),
    ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
  })
}

function deadline(signals, timeoutMs) {
  const controller = new AbortController()
  const removers = []
  const supplied = signals.filter((signal) => signal !== undefined)
  for (const signal of supplied) {
    if (!signal || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function' || typeof signal.aborted !== 'boolean') throw fail('ASSESSOR_INVALID_SIGNAL')
  }
  for (const signal of supplied) {
    const abort = () => controller.abort(fail('ASSESSOR_CANCELLED'))
    if (signal.aborted) abort()
    else { signal.addEventListener('abort', abort, { once: true }); removers.push(() => signal.removeEventListener('abort', abort)) }
  }
  const timer = setTimeout(() => controller.abort(fail('ASSESSOR_TIMEOUT')), timeoutMs)
  let reject
  const aborted = new Promise((_resolve, refuse) => { reject = refuse })
  const abort = () => reject(controller.signal.reason)
  if (controller.signal.aborted) abort()
  else controller.signal.addEventListener('abort', abort, { once: true })
  return { controller, signal: controller.signal, aborted,
    dispose() { clearTimeout(timer); removers.forEach((remove) => remove()); controller.signal.removeEventListener('abort', abort) } }
}

async function routeFor(options, controls, signal) {
  const agent = typeof options.getAgent === 'function' ? await options.getAgent() : options.agent
  let route
  if (controls.provider) route = controls
  else if (typeof options.resolveRoute === 'function') route = await options.resolveRoute({ signal })
  else route = agent?.session?.requestHeader?.()?.config ?? agent?.options
  if (!route) throw fail('ASSESSOR_ROUTE_UNAVAILABLE')
  return { provider: boundedString(route.provider, 256, 'ASSESSOR_INVALID_ROUTE', { trim: true }),
    model: boundedString(route.model, 256, 'ASSESSOR_INVALID_ROUTE', { trim: true }),
    ...(typeof agent?.session?.id === 'string' ? { sessionId: agent.session.id } : {}) }
}

function preparedConfig(prepared, route, controls) {
  const config = prepared?.config
  if (!plain(config) || config.provider !== route.provider || config.model !== route.model ||
    Object.keys(config).some((key) => !['provider', 'model', 'maxTokens', 'reasoningEffort', 'temperature', 'stop'].includes(key))) throw fail('ASSESSOR_INVALID_PREPARED_CALL')
  positive(config.maxTokens, controls.maxOutputTokens, 'ASSESSOR_INVALID_PREPARED_CALL')
  return { ...config }
}

/**
 * Shared one-shot engine for host-owned semantic assessment schemas. The
 * projector, validator, prompt, route and services are trusted factory inputs,
 * never model parameters. No tools, tool history, conversation replay, logging,
 * file writes or local retries are performed here. Host LLM retry middleware
 * remains bounded by the same signal. A non-cooperative adapter cannot produce
 * an accepted late verdict after the deadline.
 */
export function createStructuredAssessor(options = {}) {
  if (typeof options.llm?.prepareCall !== 'function' || typeof options.createAssembler !== 'function' ||
    typeof options.projectInput !== 'function' || typeof options.validateVerdict !== 'function') throw fail('ASSESSOR_HOST_ADAPTERS_REQUIRED')
  const controls = resolveControls(options)
  const system = boundedString(options.system, 16_000, 'ASSESSOR_SYSTEM_REQUIRED')
  const llm = options.llm
  const createAssembler = options.createAssembler
  const projectInput = options.projectInput
  const validateVerdict = options.validateVerdict
  const routeOptions = { agent: options.agent, getAgent: options.getAgent, resolveRoute: options.resolveRoute }
  const lifetimeSignal = options.signal

  return async (input, hostCall = {}) => {
    only(hostCall, ['signal'])
    const call = deadline([lifetimeSignal, hostCall.signal], controls.timeoutMs)
    let iterator, completed = false
    const operation = async () => {
      call.signal.throwIfAborted()
      const projected = projectInput(input)
      if (typeof projected?.then === 'function') throw fail('ASSESSOR_INVALID_INPUT')
      let body
      try { body = JSON.stringify(projected) } catch { throw fail('ASSESSOR_INVALID_INPUT') }
      if (typeof body !== 'string') throw fail('ASSESSOR_INVALID_INPUT')
      const inputUnits = system.length + body.length
      const inputBytes = Buffer.byteLength(system, 'utf8') + Buffer.byteLength(body, 'utf8')
      if (inputUnits > controls.maxInputUtf16 || inputBytes > controls.maxInputBytes) throw fail('ASSESSOR_INPUT_BUDGET_EXCEEDED')
      const route = await routeFor(routeOptions, controls, call.signal)
      call.signal.throwIfAborted()
      const prepared = await llm.prepareCall({ provider: route.provider, model: route.model, maxTokens: controls.maxOutputTokens }, call.signal,
        (config, model) => {
          const effort = controls.reasoningEffort ?? model.reasoning?.efforts?.[0]?.id
          return { ...config, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
        })
      call.signal.throwIfAborted()
      if (typeof prepared?.stream !== 'function') throw fail('ASSESSOR_INVALID_PREPARED_CALL')
      const request = freezeJson({ ...preparedConfig(prepared, route, controls),
        system, messages: [{ role: 'user', content: [{ type: 'text', text: body }] }], tools: [],
        ...(route.sessionId === undefined ? {} : { sessionId: route.sessionId }), signal: call.signal })
      const assembler = createAssembler()
      if (typeof assembler?.push !== 'function' || typeof assembler?.blocks !== 'function') throw fail('ASSESSOR_INVALID_ASSEMBLER')
      const stream = prepared.stream(request)
      if (typeof stream?.[Symbol.asyncIterator] !== 'function') throw fail('ASSESSOR_INVALID_STREAM')
      iterator = stream[Symbol.asyncIterator]()
      let finishSeen = false, streamedUnits = 0, chunkCount = 0
      const textByIndex = new Map()
      const blocksSeen = new Set()
      while (true) {
        call.signal.throwIfAborted()
        const item = await iterator.next()
        call.signal.throwIfAborted()
        if (item.done) { completed = true; break }
        const chunk = item.value
        if (++chunkCount > controls.maxStreamChunks) throw fail('ASSESSOR_OUTPUT_BUDGET_EXCEEDED')
        if (!plain(chunk) || typeof chunk.type !== 'string' || (finishSeen && chunk.type !== 'usage')) throw fail('ASSESSOR_INVALID_STREAM')
        if (['block-start', 'block-end', 'text-delta', 'reasoning-delta'].includes(chunk.type)) {
          if (!Number.isSafeInteger(chunk.index) || chunk.index < 0 || chunk.index > 1023) throw fail('ASSESSOR_INVALID_STREAM')
          blocksSeen.add(chunk.index)
          if (blocksSeen.size > 16) throw fail('ASSESSOR_OUTPUT_BUDGET_EXCEEDED')
        }
        if (chunk.type === 'tool-call-delta' || chunk.blockType === 'tool-call' || chunk.block?.type === 'tool-call') throw fail('ASSESSOR_TOOL_OUTPUT_FORBIDDEN')
        if (chunk.type === 'finish') {
          if (chunk.reason?.kind !== 'stop') throw fail('ASSESSOR_NONSTOP_FINISH')
          finishSeen = true
        } else if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
          if (typeof chunk.text !== 'string' || !Number.isSafeInteger(chunk.index) || chunk.index < 0) throw fail('ASSESSOR_INVALID_STREAM')
          streamedUnits += chunk.text.length
          if (chunk.type === 'text-delta') textByIndex.set(chunk.index, (textByIndex.get(chunk.index) ?? '') + chunk.text)
        } else if (chunk.type === 'block-end') {
          if (!['text', 'reasoning'].includes(chunk.block?.type) || typeof chunk.block.text !== 'string') throw fail('ASSESSOR_INVALID_STREAM')
          streamedUnits += chunk.block.text.length
          if (chunk.block.type === 'text') textByIndex.set(chunk.index, chunk.block.text)
        } else if (chunk.type === 'block-start') {
          if (!['text', 'reasoning'].includes(chunk.blockType)) throw fail('ASSESSOR_INVALID_STREAM')
        } else if (chunk.type !== 'usage') throw fail('ASSESSOR_INVALID_STREAM')
        if (streamedUnits > controls.maxStreamUtf16 || [...textByIndex.values()].reduce((size, text) => size + text.length, 0) > controls.maxOutputUtf16) throw fail('ASSESSOR_OUTPUT_BUDGET_EXCEEDED')
        // Hidden reasoning is neither accumulated nor returned by this adapter.
        if (chunk.type === 'reasoning-delta' || chunk.blockType === 'reasoning' || chunk.block?.type === 'reasoning' || chunk.type === 'usage') continue
        assembler.push(chunk)
      }
      if (!finishSeen || assembler.finish?.kind !== 'stop') throw fail('ASSESSOR_INCOMPLETE_STREAM')
      const blocks = assembler.blocks()
      if (blocks.some((block) => block.type !== 'text')) throw fail('ASSESSOR_TOOL_OUTPUT_FORBIDDEN')
      const raw = blocks.map((block) => block.text).join('').trim()
      if (!raw || raw.length > controls.maxOutputUtf16 || !raw.isWellFormed()) throw fail('ASSESSOR_INVALID_OUTPUT')
      call.signal.throwIfAborted()
      return parseVerdict(raw, validateVerdict)
    }
    try { return await Promise.race([operation(), call.aborted]) }
    catch (cause) {
      const rejected = cause instanceof PersonaAssessmentError ? cause : call.signal.aborted ? call.signal.reason : fail('ASSESSOR_PROVIDER_FAILURE')
      if (!call.signal.aborted) call.controller.abort(rejected)
      throw rejected
    } finally {
      call.dispose()
      if (iterator && !completed && typeof iterator.return === 'function') {
        try { Promise.resolve(iterator.return()).catch(() => {}) } catch {}
      }
    }
  }
}

