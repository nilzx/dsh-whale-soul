import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { DshPetBody } from '../src/body/dsh-pet.js'
import { apply as applyBody, runtimeFor as bodyRuntimeFor } from '../src/body/index.js'

function fakeContext() {
  const tools = new Map()
  const disposers = []
  const listeners = new Map()
  return {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    on(event, listener) {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    emit() {},
    get() {
      return undefined
    },
    toolsMap: tools,
    disposers,
    listeners,
  }
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

test('DshPetBody detects a body and calls only existing routes', async () => {
  const calls = []
  const body = new DshPetBody({
    baseUrl: 'http://127.0.0.1:12345',
    petId: 'main',
    surface: 'any',
    fetchImpl: async (url, init) => {
      const parsed = new URL(url)
      calls.push({ path: parsed.pathname, search: parsed.search, method: init.method, body: init.body })
      if (parsed.pathname.endsWith('/state')) return jsonResponse({ sections: {} })
      if (parsed.pathname.endsWith('/config')) {
        return jsonResponse({
          pets: [{ id: 'main', display: 'both' }],
          animations: {
            idle: ['待机呼吸休闲'],
            clicks: ['点击回应-开心跃动'],
            categories: [{ actions: ['原地小憩沉眠'] }],
            events: { whisper: ['哈欠连天'] },
          },
        })
      }
      if (parsed.pathname.endsWith('/lock')) return jsonResponse({ ok: true, lockId: 'lock-1' })
      return jsonResponse({ ok: true })
    },
  })
  assert.equal(await body.detect(), true)
  assert.equal(body.petId, 'main')
  assert.ok(body.animations.includes('点击回应-开心跃动'))
  assert.ok(body.animations.includes('哈欠连天'))
  assert.equal(body.pickAnimation(['不存在', '点击回应-开心跃动']), '点击回应-开心跃动')
  assert.equal(await body.say('（尾巴动了动）'), true)
  assert.equal(await body.play('点击回应-开心跃动'), true)
  assert.equal(await body.lock(), 'lock-1')
  assert.equal(await body.release(), true)
  assert.ok(calls.some((call) => call.path.endsWith('/broadcast')))
  assert.ok(calls.some((call) => call.path.endsWith('/anim')))
  assert.ok(calls.some((call) => call.path.endsWith('/lock')))
})

test('body adapter disables itself without a base URL', async () => {
  const body = new DshPetBody({ baseUrl: '', fetchImpl: async () => jsonResponse({}) })
  assert.equal(await body.detect(), false)
  assert.equal(body.available, false)
})

test('body plugin registers no body tools when dsh-pet is absent', async () => {
  const previous = process.env.DSH_WEB_URL
  delete process.env.DSH_WEB_URL
  try {
    const ctx = fakeContext()
    await applyBody(ctx, {})
    assert.equal(bodyRuntimeFor(ctx).available, false)
    assert.equal(ctx.toolsMap.size, 0)
    assert.equal(ctx.disposers.length, 0)
  } finally {
    if (previous === undefined) delete process.env.DSH_WEB_URL
    else process.env.DSH_WEB_URL = previous
  }
})

test('body plugin detects a local dsh-pet and registers soul_react', async () => {
  const requests = []
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    requests.push({ path: url.pathname, search: url.search, method: req.method })
    if (url.pathname.endsWith('/state')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ sections: {} }))
      return
    }
    if (url.pathname.endsWith('/config')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        pets: [{ id: 'main', display: 'both' }],
        animations: {
          idle: ['待机呼吸休闲'],
          clicks: ['点击回应-开心跃动'],
          categories: [{ actions: ['原地小憩沉眠'] }],
        },
      }))
      return
    }
    if (url.pathname.endsWith('/lock')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, lockId: 'body-lock' }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const previous = process.env.DSH_WEB_URL
  process.env.DSH_WEB_URL = `http://127.0.0.1:${server.address().port}`
  try {
    const ctx = fakeContext()
    await applyBody(ctx, { rateLimitMs: 0, minSleepMs: 10 })
    const runtime = bodyRuntimeFor(ctx)
    assert.equal(runtime.available, true)
    assert.ok(ctx.toolsMap.has('soul_react'))
    assert.ok(ctx.toolsMap.has('soul_meme_use'))
    const tool = ctx.toolsMap.get('soul_react')
    const value = await tool.execute({ mood: 'happy', line: '嘿嘿。' }, {})
    assert.equal(value.text, '（尾巴动了一下）')
    assert.ok(requests.some((request) => request.path.endsWith('/anim')))
    assert.ok(requests.some((request) => request.path.endsWith('/broadcast')))
    await runtime.body.release()
    for (const dispose of ctx.disposers) await dispose()
  } finally {
    if (previous === undefined) delete process.env.DSH_WEB_URL
    else process.env.DSH_WEB_URL = previous
    await new Promise((resolve) => server.close(resolve))
  }
})
