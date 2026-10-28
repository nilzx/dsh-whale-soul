import { normalizeIndividualKey } from '../memory/v2/persona-ledger.js'
import { protectMigrationSources } from './source-protection.js'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
import { resolveMemoryRoot } from '../paths.js'
import { preparePersonaMemory } from './auto-upgrade.js'
import { repairPersonaMemory } from './memory-repair.js'
import { runMemoryRepairAgent } from './memory-repair-agent.js'
import { inspectMemoryRoot } from '../memory/v2/root-format.js'
import { MemoryStoreV2 } from '../memory/v2/store.js'
import { createHostProtection } from './host-policy.js'
import { createHostPrivateRoots } from './host-private-roots.js'
import FileImage from './file-image.js'
import { PersonaRuntime } from './runtime.js'
export { PersonaRuntime } from './runtime.js'
import { createPersonaTools } from './tools.js'
import { getWhaleCorePrompt } from './core.js'
import { PersonaImages, createPersonaImageTools } from './images.js'
import { registerAssetRoutes } from '../memory/asset-route.js'
import { assetUrl } from '../memory/assets.js'
import { observeSessionIdentityBoundary } from './session-fence.js'
import { installMemoryMaintenanceHost } from './memory-maintenance-host.js'
import { installSessionDispatch } from './session-dispatch.js'
import { assertMemoryProvider } from '../memory/v2/provider.js'

export const name = 'whale-soul-persona'
export const inject = ['whaleMemory', 'systemPrompt', 'tools', 'llm', 'sandboxPolicy', 'fs', 'subprocess', 'sandbox', 'agents']
const runtimes = new WeakMap()
export const runtimeFor = (ctx) => runtimes.get(ctx)
const serviceTools = ['soul_recall', 'soul_remember', 'soul_forget', 'soul_agreement_accept', 'soul_view_image', 'soul_meme_save', 'soul_meme_recall', 'soul_meme_use', 'soul_react',
  'ask_user_question', 'todo_write', 'web_search', 'web_fetch', 'job_list', 'job_output', 'job_kill']

/** Keep host/plugin startup independent from a pending automatic memory repair. */
export function startPersonaPlugin(ctx, config = {}, host, install = installPersonaPlugin) {
  const controller = new AbortController(), ownerScope = host.scopeOf(ctx), removers = []
  const owns = agent => host.scopeChainOf(agent).includes(ownerScope) && ctx.get('agents')?.get(agent.id) === agent
  let capturing = true, bufferedInbox = new WeakMap()
  const drains = new WeakMap()
  const flushStartupInbox = async (agent, installed) => {
    if (drains.has(agent)) return drains.get(agent)
    const task = (async () => {
      const events = bufferedInbox.get(agent)
      while (events?.length) {
        controller.signal.throwIfAborted()
        await installed.runtime.stageInbox(agent, events[0])
        installed.images.capture(agent, events.shift())
      }
      bufferedInbox.delete(agent)
    })()
    drains.set(agent, task)
    try { await task } finally { if (drains.get(agent) === task) drains.delete(agent) }
  }
  let resolveReady, rejectReady
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  ready.catch(() => {})
  const failStartup = error => {
    if (!controller.signal.aborted) ctx.logger?.error?.(error)
    rejectReady(error)
  }
  const removeGates = () => { for (const remove of removers.splice(0)) remove() }
  const waitReady = signal => {
    const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal
    combined.throwIfAborted()
    return new Promise((resolve, reject) => {
      const abort = () => { combined.removeEventListener('abort', abort); reject(combined.reason) }
      combined.addEventListener('abort', abort, { once: true })
      ready.then(value => { combined.removeEventListener('abort', abort); resolve(value) },
        error => { combined.removeEventListener('abort', abort); reject(error) })
    })
  }
  const attach = async (agent, installed) => {
    if (!owns(agent)) return false
    await installed.runtime.attachAgent(agent)
    controller.signal.throwIfAborted()
    installed.images.attachAgent(agent)
    await flushStartupInbox(agent, installed)
    return true
  }
  ctx.effect(() => () => {
    controller.abort(new Error('Whale Soul startup disposed'))
    rejectReady(controller.signal.reason)
    capturing = false; bufferedInbox = new WeakMap()
    removeGates()
  }, 'whale-soul.persona.startup()')
  removers.push(ctx.on('session/event', (session, event) => {
    if (!capturing || event?.type !== 'agent/inbox/spliced') return
    const agent = ctx.get('agents')?.get(session?.id ?? session?.header?.id)
    if (!agent || !owns(agent)) return
    const events = bufferedInbox.get(agent) ?? []
    events.push(event); bufferedInbox.set(agent, events)
  }))
  removers.push(ctx.on('agent/created', async ({ agent, signal }) => {
    if (!owns(agent)) return
    await attach(agent, await waitReady(signal))
  }))
  removers.push(ctx.on('agent/request', async ({ agent, signal }, next) => {
    if (!owns(agent)) return next()
    const installed = await waitReady(signal)
    if (await attach(agent, installed)) {
      await installed.dispatch.ensure(agent)
      await installed.runtime.waitCurrent(agent, { signal })
      await installed.runtime.prepareContext(agent, { signal })
    }
    return next()
  }, { prepend: true }))
  removers.push(ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    if (!owns(agent)) return next()
    const installed = await waitReady(signal)
    if (!await attach(agent, installed)) return next()
    const decision = await next()
    if (decision.kind === 'enter') await installed.runtime.acceptInboxMessages(agent, decision.messages, { signal })
    return decision
  }, { prepend: true }))
  // Calling the async installer now registers its observer synchronously, before
  // the first repair await, while the host receives a non-promise startup handle.
  try {
    Promise.resolve(install(ctx, config, { ...host, startupSignal: controller.signal, flushStartupInbox })).then(installed => {
      if (controller.signal.aborted) return
      capturing = false
      removeGates()
      resolveReady(installed)
    }, failStartup)
  } catch (error) { failStartup(error) }
  return { ready }
}

