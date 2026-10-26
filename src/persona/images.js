import { MemoryAssetsV2 } from '../memory/v2/assets.js'
import { MemoryError, assertId, assertOnly, digest } from '../memory/v2/contracts.js'
import { retentionBlockReason } from '../memory/v2/retention.js'
import { assetPath } from '../memory/asset-route.js'

const controllers = new WeakMap()
const original = (value) => value?.[Symbol.for('cordis.original')] ?? value
const consent = /(?:收下|保存|记住|留住|收好|留下).{0,30}(?:图片|照片|表情包|这张图|这个图)|(?:这张|刚才|这个).{0,20}(?:图|照片|表情).{0,20}(?:保存|收下|记住|留下)|^(?:收下吧?|保存吧?|记住这个|把这个收好)[。！!\s]*$|\b(?:save|keep|remember|store)\s+(?:this|that|the|my|the last)\s+(?:image|picture|photo|meme)\b|(?:この|さっきの).{0,10}(?:画像|写真).{0,10}(?:保存|覚えて)/i
const quotation = /^(?:引用|有人说|他说|她说|假设|如果|假如|quote\b|suppose\b|imagine\b|if\b)|^\s*[“「『‘"][\s\S]+[”」』’"]\s*$/i
const output = { type: 'object', additionalProperties: false, properties: {
  text: { type: 'string' }, status: { type: 'string' }, reason_code: { type: 'string' }, asset_id: { type: 'string' },
  preview_url: { type: 'string' }, items: { type: 'array', items: { type: 'object' } },
}, required: ['text', 'status'] }
function unavailable(reason = 'IMAGE_UNAVAILABLE') {
  return { status: 'unavailable', reason_code: /^[A-Z][A-Z0-9_]*$/.test(reason) ? reason : 'IMAGE_UNAVAILABLE', text: '这张图暂时没能收好，不能说已经留下了。' }
}
export function imagesForAgent(agent) {
  const controller = controllers.get(agent)
  return controller?.owns(agent) ? controller : null
}

