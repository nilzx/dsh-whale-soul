const DEFAULT_SYSTEM = `You are the host's independent memory repair Agent.
Use the available tools to inspect the staged memory and read the current specification before repairing the data organization and format. The tools may accept a normalized snapshot instead of direct file edits. The original memory and plugin code are read-only. Access data only through the provided tools.
Preserve the original factual text, experiences, record IDs, ownership, personality growth, purge state and provenance wherever present. Do not guess unknown or missing material, turn old facts into new personality growth, or put repair instructions, diagnostics, reports, permissions or operational metadata into memory prose. Rebuild structural metadata from preserved material where required.
Validate your work. If validation fails, inspect the errors and continue repairing. Do not ask the user to repair files, run commands, migrate data or make technical decisions. The host will retry unfinished work automatically.`

const text = value => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value ?? null) }]
const errorValue = error => ({ error: typeof error?.code === 'string' ? error.code : 'REPAIR_TOOL_FAILED',
  message: typeof error?.message === 'string' ? error.message : 'The operation did not complete.' })
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function wait(value, signal) {
  if (!signal) return Promise.resolve(value)
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason ?? new Error('Repair cancelled')) }
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(value).then(result => { signal.removeEventListener('abort', abort); resolve(result) },
      error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}

function callDeadline(signal, timeoutMs) {
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason ?? new Error('Repair cancelled'))
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('Memory repair model call timed out')), timeoutMs)
  return { signal: controller.signal, dispose() { clearTimeout(timer); signal?.removeEventListener('abort', abort) } }
}

/** An auxiliary tool loop; it never registers a user Agent or owns filesystem access. */
export async function runMemoryRepairAgent({ llm, resolveRoute, createAssembler, createUserMessage,
  createToolResultMessage, tools, system = DEFAULT_SYSTEM, signal, maxTurns = 12, callTimeoutMs = 60_000 } = {}) {
  if (typeof llm?.prepareCall !== 'function' || typeof resolveRoute !== 'function' || typeof createAssembler !== 'function' ||
    typeof createUserMessage !== 'function' || typeof createToolResultMessage !== 'function' || !plain(tools) ||
    !Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 64 || !Number.isSafeInteger(callTimeoutMs) || callTimeoutMs < 1) throw new TypeError('Memory repair host bindings are required')
  const schemas = Object.entries(tools).map(([name, tool]) => ({ name, description: tool.description ?? name,
    parameters: tool.schema ?? { type: 'object', properties: {}, additionalProperties: false } }))
  const feedback = value => createUserMessage({ content: text(value),
    source: { kind: 'whale-soul-memory-repair', form: 'notice', summary: 'Automatic memory repair feedback' } })
  const messages = [feedback('Inspect the staged memory using the current specification, repair it, and validate the result.')]
  let turns = 0
  try {
    while (turns < maxTurns) {
      signal?.throwIfAborted()
      const call = callDeadline(signal, callTimeoutMs)
      let prepared, assembler, finishSeen = false
      try {
        const route = await wait(resolveRoute({ signal: call.signal }), call.signal)
        prepared = await wait(llm.prepareCall({ provider: route.provider, model: route.model, maxTokens: 8192,
          ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }) }, call.signal), call.signal)
        assembler = createAssembler()
        const request = { ...prepared.config, system, messages: [...messages], tools: schemas, signal: call.signal }
        const iterator = prepared.stream(request)[Symbol.asyncIterator]()
        let ended = false
        turns++
        try {
          for (;;) {
            const item = await wait(iterator.next(), call.signal)
            call.signal.throwIfAborted()
            if (item.done) { ended = true; break }
            if (item.value?.type === 'finish') finishSeen = true
            assembler.push(item.value)
          }
        } finally {
          if (!ended && typeof iterator.return === 'function') Promise.resolve(iterator.return()).catch(() => {})
        }
      } finally { call.dispose() }
      if (!finishSeen || !['stop', 'tool-calls'].includes(assembler.finish?.kind)) return { status: 'pending', turns }
      const message = assembler.message({ provider: prepared.config.provider, model: prepared.config.model,
        ...(assembler.replayState === undefined ? {} : { replayState: assembler.replayState }) })
      messages.push(message)
      const calls = message.content.filter(block => block.type === 'tool-call')
      if (calls.length) {
        for (const call of calls) {
          signal?.throwIfAborted()
          let value, isError = false
          try {
            if (!Object.hasOwn(tools, call.name) || typeof tools[call.name].execute !== 'function') throw Object.assign(new Error('Unknown repair tool'), { code: 'UNKNOWN_REPAIR_TOOL' })
            const args = JSON.parse(call.arguments)
            if (!plain(args)) throw Object.assign(new Error('Tool arguments must be a JSON object'), { code: 'INVALID_REPAIR_ARGUMENTS' })
            // Drain a started staged mutation before the coordinator may retry.
            value = await tools[call.name].execute(args)
            signal?.throwIfAborted()
          } catch (error) { signal?.throwIfAborted(); value = errorValue(error); isError = true }
          messages.push(createToolResultMessage({ callId: call.id, content: text(value), isError }))
        }
        continue
      }
      if (assembler.finish.kind !== 'stop') { messages.push(feedback({ error: 'REPAIR_TOOL_CALL_MISSING' })); continue }
      if (typeof tools.validate_current?.execute !== 'function') return { status: 'completed', turns }
      let validation
      try { validation = await tools.validate_current.execute({}) }
      catch (error) { signal?.throwIfAborted(); validation = { valid: false, errors: [errorValue(error)] } }
      signal?.throwIfAborted()
      if (validation?.valid === true) return { status: 'completed', turns }
      messages.push(feedback({ instruction: 'Validation failed. Repair these errors and validate again.', validation }))
    }
  } catch {
    // The coordinator retains the staged data and schedules the next attempt.
  }
  return { status: 'pending', turns }
}
