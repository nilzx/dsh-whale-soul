import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
import { resolveMemoryRoot } from '../paths.js'
import { createHostProtection } from './host-policy.js'
import { createHostPrivateRoots } from './host-private-roots.js'
import FileImage from './file-image.js'
import { PersonaRuntime } from './runtime.js'
import { createPersonaTools } from './tools.js'
import { getWhaleCorePrompt } from './core.js'
import { PersonaImages, createPersonaImageTools } from './images.js'
import { registerAssetRoutes } from '../memory/asset-route.js'
import { assetUrl } from '../memory/assets.js'

export const name = 'whale-soul-persona'
export const inject = ['systemPrompt', 'tools', 'llm', 'sandboxPolicy', 'fs', 'subprocess', 'sandbox', 'agents']
const runtimes = new WeakMap()
export const runtimeFor = (ctx) => runtimes.get(ctx)
const serviceTools = ['soul_recall', 'soul_remember', 'soul_forget', 'soul_view_image', 'soul_meme_save', 'soul_meme_recall', 'soul_meme_use', 'soul_react',
  'ask_user_question', 'todo_write', 'web_search', 'web_fetch', 'job_list', 'job_output', 'job_kill']

/** Explicit constructors make the host composition testable without global state. */
export async function installPersonaPlugin(ctx, config = {}, host) {
  if (typeof host.scopeOf !== 'function' || typeof host.scopeChainOf !== 'function' || !host.scopeOf(ctx)) throw new Error('whale-soul: trusted persona scope required')
  const root = resolveMemoryRoot(config)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const resolvePrivateRoots = createHostPrivateRoots(ctx, host.privateRootBindings)
  const protection = createHostProtection(ctx, { protectedRoots: [fileURLToPath(new URL('../..', import.meta.url)), root],
    resolvePrivateRoots, writableRoots: host.writableRoots, readTools: ['read', 'read_image', 'glob', 'grep'], serviceTools })
  protection.install()
  ctx.effect(() => () => protection.dispose(), 'whale-soul.persona.protection()')
  await protection.initialize()
  const capabilityContext = protection.capabilityContext
  for (const [plugin, options] of [[host.BashSandbox, {}], [host.FsTools, { readImage: false }], [host.BashTools, {}],
    [host.FsSearchTools, { sampleOverCapGlobResults: false }]]) {
    if (!plugin) throw new Error('whale-soul: official protected tool bindings required')
    await capabilityContext.plugin(plugin, options).await()
  }
  await capabilityContext.plugin(FileImage, {
    ownsAgent: (agent) => host.scopeChainOf(agent).includes(host.scopeOf(ctx)) &&
      ctx.get('agents')?.get(agent.id) === agent,
    captureBoundary: (exec) => {
      const snapshot = resolvePrivateRoots()
      return () => snapshot.isCurrent() && protection.status.initialized && protection.status.readIsolation && protection.policy.guard(exec) === undefined
    },
  }).await()
  let images
  const runtime = new PersonaRuntime({ ...config, root, llm: ctx.llm, createAssembler: () => new host.BlockAssembler(),
    additionalEvidenceAllowed: (id, context, meta) => images?.evidenceAllowed(id, context, meta) ?? false,
    onDream: (phase, payload) => ctx.emit(`whale-soul/dream-${phase}`, payload) })
  runtimes.set(ctx, runtime)
  ctx.effect(() => () => runtime.dispose(), 'whale-soul.persona.runtime()')
  await runtime.ready()
  const assetRoute = registerAssetRoutes(ctx, { root: runtime.store.spaceRoot })
  const assetPreview = (asset) => {
    try {
      const web = ctx.get('webServer'), connection = ctx.get('connection')
      if (!assetRoute.active || typeof web?.getOrigin !== 'function' || typeof connection?.admit !== 'function') return null
      const origin = new URL(web.getOrigin())
      if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') return null
      return assetUrl(origin.origin, asset, runtime.store.spaceRoot)
    } catch { return null }
  }
  const ownerScope = host.scopeOf(ctx)
  images = new PersonaImages({ runtime, getAttachments: () => ctx.get('attachments'),
    getLlm: () => ctx.get('llm'), ownsAgent: (agent) => host.scopeChainOf(agent).includes(ownerScope), assetPreview })
  ctx.effect(() => () => images.dispose(), 'whale-soul.persona.images()')
  if (config.coreInPreset !== true) ctx.effect(() => ctx.systemPrompt.section({
    name: 'deployment:persona-prefix', order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
    text: getWhaleCorePrompt(), interpolate: false,
  }), 'whale-soul.persona.core()')
  const contextNames = { growth: 'whale-soul:growth', memory: 'whale-soul:memory' }
  for (const [kind, contextName] of Object.entries(contextNames)) ctx.effect(() => ctx.systemPrompt.context({
    name: contextName, order: kind === 'growth' ? 390 : 400, required: true, interpolate: false,
    text: (context) => runtime.contextFor(context.agent)[kind],
  }), `whale-soul.persona.context(${kind})`)
  ctx.effect(() => ctx.systemPrompt.context({ name: 'whale-soul:memory-operation', order: 410,
    required: true, interpolate: false, text: (context) => runtime.operationContextFor(context.agent),
  }), 'whale-soul.persona.operation-context()')
  ctx.effect(() => ctx.on('agent/request', async ({ agent, signal }, next) => {
    await runtime.waitCurrent(agent, { signal })
    return next()
  }), 'whale-soul.persona.await-current-memory()')
  ctx.effect(() => ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'enter') await runtime.acceptInboxMessages(agent, decision.messages, { signal })
    return decision
  }, { prepend: true }), 'whale-soul.persona.accept-current-input()')
  ctx.effect(() => ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    if (context.agent) await runtime.prepareContext(context.agent, { signal: context.signal })
    const result = await next()
    const view = context.agent ? runtime.contextFor(context.agent) : { memory: '', growth: '' }
    result.contexts = result.contexts.filter((entry) => !Object.values(contextNames).includes(entry.name))
    for (const kind of ['growth', 'memory']) if (view[kind]) result.contexts.push({ name: contextNames[kind], text: view[kind], interpolate: false })
    return result
  }), 'whale-soul.persona.assemble()')
  ctx.effect(() => ctx.on('agent/created', async ({ agent }) => { await runtime.attachAgent(agent); images.attachAgent(agent) }), 'whale-soul.persona.agent-created()')
  ctx.effect(() => ctx.on('agent/disposed', ({ agent }) => { images.detachAgent(agent); return runtime.detachAgent(agent) }), 'whale-soul.persona.agent-disposed()')
  ctx.effect(() => ctx.on('session/disposed', (session) => images.detachSession(session.id)), 'whale-soul.persona.image-session-disposed()')
  ctx.effect(() => ctx.on('agent/status', ({ agent, status }) => runtime.setStatus(agent, status)), 'whale-soul.persona.agent-status()')
  ctx.effect(() => ctx.on('agent/inbox/discarded', ({ agent, message }) => runtime.discardInboxMessage(agent, message)), 'whale-soul.persona.discard-input()')
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    const agent = runtime.sessionAgent(session) ?? ctx.get('agents')?.get(session?.id ?? session?.header?.id)
    if (agent) {
      images.capture(agent, event)
      if (event.type === 'agent/inbox/spliced') runtime.stageInbox(agent, event).catch(() => {})
      else runtime.capture(agent, event).catch(() => {})
    }
  }), 'whale-soul.persona.events()')
  for (const definition of createPersonaTools(runtime)) ctx.effect(() => ctx.tools.register(definition), `whale-soul.persona.tool(${definition.name})`)
  for (const definition of createPersonaImageTools(images)) ctx.effect(() => ctx.tools.register(definition), `whale-soul.persona.tool(${definition.name})`)
  return { runtime, images, protection, capabilityContext, assetRoute }
}

