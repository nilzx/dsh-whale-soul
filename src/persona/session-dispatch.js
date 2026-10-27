import { MemoryError } from '../memory/v2/contracts.js'
import { sessionAuthorityEntry } from './session-fence.js'
import { installPreparedCallFacade } from './prepare-call-facade.js'

const managers = new WeakMap()
const original = (value) => value?.[Symbol.for('cordis.original')] ?? value
const fail = (code) => { throw new MemoryError(code, `${code}：当前会话的身份边界已变化，请新建会话后继续。`) }

/** Host lifetime registry; each replacement public service gets its own hooks. */
export function installSessionDispatch(ctx, { runtime, ownsAgent, scopeChainOf, resolveDshHome, isAgentLoopRequest, serviceTools } = {}) {
  const host = ctx.root, tools = original(ctx.get('tools')), llm = original(ctx.get('llm'))
  if (!host?.on || !tools?.ctx || !llm?.ctx || typeof ownsAgent !== 'function' || typeof scopeChainOf !== 'function' || typeof resolveDshHome !== 'function' || typeof isAgentLoopRequest !== 'function' || !Array.isArray(serviceTools)) fail('TRUSTED_SESSION_DISPATCH_REQUIRED')
  let manager = managers.get(host)
  if (!manager) {
    const registrations = new Set(), wrapped = new Map(), confirmedSessions = new Set(), toolInstances = new WeakSet(), llmInstances = new WeakSet()
    const candidates = (agent) => {
      const seen = new Set()
      return [...registrations].filter((entry) => !entry.runtime.disposed && entry.ownsAgent(agent) === true && !seen.has(entry.runtime) && (seen.add(entry.runtime), true))
    }
    const bound = (agent) => sessionAuthorityEntry(resolveDshHome(agent.ctx.get('profileContext')?.home), agent.session.id)
    const owner = (agent) => {
      const matches = candidates(agent)
      if (matches.length > 1) fail('SESSION_OWNER_AMBIGUOUS')
      if (!matches.length && (confirmedSessions.has(agent.session.id) || bound(agent))) fail('SESSION_OWNER_UNAVAILABLE')
      return matches[0]
    }
    const check = (agent) => {
      if (!agent) return
      const entry = owner(agent)
      if (entry) entry.runtime.checkSession(agent)
    }
    const clear = (agent) => {
      for (const entry of wrapped.get(agent)?.values() ?? []) entry.dispose()
      wrapped.delete(agent)
    }
    const wrap = (agent) => {
      clear(agent)
      const registration = owner(agent)
      if (!registration) return
      const service = original(agent.ctx.get('tools'))
      if (!toolInstances.has(service)) fail('SESSION_TOOL_SERVICE_CHANGED')
      const definitions = new Map(), chain = registration.scopeChainOf(agent)
      wrapped.set(agent, definitions)
      for (const name of registration.serviceTools) {
        const definition = service.get(name, agent)
        if (!definition) continue
        if (service.get(name, chain[1]) !== definition) fail('SESSION_TOOL_SCOPE_UNSUPPORTED')
        let entry
        const finalCheck = () => {
          if (original(agent.ctx.get('tools')) !== service) fail('SESSION_TOOL_SERVICE_CHANGED')
          check(agent)
        }
        const wrapper = { ...definition, async execute(args, exec) {
          if (exec.agent !== agent) fail('SESSION_TOOL_AGENT_CHANGED')
          finalCheck(); entry.dispose()
          let actual
          try { actual = service.get(name, agent) } finally { entry.dispose = agent.ctx.get('tools').register(wrapper) }
          if (actual !== definition) fail('SESSION_TOOL_DEFINITION_CHANGED')
          finalCheck()
          const result = await definition.execute(args, exec)
          finalCheck(); return result
        } }
        entry = { dispose: agent.ctx.get('tools').register(wrapper) }
        definitions.set(name, entry)
      }
    }
    const ensure = async (agent) => {
      if (!agent) return
      const entry = owner(agent)
      if (!entry) { clear(agent); return }
      await entry.runtime.confirmSession(agent)
      confirmedSessions.add(agent.session.id)
      check(agent); wrap(agent); check(agent)
    }
    const installTools = (service) => {
      if (!service?.ctx || toolInstances.has(service)) return
      toolInstances.add(service)
      service.ctx.on('tools/pre-execute', async (exec, next) => { await ensure(exec.agent); return next() })
      service.ctx.get('tools').guard((exec) => { try { if (exec.agent && original(exec.agent.ctx.get('tools')) !== service) fail('SESSION_TOOL_SERVICE_CHANGED'); check(exec.agent) } catch (error) { return error.code ?? 'SESSION_IDENTITY_NOT_CONFIRMED' } })
    }
    const installLlm = (service) => {
      if (!service?.ctx || llmInstances.has(service)) return
      const prepared = installPreparedCallFacade(service, () => original(host.get('llm')) === service)
      llmInstances.add(service)
      service.ctx.on('llm/stream', function (options, next) {
        if (original(host.get('llm')) !== service) return next()
        return (async function* () {
          const agent = options.sessionId ? host.get('agents')?.get(options.sessionId) : null
          const finalCheck = () => {
            if (original(host.get('llm')) !== service) fail('SESSION_LLM_SERVICE_CHANGED')
            if (agent) check(agent)
            const registration = agent ? owner(agent) : null
            if (registration?.isAgentLoopRequest(options) === true) registration.runtime.assertInjectedContextCurrent(agent, options)
          }
          if (agent && (candidates(agent).length || confirmedSessions.has(agent.session.id) || bound(agent))) { prepared.claim(options); await ensure(agent) }
          const stream = await next(); finalCheck()
          const iterator = stream[Symbol.asyncIterator](); let completed = false
          try {
            while (true) { finalCheck(); const item = await iterator.next(); finalCheck(); if (item.done) { completed = true; return } yield item.value }
          } finally { if (!completed) await iterator.return?.() }
        })()
      })
    }
    host.on('agent/disposed', ({ agent }) => clear(agent))
    host.on('internal/service', (name, value) => {
      if (name === 'llm') installLlm(original(value))
      if (name === 'tools') installTools(original(value))
    }, { global: true })
    manager = { registrations, ensure, check, clear, installTools, installLlm }; managers.set(host, manager)
  }
  manager.installTools(tools); manager.installLlm(llm)
  const registration = { runtime, ownsAgent, scopeChainOf, isAgentLoopRequest, serviceTools: [...serviceTools] }
  manager.registrations.add(registration)
  let disposed = false
  return Object.freeze({ ensure: manager.ensure, check: manager.check,
    dispose() { if (!disposed) { disposed = true; manager.registrations.delete(registration) } },
  })
}
