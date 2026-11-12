import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createInjectedSurfaceController, INJECTED_CONTEXT_NAMES } from '../src/persona/injected-surface.js'

const modules = process.env.DSH_RUNTIME_MODULES
const own = new Set(INJECTED_CONTEXT_NAMES)

// A real host run: the loop renders the runtime-context snapshot, and the
// plugin's own controller binds and cleans that exact surface.
test('host runtime-context snapshot binds and cleans through the official surface', {
  skip: modules ? false : 'Set DSH_RUNTIME_MODULES to run the official-host surface test',
  timeout: 30000,
}, async () => {
  const host = pathToFileURL(join(modules, '@deepseek-ai') + '/')
  const load = (name) => import(new URL(`${name}/lib/index.js`, host).href)
  const [Cordis, Sessions, Projection, Prompt, Tools, Llm, Agents, Loop, Scope] = await Promise.all([
    'cordis', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-llm',
    'dsh-agent', 'dsh-agent-loop', 'dsh-scope',
  ].map(load))
  // Tool execution is a mounted executor plugin since DSH 0.2.2; a missing one
  // is fine here because this test never calls a tool.
  const Executor = await load('dsh-tool-executor-native').catch(() => undefined)
  const root = mkdtempSync(join(tmpdir(), 'whale-surface-host-'))
  const ctx = new Cordis.Context()
  let handle, role, controller
  try {
    ctx.provide('profileContext', { home: join(root, 'home') })
    for (const plugin of [Sessions.SessionStore, Projection.default, Prompt.default, Tools.default,
      Llm.LlmRuntime, Agents.AgentRegistry, Loop.default, ...Executor ? [Executor] : []]) await ctx.plugin(plugin).await()
    role = Scope.createScope(ctx, {})
    await role.ctx.fiber.await()
    role.ctx.get('systemPrompt').context({ name: 'whale-soul:memory', order: 400, required: true, interpolate: false, text: 'MEMORY_CANARY 白桃乌龙茶' })
    role.ctx.get('systemPrompt').context({ name: 'fixture:other', order: 500, required: true, interpolate: false, text: 'OTHER_LITERAL_STAYS' })
    const requests = []
    class Adapter extends Llm.LlmAdapter {
      async resolveModel(provider, id) { return { provider, id, name: id, defaultMaxTokens: 2048 } }
      async *stream(request) {
        requests.push(request)
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: '我在听。' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '我在听。' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['fixture'], new Adapter())
    handle = await role.ctx.get('agents').create({ sessionId: 'surface-host', meta: { cwd: root }, agentOptions: { provider: 'fixture', model: 'model' } })
    const agent = handle.agent
    Scope.bindScopeParent(agent, Scope.scopeOf(role.ctx))
    agent.followup(Llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '聊聊茶' }] }))
    await agent.whenIdle()
    const request = requests[0]
    assert.ok(request, JSON.stringify(agent.session.eventAt(agent.session.seq - 1)))
    let live = true
    const bindings = request.messages.filter((message) => message.source?.kind === 'runtime-context')
      .flatMap((message) => message.source.sections.filter((section) => own.has(section.name))
        .map((section) => ({ message, section, isCurrent: () => live })))
    assert.ok(bindings.length > 0)
    controller = createInjectedSurfaceController({ session: agent.session, checkBoundary: () => true,
      isAgentLoopRequest: Llm.isAgentLoopRequest, createUserMessage: Llm.createUserMessage, joinContextSections: Prompt.joinContextSections })
    assert.equal(controller.bind(request, bindings), true)
    live = false
    const cleanup = controller.clean()
    assert.equal(cleanup.status, 'clean')
    assert.equal(cleanup.unknown_count, 0)
    assert.equal(cleanup.replaced_count, 1)
    assert.deepEqual(cleanup.replacements[0].sections, ['whale-soul:memory'])
    const current = agent.session.deriveMessages().filter((message) => message.source?.kind === 'runtime-context').at(-1)
    assert.deepEqual(current.source.sections.map((section) => section.name), ['fixture:other'])
    assert.equal(current.source.sections[0].text, 'OTHER_LITERAL_STAYS')
    assert.match(current.content[0].text, /OTHER_LITERAL_STAYS/)
    assert.equal(controller.clean().replaced_count, 0)
  } finally {
    controller?.dispose()
    await handle?.dispose()
    await role?.dispose()
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})