/** Session-bound image authorization comes exclusively from real user events. */
export class PersonaImages {
  #runtime; #attachments; #llm; #owns; #preview; #slots = new Map(); #agents = new Set(); #pending = new Set(); #disposed = false
  constructor({ runtime, getAttachments, getLlm, ownsAgent, assetPreview } = {}) {
    if (!runtime?.store || typeof getAttachments !== 'function' || typeof ownsAgent !== 'function') throw new MemoryError('TRUSTED_IMAGE_ADAPTERS_REQUIRED')
    if (getLlm !== undefined && typeof getLlm !== 'function') throw new MemoryError('TRUSTED_IMAGE_ADAPTERS_REQUIRED')
    this.#runtime = runtime; this.#attachments = getAttachments; this.#llm = getLlm; this.#owns = ownsAgent; this.#preview = assetPreview
    this.assets = new MemoryAssetsV2({ store: runtime.store, resolveConsent: (id, context) => this.#resolve(id, context) })
  }
  owns(agent) { return !this.#disposed && !this.#runtime.disposed && this.#owns(agent) === true }
  attachAgent(agent) {
    if (!this.owns(agent) || typeof agent?.session?.id !== 'string') throw new MemoryError('IMAGE_AGENT_SCOPE_DENIED')
    controllers.set(agent, this); this.#agents.add(agent)
  }
  capture(agent, event) {
    if (!this.owns(agent)) return
    if (event?.type === 'agent/inbox/spliced') {
      // Pending input can withdraw an older grant but cannot authorize a save.
      if (event.data?.inserted?.some((message) => message?.role === 'user' && message.source?.kind === 'user')) {
        const previous = this.#slots.get(agent.session.id)
        previous?.controller.abort()
        if (previous) previous.grant = null
      }
      return
    }
    if (event?.type !== 'user/message') return
    const parts = Array.isArray(event.data?.content) ? event.data.content : []
    const images = parts.filter((part) => part?.type === 'image' && part.attachment)
    const sessionId = agent.session.id, previous = this.#slots.get(sessionId)
    if (event.data?.role !== 'user' || event.data?.source?.kind !== 'user') {
      if (images.length) { previous?.controller.abort(); this.#slots.delete(sessionId) }
      return
    }
    this.attachAgent(agent)
    previous?.controller.abort()
    const controller = new AbortController()
    const caption = parts.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n')
    const reference = images.length ? Object.freeze(structuredClone(images.at(-1).attachment)) : previous?.reference
    const slot = { agent, controller, reference, attachmentProvider: images.length ? original(this.#attachments()) : previous?.attachmentProvider,
      image_message_id: images.length ? event.data.id : previous?.image_message_id, grant: null }
    this.#slots.set(sessionId, slot)
    if (!reference || !Number.isFinite(event.time) || !Number.isSafeInteger(event.seq) || typeof event.data.id !== 'string' ||
      caption.length > 8000 || !caption.isWellFormed() || retentionBlockReason(caption) || quotation.test(caption) || !consent.test(caption)) return
    const identity = this.#runtime.state.identity
    const consentId = `consent-${digest({ ...identity, session_id: sessionId, message_id: event.data.id,
      image_message_id: slot.image_message_id, attachment_id: reference.attachmentId }).slice(0, 40)}`
    slot.grant = { ...identity, consent_id: consentId, session_id: sessionId, message_id: event.data.id,
      image_message_id: slot.image_message_id, observed_at: new Date(event.time).toISOString(), content: caption,
      source: 'user', allow_persist: true }
  }
  async #resolve(id, context) {
    const slot = this.#slots.get(context.session_id)
    if (!slot?.grant || slot.grant.consent_id !== id) throw new MemoryError('IMAGE_CONSENT_REQUIRED')
    const attachments = this.#attachments()
    const provider = original(attachments)
    const isCurrent = () => this.owns(slot.agent) && this.#slots.get(context.session_id) === slot && !slot.controller.signal.aborted &&
      slot.attachmentProvider === provider && original(this.#attachments()) === provider
    if (!isCurrent()) throw new MemoryError('IMAGE_CONSENT_REVOKED')
    if (typeof attachments?.readImage !== 'function') throw new MemoryError('IMAGE_ATTACHMENT_UNAVAILABLE')
    let image
    try { image = await attachments.readImage(slot.reference, AbortSignal.any([slot.controller.signal, AbortSignal.timeout(10000)])) }
    catch { throw new MemoryError('IMAGE_ATTACHMENT_UNAVAILABLE') }
    if (!isCurrent() || original(this.#attachments()) !== original(attachments)) throw new MemoryError('IMAGE_CONSENT_REVOKED')
    return { ...slot.grant, image, signal: slot.controller.signal, isCurrent }
  }
  async view(agent, args = {}, { signal } = {}) {
    try {
      assertOnly(args, ['recent_image'])
      if (args.recent_image !== true) throw new MemoryError('CURRENT_ATTACHMENT_ONLY')
      this.attachAgent(agent)
      const session = agent.session, slot = this.#slots.get(session.id), attachments = this.#attachments(), llm = this.#llm?.()
      if (!slot?.reference || slot.agent !== agent || slot.attachmentProvider !== original(attachments) || typeof attachments?.readImage !== 'function') throw new MemoryError('IMAGE_ATTACHMENT_UNAVAILABLE')
      const route = () => {
        const header = agent.session.requestHeader?.()?.config
        return { provider: header?.provider ?? agent.options?.provider, model: header?.model ?? agent.options?.model }
      }
      const selected = route()
      if (typeof llm?.resolveModelInfo !== 'function' || !selected.provider || !selected.model) throw new MemoryError('IMAGE_ROUTE_UNAVAILABLE')
      const current = () => this.owns(agent) && agent.session === session && this.#slots.get(session.id) === slot &&
        !slot.controller.signal.aborted && !signal?.aborted && original(this.#attachments()) === original(attachments) &&
        original(this.#llm?.()) === original(llm) && JSON.stringify(route()) === JSON.stringify(selected)
      const check = () => { if (!current()) throw new MemoryError('IMAGE_VIEW_REVOKED') }
      check()
      const joined = AbortSignal.any([slot.controller.signal, ...(signal ? [signal] : []), AbortSignal.timeout(10000)])
      const task = (async () => {
        const info = await llm.resolveModelInfo(selected.provider, selected.model, joined)
        check(); joined.throwIfAborted()
        if (!info?.inputModalities?.includes('image')) throw new MemoryError('IMAGE_ROUTE_UNAVAILABLE')
        const stored = await attachments.readImage(slot.reference, joined)
        check(); joined.throwIfAborted()
        if (!stored?.ref || stored.ref.attachmentId !== slot.reference.attachmentId || !(stored.data instanceof Uint8Array) ||
          stored.ref.bytes !== stored.data.byteLength || stored.data.byteLength > 8 * 1024 * 1024 ||
          stored.ref.attachmentId !== `sha256:${digest(Buffer.from(stored.data))}` || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(stored.ref.mediaType) ||
          ![stored.ref.width, stored.ref.height].every((value) => Number.isSafeInteger(value) && value > 0)) throw new MemoryError('IMAGE_ATTACHMENT_UNAVAILABLE')
        const image = Object.fromEntries(['attachmentId', 'mediaType', 'bytes', 'width', 'height'].map((key) => [key, stored.ref[key]]))
        if (typeof stored.ref.name === 'string' && !/[\/\\\0]/.test(stored.ref.name)) image.name = stored.ref.name
        return { status: 'ok', text: '这是当前会话的图片；查看没有把它存入长期记忆。', image }
      })()
      this.#pending.add(task)
      try { return await task } finally { this.#pending.delete(task) }
    } catch (error) { return { ...unavailable(error.code), text: '当前图片暂时无法查看。' } }
  }
  #context(agent) {
    this.attachAgent(agent)
    return this.#runtime.state.issueContext(agent.session.id, ['memory.read', 'memory.write'])
  }
  async #url(asset, agent) {
    if (!this.owns(agent) || typeof this.#preview !== 'function') return null
    try {
      const candidate = await this.#preview(asset, agent)
      if (typeof candidate !== 'string') return null
      const url = new URL(candidate)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
        url.pathname !== assetPath(this.#runtime.store.spaceRoot, asset.file)) return null
      return url.href
    } catch { return null }
  }
  async save(agent, args = {}, { signal } = {}) {
    try {
      assertOnly(args, ['recent_image', 'description', 'tags'])
      if (args.recent_image !== undefined && args.recent_image !== true) throw new MemoryError('CURRENT_ATTACHMENT_ONLY')
      const context = this.#context(agent), slot = this.#slots.get(agent.session.id)
      if (!slot?.grant) throw new MemoryError('IMAGE_CONSENT_REQUIRED')
      const task = this.assets.save({ consent_id: slot.grant.consent_id, description: args.description, tags: args.tags }, context, { signal })
      this.#pending.add(task)
      let result
      try { result = await task } finally { this.#pending.delete(task) }
      if (result.status !== 'committed' || !result.asset) return unavailable(result.reason_code)
      const preview = await this.#url(result.asset, agent)
      return { status: 'committed', asset_id: result.asset_id, ...(preview ? { preview_url: preview } : {}),
        text: `这张图我收进贝壳里了。\nasset_id: ${result.asset_id}\n\n${preview ? `![已保存的图片](${preview})` : '当前没有可展示地址。'}` }
    } catch (error) { return unavailable(error.code) }
  }
  async find(agent, args = {}) {
    const values = await this.assets.list({ asset_id: args.asset_id, query: args.query ?? '', tag: args.tag ?? '', limit: 1 }, this.#context(agent))
    return values[0] ?? null
  }
  async recall(agent, args = {}) {
    try {
      assertOnly(args, ['asset_id', 'query', 'tag', 'limit'])
      const values = await this.assets.list(args, this.#context(agent)), items = []
      for (const asset of values) {
        const preview = await this.#url(asset, agent)
        items.push({ asset_id: asset.id, description: asset.description, tags: asset.tags, mime: asset.mime,
          ...(preview ? { preview_url: preview } : {}) })
      }
      return { status: 'ok', items, text: items.length ? items.map((item) => `asset_id: ${item.asset_id}\n${item.preview_url ? `![已保存的图片](${item.preview_url})` : '当前没有可展示地址。'}`).join('\n\n') : '口袋里没有找到这张图。' }
    } catch (error) { return unavailable(error.code) }
  }
  evidenceAllowed(id, context, meta) { return this.assets.evidenceAllowed(id, context, meta) }
  detachAgent(agent) {
    const slot = this.#slots.get(agent?.session?.id)
    if (slot?.agent === agent) { slot.controller.abort(); this.#slots.delete(agent.session.id) }
    if (controllers.get(agent) === this) controllers.delete(agent)
    this.#agents.delete(agent)
  }
  detachSession(sessionId) {
    for (const agent of this.#agents) if (agent.session?.id === sessionId) this.detachAgent(agent)
  }
  async dispose() {
    if (this.#disposed) return
    this.#disposed = true
    for (const agent of this.#agents) this.detachAgent(agent)
    await Promise.allSettled([...this.#pending])
  }
}

export function createPersonaImageTools(controller) {
  const definition = (name, description, properties, execute) => ({ name, description,
    parameters: { type: 'object', additionalProperties: false, properties },
    output: { schema: output, render: (_args, result) => [{ type: 'text', text: result.text }] },
    async execute(args, exec) {
      if (!exec?.agent) return unavailable('LIVE_AGENT_REQUIRED')
      return execute(exec.agent, args ?? {}, { signal: exec.signal })
    } })
  const view = { name: 'soul_view_image', description: '只查看当前会话真实用户上传的最近图片；无需长期保存同意。只接受recent_image:true，不接受路径、URL或图片编号。',
    parameters: { type: 'object', additionalProperties: false, properties: { recent_image: { type: 'boolean', const: true } }, required: ['recent_image'] },
    output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' }, status: { type: 'string' },
      reason_code: { type: 'string' }, image: { type: 'object', additionalProperties: true } }, required: ['text', 'status'] },
    render: (_args, result) => [{ type: 'text', text: result.text }, ...(result.status === 'ok' && result.image ? [{ type: 'image', attachment: result.image }] : [])] },
    async execute(args, exec) {
      if (!exec?.agent) return { ...unavailable('LIVE_AGENT_REQUIRED'), text: '当前图片暂时无法查看。' }
      return controller.view(exec.agent, args, { signal: exec.signal })
    } }
  return [view, definition('soul_meme_save', '只保存当前会话真实用户明确同意收下的最近图片。不能用参数授予同意；不接受路径或URL。成功后使用返回图片引用，不能另找内部文件。', {
    recent_image: { type: 'boolean' }, description: { type: 'string', maxLength: 240 },
    tags: { type: 'array', maxItems: 24, items: { type: 'string', maxLength: 64 } },
  }, (agent, args, call) => controller.save(agent, args, call)),
  definition('soul_meme_recall', '按编号、描述或标签找回当前个体已获同意保存的图片。使用返回的展示引用，不通过通用工具寻找内部图片路径。', {
    asset_id: { type: 'string' }, query: { type: 'string', maxLength: 2000 }, tag: { type: 'string', maxLength: 64 },
    limit: { type: 'integer', minimum: 1, maximum: 10 },
  }, (agent, args) => controller.recall(agent, args))]
}
