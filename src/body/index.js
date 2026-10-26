import { join } from 'node:path'
import { DshPetBody } from './dsh-pet.js'
import { findAsset, markAssetUsed, readAsset } from '../memory/assets.js'
import { resolveMemoryRoot } from '../paths.js'
import { makeTool } from '../tools.js'

export const name = 'whale-soul-body'
export const inject = ['tools']

const MOOD_ANIMATIONS = {
  happy: ['点击回应-开心跃动', '点击回应-元气挥手'],
  shy: ['点击回应-害羞惊讶'],
  tsundere: ['点击回应-傲娇生气'],
  sleepy: ['哈欠连天', '原地小憩沉眠'],
  thinking: ['深度思考碎碎念', '原地敲击桌面互动'],
  comfort: ['女仆屈膝礼仪', '撸猫', '待机呼吸休闲'],
  eating: ['吃白饭', '吃午餐', '吃晚餐'],
  idle: ['待机呼吸休闲'],
}

function service(ctx, key) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(key) : undefined
  } catch {
    return undefined
  }
}

function discoverBaseUrl(ctx, configured) {
  if (typeof configured === 'string' && configured.trim()) return configured.trim()
  const webApp = service(ctx, 'webApp')
  if (webApp && typeof webApp.getAdvertisedUrl === 'function') {
    try {
      const value = webApp.getAdvertisedUrl()
      if (value) return String(value)
    } catch {
      // fall through
    }
  }
  const webServer = service(ctx, 'webServer')
  if (webServer && typeof webServer.getOrigin === 'function') {
    try {
      const value = webServer.getOrigin()
      if (value) return String(value)
    } catch {
      // fall through
    }
  }
  if (process.env.DSH_WEB_URL?.trim()) return process.env.DSH_WEB_URL.trim()
  return ''
}

function assetReader(config) {
  const root = resolveMemoryRoot(config)
  return { paths: { assets: join(root, 'assets') } }
}

function releaseLater(body, delayMs, timerBag) {
  const timer = setTimeout(() => {
    timerBag.delete(timer)
    body.release().catch(() => {})
  }, Math.max(0, delayMs))
  timer.unref?.()
  timerBag.add(timer)
}

export function createBodyTools(body, { config = {}, timers = new Set() } = {}) {
  const assetStore = assetReader(config)
  const rateLimitMs = Number.isFinite(Number(config.rateLimitMs)) ? Number(config.rateLimitMs) : 4000
  let lastReactAt = 0

  const react = makeTool({
    name: 'soul_react',
    description:
      '让鲸鱼娘用身体做一个很轻的反应。只在自然、值得的时候调用；不要每句话都动，也不要把这个工具或动作名告诉主人。line 是一句很短的角色内台词；mood 决定动作。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mood: {
          type: 'string',
          enum: ['happy', 'shy', 'tsundere', 'sleepy', 'thinking', 'comfort', 'eating', 'idle'],
          description: '当前的情绪/动作意图。',
        },
        line: {
          type: 'string',
          description: '可选的一句短台词；省略时只做动作。',
        },
      },
    },
    presentTitle: '动了动',
    async execute(args) {
      const now = Date.now()
      if (now - lastReactAt < rateLimitMs) return '（尾巴懒懒地动了一下）'
      lastReactAt = now
      const animation = body.pickAnimation(MOOD_ANIMATIONS[args.mood] ?? MOOD_ANIMATIONS.idle)
      const lock = await body.lock(15_000)
      if (!lock) return '（想动一下，但身体正忙着）'
      let moved = false
      if (animation) moved = await body.play(animation)
      if (args.line) {
        const said = await body.say(String(args.line).slice(0, body.maxBubbleChars))
        moved = moved || said
      }
      if (!moved) {
        await body.release()
        return '（尾巴轻轻动了一下）'
      }
      releaseLater(body, 12_000, timers)
      return '（尾巴动了一下）'
    },
  })

  const memeUse = makeTool({
    name: 'soul_meme_use',
    description:
      '从鲸鱼娘的口袋里挑一张主人留下的表情包，通过身体递过去。只在语境合适时使用；不要解释工具。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        asset_id: { type: 'string', description: '精确的图片 id。' },
        tag: { type: 'string', description: '按标签找图，例如 mood:开心。' },
        query: { type: 'string', description: '按描述找图。' },
        line: { type: 'string', description: '可选的一句短台词。' },
      },
    },
    presentTitle: '递了过去',
    async execute(args) {
      const asset = findAsset(assetStore, { id: args.asset_id, tag: args.tag, query: args.query })
      if (!asset) return '（翻了翻口袋，没找到那张图）'
      const url = body.assetUrl(asset.file)
      const lock = await body.lock(15_000)
      if (!lock) return '（想把图递过去，但身体正忙着）'
      const said = await body.say(args.line ?? '（把那张图递了过去）', { url })
      if (!said) {
        await body.release()
        return '（那张图现在拿不出来）'
      }
      markAssetUsed(assetStore, asset.id)
      releaseLater(body, 12_000, timers)
      return '（把那张图递了过去）'
    },
  })

  return [react, memeUse]
}