/** Explicit constructors make the host composition testable without global state. */
export async function installPersonaPlugin(ctx, config = {}, host) {
  const individualKey = normalizeIndividualKey(config.individualKey)
  const memoryProvider = assertMemoryProvider(ctx.get('whaleMemory'))
  if (typeof host?.createUserMessage !== 'function' || typeof host?.joinContextSections !== 'function') throw new Error('whale-soul: official context surface bindings required')
  const original = Symbol.for('cordis.original'), providerIdentity = memoryProvider[original] ?? memoryProvider
  if (typeof host.scopeOf !== 'function' || typeof host.scopeChainOf !== 'function' || !host.scopeOf(ctx)) throw new Error('whale-soul: trusted persona scope required')
  const ownerScope = host.scopeOf(ctx)
  const ownsAgent = (agent) => host.scopeChainOf(agent).includes(ownerScope) && ctx.get('agents')?.get(agent.id) === agent
  const observer = observeSessionIdentityBoundary(ctx, ownsAgent, host.z)
  ctx.effect(() => () => observer.dispose(), 'whale-soul.persona.session-observer()')
  const root = resolveMemoryRoot(config)
  const repairController = new AbortController()
  const abortRepair = () => repairController.abort(host.startupSignal?.reason)
  if (host.startupSignal?.aborted) abortRepair()
  else host.startupSignal?.addEventListener('abort', abortRepair, { once: true })
  ctx.effect(() => () => {
    host.startupSignal?.removeEventListener('abort', abortRepair)
    repairController.abort()
  }, 'whale-soul.persona.memory-repair()')
  const checkStartup = () => repairController.signal.throwIfAborted()
  const repairMemory = cause => repairPersonaMemory({ ...config, root, individualKey, cause, signal: repairController.signal, retryDelayMs: config.repairRetryDelayMs,
    onStatus: state => ctx.emit('whale-soul/memory-repair', { state }),
    runAgent: repair => runMemoryRepairAgent({ ...repair, maxTurns: config.repairMaxTurns ?? 12, llm: ctx.get('llm'),
      resolveRoute: () => ctx.get('agentDefaultModel').currentSelection(), createAssembler: () => new host.BlockAssembler(),
      createUserMessage: host.createUserMessage, createToolResultMessage: host.createToolResultMessage }) })
  try {
    await preparePersonaMemory({ ...config, root, individualKey })
    checkStartup()
    const classification = inspectMemoryRoot(root, config.memorySpaceId ?? 'owner')
    if (classification.kind === 'v2') {
      const probe = new MemoryStoreV2({ root, memory_space_id: config.memorySpaceId ?? 'owner' })
      const warning = probe._records().warnings[0]
      if (warning) throw Object.assign(new Error(warning.reason_code), { code: warning.reason_code })
    }
  } catch (cause) { checkStartup(); await repairMemory(cause) }
  checkStartup()
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const resolvePrivateRoots = protectMigrationSources(createHostPrivateRoots(ctx, host.privateRootBindings), root)
  const protection = createHostProtection(ctx, { protectedRoots: [fileURLToPath(new URL('../..', import.meta.url)), root],
    resolvePrivateRoots, writableRoots: host.writableRoots, readTools: ['read', 'read_image', 'glob', 'grep'], serviceTools })
  protection.install()
  ctx.effect(() => () => protection.dispose(), 'whale-soul.persona.protection()')
  await protection.initialize()
  checkStartup()
  const capabilityContext = protection.capabilityContext
  for (const [plugin, options] of [[host.BashSandbox, {}], [host.FsTools, { readImage: false }], [host.BashTools, {}],
    [host.FsSearchTools, { sampleOverCapGlobResults: false }]]) {
    if (!plugin) throw new Error('whale-soul: official protected tool bindings required')
    await capabilityContext.plugin(plugin, options).await()
    checkStartup()
  }
  let runtime, memoryMaintenance
  await capabilityContext.plugin(FileImage, {
    ownsAgent: (agent) => host.scopeChainOf(agent).includes(host.scopeOf(ctx)) &&
      ctx.get('agents')?.get(agent.id) === agent,
    captureBoundary: (exec) => {
      const snapshot = resolvePrivateRoots()
      return () => {
        try { return runtime?.checkSession(exec.agent) === true && snapshot.isCurrent() && protection.status.initialized && protection.status.readIsolation && protection.policy.guard(exec) === undefined }
        catch { return false }
      }
    },
  }).await()
  checkStartup()
  let images
  runtime = new PersonaRuntime({ ...config, individualKey, root, memoryProvider, repairMemory, llm: { prepareCall: (...args) => ctx.get('llm').prepareCall(...args) }, createAssembler: () => new host.BlockAssembler(),
    getMemoryMaintenanceHost: () => memoryMaintenance,
    isMemoryProviderCurrent: () => { const current = ctx.get('whaleMemory'); return (current?.[original] ?? current) === providerIdentity },
    sessionHost: { scopeChainOf: host.scopeChainOf, resolveDshHome: host.privateRootBindings.resolveDshHome, observer, z: host.z, ownsAgent, isAgentLoopRequest: host.isAgentLoopRequest,
      createUserMessage: host.createUserMessage, joinContextSections: host.joinContextSections },
    additionalEvidenceAllowed: (id, context, meta) => images?.evidenceAllowed(id, context, meta) ?? false,
    onDream: (phase, payload) => ctx.emit(`whale-soul/dream-${phase}`, payload) })
  runtimes.set(ctx, runtime)
  ctx.effect(() => () => runtime.dispose(), 'whale-soul.persona.runtime()')
  await runtime.ready()
  checkStartup()
  memoryMaintenance = installMemoryMaintenanceHost(ctx, { runtime, ownsAgent, scopeChainOf: host.scopeChainOf, config })
  ctx.effect(() => () => memoryMaintenance.dispose(), 'whale-soul.persona.memory-maintenance()')
  const dispatch = installSessionDispatch(ctx, { runtime, ownsAgent, scopeChainOf: host.scopeChainOf, resolveDshHome: host.privateRootBindings.resolveDshHome,
    isAgentLoopRequest: host.isAgentLoopRequest, serviceTools })
  ctx.effect(() => () => dispatch.dispose(), 'whale-soul.persona.session-dispatch()')
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
  images = new PersonaImages({ runtime, getAttachments: () => ctx.get('attachments'),
    getLlm: () => ctx.get('llm'), ownsAgent: (agent) => host.scopeChainOf(agent).includes(ownerScope), assetPreview })
  ctx.effect(() => () => images.dispose(), 'whale-soul.persona.images()')
  if (config.coreInPreset !== true) ctx.effect(() => ctx.systemPrompt.section({
    name: 'deployment:persona-prefix', order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
    text: getWhaleCorePrompt(), interpolate: false,
  }), 'whale-soul.persona.core()')
  const contextNames = { growth: 'whale-soul:growth', memory: 'whale-soul:memory', external: 'whale-soul:owner-reviewed-memory' }
  for (const [kind, contextName] of Object.entries(contextNames)) ctx.effect(() => ctx.systemPrompt.context({
    name: contextName, order: kind === 'growth' ? 390 : 400, required: true, interpolate: false,
    text: (context) => {
      const view = runtime.contextFor(context.agent)
      return kind === 'growth' ? view.growth : runtime.memoryContextNameFor(context.agent) === contextName ? view.memory : ''
    },
  }), `whale-soul.persona.context(${kind})`)
  ctx.effect(() => ctx.systemPrompt.context({ name: 'whale-soul:memory-operation', order: 410,
    required: true, interpolate: false, text: (context) => runtime.operationContextFor(context.agent),
  }), 'whale-soul.persona.operation-context()')
  ctx.effect(() => ctx.on('agent/request', async ({ agent, signal }, next) => {
    await host.flushStartupInbox?.(agent, { runtime, images })
    await dispatch.ensure(agent)
    await runtime.waitCurrent(agent, { signal })
    await runtime.prepareContext(agent, { signal })
    return next()
  }), 'whale-soul.persona.await-current-memory()')
  ctx.effect(() => ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    await host.flushStartupInbox?.(agent, { runtime, images })
    const decision = await next()
    if (decision.kind === 'enter') await runtime.acceptInboxMessages(agent, decision.messages, { signal })
    return decision
  }, { prepend: true }), 'whale-soul.persona.accept-current-input()')
  ctx.effect(() => ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    if (context.agent) await runtime.prepareContext(context.agent, { signal: context.signal })
    const result = await next()
    const view = context.agent ? runtime.contextFor(context.agent) : { memory: '', growth: '' }
    result.contexts = result.contexts.filter((entry) => !Object.values(contextNames).includes(entry.name))
    if (view.growth) result.contexts.push({ name: contextNames.growth, text: view.growth, interpolate: false })
    if (view.memory) result.contexts.push({ name: runtime.memoryContextNameFor(context.agent), text: view.memory, interpolate: false })
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
  return { runtime, images, protection, capabilityContext, assetRoute, dispatch, memoryMaintenance }
}

