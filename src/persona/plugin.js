import { fileURLToPath } from 'node:url'
import { resolveMemoryRoot } from '../paths.js'
import { createHostProtection } from './host-policy.js'
import { PersonaRuntime } from './runtime.js'
import { createPersonaTools } from './tools.js'
import { getWhaleCorePrompt } from './core.js'

export const name = 'whale-soul-persona'
export const inject = ['systemPrompt', 'tools', 'llm', 'sandboxPolicy', 'fs', 'subprocess', 'sandbox', 'agents']
const runtimes = new WeakMap()
export const runtimeFor = (ctx) => runtimes.get(ctx)
const serviceTools = ['soul_recall', 'soul_remember', 'soul_forget', 'soul_meme_save', 'soul_meme_use', 'soul_react',
  'ask_user_question', 'todo_write', 'web_search', 'web_fetch', 'job_list', 'job_output', 'job_kill']

/** Explicit constructors make the host composition testable without global state. */
export async function installPersonaPlugin(ctx, config = {}, host) {
  const root = resolveMemoryRoot(config)
  const protection = createHostProtection(ctx, { protectedRoots: [fileURLToPath(new URL('../..', import.meta.url)), root],
    writableRoots: host.writableRoots, readTools: ['read', 'read_image', 'glob', 'grep'], serviceTools })
  protection.install()
  ctx.effect(() => () => protection.dispose(), 'whale-soul.persona.protection()')
  await protection.initialize()
  const capabilityContext = protection.capabilityContext
  for (const [plugin, options] of [[host.BashSandbox, {}], [host.FsTools, {}], [host.BashTools, {}],
    [host.FsSearchTools, { sampleOverCapGlobResults: false }]]) {
    if (!plugin) throw new Error('whale-soul: official protected tool bindings required')
    await capabilityContext.plugin(plugin, options).await()
  }
  const runtime = new PersonaRuntime({ ...config, root, llm: ctx.llm, createAssembler: () => new host.BlockAssembler(),
    onDream: (phase, payload) => ctx.emit(`whale-soul/dream-${phase}`, payload) })
  runtimes.set(ctx, runtime)
  ctx.effect(() => () => runtime.dispose(), 'whale-soul.persona.runtime()')
  await runtime.ready()
  if (config.coreInPreset !== true) ctx.effect(() => ctx.systemPrompt.section({
    name: 'deployment:persona-prefix', order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
    text: getWhaleCorePrompt(), interpolate: false,
  }), 'whale-soul.persona.core()')
  const contextNames = { growth: 'whale-soul:growth', memory: 'whale-soul:memory' }
  for (const [kind, contextName] of Object.entries(contextNames)) ctx.effect(() => ctx.systemPrompt.context({
    name: contextName, order: kind === 'growth' ? 390 : 400, required: true, interpolate: false,
    text: (context) => runtime.contextFor(context.agent)[kind],
  }), `whale-soul.persona.context(${kind})`)
  ctx.effect(() => ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    if (context.agent) await runtime.prepareContext(context.agent, { signal: context.signal })
    const result = await next()
    const view = context.agent ? runtime.contextFor(context.agent) : { memory: '', growth: '' }
    result.contexts = result.contexts.filter((entry) => !Object.values(contextNames).includes(entry.name))
    for (const kind of ['growth', 'memory']) if (view[kind]) result.contexts.push({ name: contextNames[kind], text: view[kind], interpolate: false })
    return result
  }), 'whale-soul.persona.assemble()')
  ctx.effect(() => ctx.on('agent/created', async ({ agent }) => { await runtime.attachAgent(agent) }), 'whale-soul.persona.agent-created()')
  ctx.effect(() => ctx.on('agent/disposed', ({ agent }) => runtime.detachAgent(agent)), 'whale-soul.persona.agent-disposed()')
  ctx.effect(() => ctx.on('agent/status', ({ agent, status }) => runtime.setStatus(agent, status)), 'whale-soul.persona.agent-status()')
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    const agent = runtime.sessionAgent(session) ?? ctx.get('agents')?.get(session?.id ?? session?.header?.id)
    if (agent) runtime.capture(agent, event).catch(() => {})
  }), 'whale-soul.persona.events()')
  for (const definition of createPersonaTools(runtime)) ctx.effect(() => ctx.tools.register(definition), `whale-soul.persona.tool(${definition.name})`)
  return { runtime, protection, capabilityContext }
}

export async function apply(ctx, config = {}) {
  const [llm, sandbox, systemPrompt, bashSandbox, fsTools, bashTools, fsSearchTools] = await Promise.all([
    '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-sandbox', '@deepseek-ai/dsh-system-prompt',
    '@deepseek-ai/dsh-bash-sandbox', '@deepseek-ai/dsh-tool-fs', '@deepseek-ai/dsh-tool-bash', '@deepseek-ai/dsh-tool-fs-search',
  ].map((specifier) => import(specifier)))
  await installPersonaPlugin(ctx, config, { BlockAssembler: llm.BlockAssembler, writableRoots: sandbox.writableRoots,
    getSectionOrder: systemPrompt.getSectionOrder, BashSandbox: bashSandbox.default,
    FsTools: fsTools, BashTools: bashTools, FsSearchTools: fsSearchTools })
}

export default { name, inject, apply }