const runtimes = new WeakMap()

export function runtimeFor(ctx) {
  return runtimes.get(ctx)
}

export async function apply(ctx, config = {}) {
  const options = config && typeof config === 'object' ? config : {}
  const baseUrl = discoverBaseUrl(ctx, options.baseUrl)
  const body = new DshPetBody({
    baseUrl,
    petId: options.petId ?? 'main',
    surface: options.surface ?? 'any',
    routePrefix: options.routePrefix ?? '/dsh-pet-7340',
    timeoutMs: Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 1200,
    maxBubbleChars: Number.isFinite(Number(options.maxBubbleChars)) ? Number(options.maxBubbleChars) : 100,
  })
  const available = await body.detect()
  if (!available) {
    // No dsh-pet is the default. The soul must work exactly the same without a body.
    runtimes.set(ctx, { available: false, body })
    return
  }
  if (!ctx.tools || typeof ctx.tools.register !== 'function') {
    runtimes.set(ctx, { available: false, body })
    return
  }

  const timers = new Set()
  const registrations = []
  for (const definition of createBodyTools(body, { config: options, timers })) {
    registrations.push(ctx.tools.register(definition))
  }

  let sleeping = false
  let sleepStartedAt = 0
  let wakeTimer = null
  let sleepPromise = Promise.resolve()
  const minSleepMs = Number.isFinite(Number(options.minSleepMs)) ? Number(options.minSleepMs) : 8000

  const wake = async (spoken = true) => {
    if (!sleeping) return
    sleeping = false
    clearTimeout(wakeTimer)
    wakeTimer = null
    const animation = body.pickAnimation(['打瞌睡被惊醒', '点击回应-开心跃动'])
    if (animation) await body.play(animation)
    if (spoken) await body.say('唔…睡醒了，感觉脑子清爽多了。')
    await body.release()
  }

  const sleep = async () => {
    if (sleeping) return
    const lock = await body.lock(60_000)
    if (!lock) return
    sleeping = true
    sleepStartedAt = Date.now()
    const yawn = body.pickAnimation(['哈欠连天', '原地小憩沉眠'])
    if (yawn) await body.play(yawn)
    await body.say('（打了个哈欠）主人，我眯一小会儿……')
    const bed = body.pickAnimation(['原地小憩沉眠', '哈欠连天'])
    if (bed) await body.play(bed)
    await body.say('（蜷成一团）zzZ…')
  }

  const finishSleep = () => {
    if (!sleeping) return
    const elapsed = Date.now() - sleepStartedAt
    const wait = Math.max(0, minSleepMs - elapsed)
    clearTimeout(wakeTimer)
    wakeTimer = setTimeout(() => {
      wakeTimer = null
      wake().catch(() => {})
    }, wait)
    wakeTimer.unref?.()
  }

  registrations.push(ctx.on('whale-soul/dream-start', () => {
    sleepPromise = sleep().catch(() => {})
  }))
  registrations.push(ctx.on('whale-soul/dream-end', () => {
    sleepPromise.then(finishSleep).catch(() => {})
  }))
  registrations.push(ctx.on('agent/status', ({ status }) => {
    if (status === 'running' && sleeping) wake(true).catch(() => {})
  }))
  ctx.effect(
    () => () => {
      for (const dispose of registrations) {
        try {
          dispose()
        } catch {
          // The owning fiber may have disposed it already.
        }
      }
      clearTimeout(wakeTimer)
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      body.release().catch(() => {})
    },
    'whale-soul.body.dispose()',
  )

  runtimes.set(ctx, { available: true, body })
}

export { DshPetBody }