export async function apply(ctx, config = {}) {
  let zod
  try { zod = await import('zod') } catch { throw new Error('whale-soul: session identity protection requires the host zod package (>=4.4.3 <5)') }
  const [llm, prompt, sandbox, scope, bashSandbox, fsTools, bashTools, fsSearchTools, home, credentials, persistence, storageJson, storage, attachments] = await Promise.all([
    '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-sandbox', '@deepseek-ai/dsh-scope',
    '@deepseek-ai/dsh-bash-sandbox', '@deepseek-ai/dsh-tool-fs', '@deepseek-ai/dsh-tool-bash', '@deepseek-ai/dsh-tool-fs-search',
    '@deepseek-ai/dsh-home-paths', '@deepseek-ai/dsh-credentials-local', '@deepseek-ai/dsh-session-persistence-jsonl',
    '@deepseek-ai/dsh-storage-json', '@deepseek-ai/dsh-storage', '@deepseek-ai/dsh-attachment-local',
  ].map((specifier) => import(specifier)))
  startPersonaPlugin(ctx, config, { BlockAssembler: llm.BlockAssembler, isAgentLoopRequest: llm.isAgentLoopRequest,
    createUserMessage: llm.createUserMessage, createToolResultMessage: llm.createToolResultMessage, joinContextSections: prompt.joinContextSections, writableRoots: sandbox.writableRoots,
    scopeOf: scope.scopeOf, scopeChainOf: scope.scopeChainOf, z: zod.z, BashSandbox: bashSandbox.default,
    FsTools: fsTools, BashTools: bashTools, FsSearchTools: fsSearchTools, privateRootBindings: {
      resolveDshHome: home.resolveDshHome, LocalCredentialProvider: credentials.LocalCredentialProvider, resolveCredentialSpec: credentials.resolveSpec,
      SessionPersistencePlugin: persistence, StorageJsonPlugin: storageJson, JsonStorageBackend: storageJson.JsonStorageBackend,
      storageBackendServiceKey: storage.storageBackendServiceKey, LocalAttachmentStore: attachments.LocalAttachmentStore,
    } })
}

export default { name, inject, apply }
