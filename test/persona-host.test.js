import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { startPersonaPlugin, inject } from '../src/persona/plugin.js'
import { createLocalMemoryProvider } from '../src/memory/v2/provider.js'
import { createMemorySelector } from '../src/memory/v2/selection.js'

const modules = process.env.DSH_RUNTIME_MODULES

test('persona starts with official host services before any sandbox execution', {
  skip: modules ? false : 'Set DSH_RUNTIME_MODULES to run the official-host integration test',
  timeout: 30000,
}, async () => {
  const hostRoot = resolve(modules)
  const load = name => import(pathToFileURL(join(hostRoot, '@deepseek-ai', name, 'lib/index.js')).href)
  const [Cordis, Sessions, Projection, Prompt, Tools, Llm, Agents, Loop, Scope,
    Policy, Fs, Subprocess, ShellEnv, Bash, FsTools, BashTools, SearchTools, Home] = await Promise.all([
    'cordis', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-llm',
    'dsh-agent', 'dsh-agent-loop', 'dsh-scope', 'dsh-sandbox-policy', 'dsh-fs-sandbox',
    'dsh-subprocess-local', 'dsh-shell-env', 'dsh-bash-sandbox', 'dsh-tool-fs',
    'dsh-tool-bash', 'dsh-tool-fs-search', 'dsh-home-paths',
  ].map(load))
  const { z } = createRequire(join(hostRoot, '@deepseek-ai/dsh-agent-loop/package.json'))('zod')
  const root = mkdtempSync(join(tmpdir(), 'whale-persona-host-'))
  const workspace = join(root, 'workspace'), home = join(root, 'home'), memory = join(root, 'memory')
  mkdirSync(workspace); mkdirSync(home)
  const ctx = new Cordis.Context()
  let role, handle, startup, sandboxCalls = 0
  const sandbox = { async confine() {
    sandboxCalls++
    throw Object.assign(new Error('Synthetic unavailable host runner'), { code: 'SANDBOX_UNAVAILABLE' })
  } }
  try {
    ctx.provide('profileContext', { home })
    ctx.provide('whaleMemory', createLocalMemoryProvider())
    ctx.provide('attachments', {})
    ctx.provide('sandbox', sandbox)
    ctx.provide('workingDirectory', { get: session => session.header.cwd, ensure: async agent => agent.session.header.cwd })
    for (const plugin of [Sessions.SessionStore, Projection.default, Prompt.default, Tools.default,
      Llm.LlmRuntime, Agents.AgentRegistry, Loop.default]) await ctx.plugin(plugin).await()
    for (const [plugin, config] of [[Policy.default, { mode: 'workspace-write', workspaceRoot: workspace }],
      [Fs.default, { cwd: workspace }], [Subprocess.default, {}], [ShellEnv, { dshHome: home }]]) {
      await ctx.plugin(plugin, config).await()
    }
    role = Scope.createScope(ctx, {})
    await role.ctx.fiber.await()
    const fiber = role.ctx.plugin({ inject, apply(child) {
      startup = startPersonaPlugin(child, { root: memory, autoDream: false,
        selectorFactory: () => createMemorySelector({ assess: ({ event }) => ({ decision: 'long_term', kind: 'fact',
          subject_scope: 'subject', canonical_key: null, evidence_quote: event.content, time_quote: null,
          growth_relevant: false, maturity_relevant: true, confidence: 0.99 }) }),
        assessorFactory: () => async () => ({ persistable: true, compatible: true, supported: true, confidence: 0.99 }),
      }, { BlockAssembler: Llm.BlockAssembler, isAgentLoopRequest: Llm.isAgentLoopRequest,
        createUserMessage: Llm.createUserMessage, joinContextSections: Prompt.joinContextSections,
        scopeOf: Scope.scopeOf, scopeChainOf: Scope.scopeChainOf, z, BashSandbox: Bash.default,
        FsTools, BashTools, FsSearchTools: SearchTools, privateRootBindings: { resolveDshHome: Home.resolveDshHome } })
    } })
    await fiber.await()
    const installed = await startup.ready
    assert.equal(sandboxCalls, 0)
    for (const name of ['fs', 'subprocess', 'sandbox']) {
      const original = value => value?.[Cordis.symbols.original] ?? value
      assert.equal(original(installed.capabilityContext.get(name)), original(ctx.get(name)))
    }
    handle = await role.ctx.get('agents').create({ sessionId: 'portable-persona', meta: { cwd: workspace } })
    const agent = handle.agent
    Scope.bindScopeParent(agent, Scope.scopeOf(role.ctx))
    const call = (name, args) => ctx.tools.execute({ agent, callId: name, name, arguments: args, signal: new AbortController().signal })
    assert.equal((await call('write', { file_path: 'ordinary.txt', content: 'ordinary task' })).isError, false)
    const read = await call('read', { file_path: 'ordinary.txt' })
    assert.equal(read.isError, false)
    assert.match(JSON.stringify(read.content), /ordinary task/)
    const event = agent.session.append('user/message', Llm.createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: '我长期喜欢无糖白茶。' }] }), { surfaceOp: 'append' })
    await installed.runtime.capture(agent, event)
    const view = await installed.runtime.prepareContext(agent)
    assert.match(view.memory, /无糖白茶/)
    assert.equal(JSON.parse(readFileSync(join(memory, 'manifest.json'), 'utf8')).format_version, 2)
    assert.equal(sandboxCalls, 0)
    agent.session.append('sandbox/mode', { mode: 'read-only' })
    assert.equal((await call('write', { file_path: 'refused.txt', content: 'refused' })).isError, true)
    const bash = await call('bash', { command: 'echo host-policy', description: 'Verify host runner delegation' })
    assert.equal(bash.isError, true)
    assert.ok(sandboxCalls > 0)
  } finally {
    await handle?.dispose()
    await role?.dispose()
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})