export async function apply(ctx, config = {}) {
  const [llm, sandbox, scope, bashSandbox, fsTools, bashTools, fsSearchTools, home, credentials, persistence, storageJson, storage, attachments] = await Promise.all([
    '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-sandbox', '@deepseek-ai/dsh-scope',
    '@deepseek-ai/dsh-bash-sandbox', '@deepseek-ai/dsh-tool-fs', '@deepseek-ai/dsh-tool-bash', '@deepseek-ai/dsh-tool-fs-search',
    '@deepseek-ai/dsh-home-paths', '@deepseek-ai/dsh-credentials-local', '@deepseek-ai/dsh-session-persistence-jsonl',
    '@deepseek-ai/dsh-storage-json', '@deepseek-ai/dsh-storage', '@deepseek-ai/dsh-attachment-local',
  ].map((specifier) => import(specifier)))
  await installPersonaPlugin(ctx, config, { BlockAssembler: llm.BlockAssembler, writableRoots: sandbox.writableRoots,
    scopeOf: scope.scopeOf, scopeChainOf: scope.scopeChainOf, BashSandbox: bashSandbox.default,
    FsTools: fsTools, BashTools: bashTools, FsSearchTools: fsSearchTools, privateRootBindings: {
      resolveDshHome: home.resolveDshHome, LocalCredentialProvider: credentials.LocalCredentialProvider, resolveCredentialSpec: credentials.resolveSpec,
      SessionPersistencePlugin: persistence, StorageJsonPlugin: storageJson, JsonStorageBackend: storageJson.JsonStorageBackend,
      storageBackendServiceKey: storage.storageBackendServiceKey, LocalAttachmentStore: attachments.LocalAttachmentStore,
    } })
}

export default { name, inject, apply }
