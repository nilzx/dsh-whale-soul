import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { apply } from '../src/locale.js'

function fakeContext(preference) {
  const service = {
    rows: [
      { id: 'whale-soul', name: '鲸鱼娘', description: '中文描述' },
      { id: 'whale-girl', name: '鲸鱼娘（旧会话）', description: '中文旧会话描述' },
      { id: 'standard', name: 'Standard' },
    ],
    async list() {
      return this.rows
    },
    async readDocument(id) {
      const row = this.rows.find((item) => item.id === id)
      return { agentPreset: id, name: row?.name, description: row?.description, content: '' }
    },
  }
  const disposers = []
  const ctx = {
    agentPresets: service,
    settings: {
      describe() {
        return [{ ns: 'locale', value: { preference } }]
      },
    },
    baseUrl: 'file:///definitely-not-a-profile/',
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
  }
  return { ctx, service, disposers }
}

test('localizes preset names and descriptions for zh and non-zh locales', async () => {
  for (const [preference, soulName, legacyName, description] of [
    ['zh', '鲸鱼娘', '鲸鱼娘（旧会话）', '一只住在 DSH 里的鲸鱼娘'],
    ['zh-CN', '鲸鱼娘', '鲸鱼娘（旧会话）', '一只住在 DSH 里的鲸鱼娘'],
    ['en', 'Whale Chan', 'Whale Chan (Legacy)', 'A Whale Chan who lives in DSH'],
    ['ja', 'Whale Chan', 'Whale Chan (Legacy)', 'A Whale Chan who lives in DSH'],
  ]) {
    const { ctx, service, disposers } = fakeContext(preference)
    apply(ctx)
    const rows = await service.list()
    assert.equal(rows.find((row) => row.id === 'whale-soul').name, soulName)
    assert.equal(rows.find((row) => row.id === 'whale-girl').name, legacyName)
    assert.match(rows.find((row) => row.id === 'whale-soul').description, new RegExp(description))
    assert.equal(rows.find((row) => row.id === 'standard').name, 'Standard')
    const document = await service.readDocument('whale-soul')
    assert.equal(document.name, soulName)
    disposers[0]()
    assert.equal((await service.list()).find((row) => row.id === 'whale-soul').name, '鲸鱼娘')
  }
})

test('falls back to the profile patch when settings cannot describe the locale', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-whale-soul-locale-'))
  try {
    writeFileSync(join(root, 'cordis.patch.yml'), '- id: locale\n  config:\n    preference: zh\n')
    const { ctx, service, disposers } = fakeContext('en')
    ctx.settings.describe = () => {
      throw new Error('settings unavailable')
    }
    ctx.baseUrl = pathToFileURL(join(root, '')).href
    apply(ctx)
    const rows = await service.list()
    assert.equal(rows.find((row) => row.id === 'whale-soul').name, '鲸鱼娘')
    disposers[0]()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
