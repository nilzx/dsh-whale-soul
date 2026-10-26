import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, runtimeFor } from '../src/memory/plugin.js'

function fakeContext() {
  const tools = new Map()
  const contexts = []
  const disposers = []
  const listeners = new Map()
  return {
    systemPrompt: {
      context(definition) {
        contexts.push(definition)
        return () => {}
      },
    },
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
    contexts,
    toolsMap: tools,
    disposers,
    listeners,
  }
}

test('memory plugin exposes only the L0 directory and in-character memory tools', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-whale-soul-plugin-'))
  try {
    const ctx = fakeContext()
    apply(ctx, { root, autoDream: false, watch: false })
    const runtime = runtimeFor(ctx)
    assert.equal(ctx.contexts.length, 1)
    assert.deepEqual([...ctx.toolsMap.keys()].sort(), [
      'soul_forget',
      'soul_meme_save',
      'soul_recall',
      'soul_remember',
    ])
    const empty = ctx.contexts[0].text()
    assert.match(empty, /第一次相遇/)

    const remembered = await ctx.toolsMap.get('soul_remember').execute({
      content: '主人最喜欢热腾腾的白米饭，今天又说了一次。',
      title: '主人喜欢米饭',
      type: 'preference',
      tags: ['who:master', 'topic:food/rice', 'mood:warm'],
      emotional_weight: 82,
    }, {})
    assert.equal(remembered.text, '记下了。')

    const l0 = ctx.contexts[0].text()
    assert.match(l0, /主人喜欢米饭/)
    assert.doesNotMatch(l0, /条记忆|已加载|压缩|归档|索引/)
    assert.ok(l0.length < 2400)

    const recalled = await ctx.toolsMap.get('soul_recall').execute({ query: '米饭', depth: 'detail' }, {})
    assert.match(recalled.text, /我想起来了/)
    assert.match(recalled.text, /白米饭/)
    assert.doesNotMatch(recalled.text, /找到|检索|soul_recall/)

    const entry = runtime.store.active()[0]
    const forgotten = await ctx.toolsMap.get('soul_forget').execute({ id: entry.id, mode: 'delete' }, {})
    assert.match(forgotten.text, /不再留着/)
    assert.equal(runtime.store.active().length, 0)
    for (const dispose of ctx.disposers) if (typeof dispose === 'function') await dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('memory plugin does not surface maintenance state or counts in the L0 context', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-whale-soul-plugin-'))
  try {
    const ctx = fakeContext()
    apply(ctx, { root, autoDream: false, watch: false })
    const runtime = runtimeFor(ctx)
    runtime.store.state.last_maintained_at = new Date().toISOString()
    runtime.store.state.writes_since_maintenance = 40
    runtime.store.saveState()
    const text = ctx.contexts[0].text()
    assert.doesNotMatch(text, /maintenance|maintained|整理|dream|睡眠|compressed|archive/i)
    for (const dispose of ctx.disposers) if (typeof dispose === 'function') await dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
