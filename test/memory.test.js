import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../src/memory/store.js'
import { buildCandidate, findMergeCandidate, mergeCandidate } from '../src/memory/dedupe.js'
import { buildL0, searchEntries, renderRecall } from '../src/memory/retrieval.js'
import { runDream } from '../src/memory/decay.js'
import { localDateKey } from '../src/memory/schema.js'
import { saveAsset, findAsset } from '../src/memory/assets.js'

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-whale-soul-test-'))
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true })
}

function create(store, input) {
  const candidate = buildCandidate(input)
  store.createEntry(candidate.meta, candidate.layers)
  return candidate.meta
}

test('creates the layered store and rebuildable index', () => {
  const root = tempRoot()
  try {
    const store = new MemoryStore({ root, watch: false }).ensure()
    assert.ok(existsSync(join(root, 'entries')))
    assert.ok(existsSync(join(root, 'index.json')))
    assert.ok(existsSync(join(root, 'index.md')))
    const meta = create(store, {
      content: '主人最喜欢热腾腾的白米饭。',
      title: '主人喜欢米饭',
      type: 'preference',
      tags: ['who:master', 'topic:food/rice', 'mood:warm'],
      emotional_weight: 78,
    })
    assert.match(meta.tags.join(' '), /kind:preference/)
    const entryDir = join(root, 'entries', meta.id)
    assert.ok(existsSync(join(entryDir, 'gist.md')))
    assert.ok(existsSync(join(entryDir, 'detail.md')))
    assert.ok(existsSync(join(entryDir, 'raw.jsonl')))
    store.touch(store.find(meta.id))
    store.reload()
    assert.equal(store.find(meta.id).user_edited, false)
    const l0 = buildL0(store.active())
    assert.match(l0, /主人喜欢米饭/)
    assert.doesNotMatch(l0, /\d+ 条/)
    rmSync(join(root, 'index.json'))
    rmSync(join(root, 'index.md'))
    store.reload()
    assert.ok(existsSync(join(root, 'index.json')))
    assert.ok(existsSync(join(root, 'index.md')))
  } finally {
    cleanup(root)
  }
})

test('merges similar memories and keeps one entry', () => {
  const root = tempRoot()
  try {
    const store = new MemoryStore({ root, watch: false }).ensure()
    create(store, {
      content: '主人最喜欢热腾腾的白米饭。',
      title: '主人喜欢米饭',
      type: 'preference',
      tags: ['who:master', 'topic:food/rice', 'mood:warm'],
      emotional_weight: 78,
    })
    const next = buildCandidate({
      content: '主人今天又说了一次，白米饭是最喜欢的。',
      title: '主人还是喜欢米饭',
      type: 'preference',
      tags: ['who:master', 'topic:food/rice', 'mood:warm'],
      emotional_weight: 82,
    })
    const found = findMergeCandidate(store.active(), next)
    assert.ok(found)
    const merged = mergeCandidate(found.entry, next, {
      existingDetail: store.readDetail(found.entry),
      existingRaw: store.readRaw(found.entry),
    })
    assert.equal(merged.action, 'merge')
    store.updateEntry(found.entry, merged.layers)
    assert.equal(store.active().length, 1)
    assert.match(store.readDetail(found.entry), /白米饭是最喜欢的/)
    const recall = renderRecall(searchEntries(store.active(), { query: '米饭' }), store, 'detail')
    assert.match(recall, /我想起来了/)
  } finally {
    cleanup(root)
  }
})

test('external edits become user corrections and are not auto-merged', () => {
  const root = tempRoot()
  try {
    const store = new MemoryStore({ root, watch: false }).ensure()
    const meta = create(store, {
      content: '主人喜欢米饭。',
      title: '米饭',
      type: 'preference',
      tags: ['who:master', 'topic:food/rice'],
      emotional_weight: 60,
    })
    const gistPath = join(root, 'entries', meta.id, 'gist.md')
    writeFileSync(gistPath, '主人其实更喜欢面条。\n', 'utf8')
    const future = new Date(Date.now() + 10_000)
    utimesSync(gistPath, future, future)
    store.reload()
    const edited = store.find(meta.id)
    assert.equal(edited.user_edited, true)
    assert.equal(edited.source, 'user')
    const candidate = buildCandidate({
      content: '主人说喜欢米饭。',
      title: '米饭',
      type: 'preference',
      tags: ['who:master', 'topic:food/rice'],
      emotional_weight: 61,
    })
    const found = findMergeCandidate(store.active(), candidate)
    assert.ok(found)
    const merged = mergeCandidate(found.entry, candidate, { existingDetail: store.readDetail(found.entry) })
    assert.equal(merged.action, 'link')
  } finally {
    cleanup(root)
  }
})

test('decay moves details to cold storage, writes a dream, and protects pinned entries', () => {
  const root = tempRoot()
  try {
    const store = new MemoryStore({ root, watch: false }).ensure()
    const meta = create(store, {
      content: '今天和主人聊了一件很小的事。'.repeat(12),
      title: '小事',
      type: 'episode',
      tags: ['who:master', 'topic:smalltalk'],
      emotional_weight: 20,
    })
    const pinned = create(store, {
      content: '主人不喜欢被叫胖。',
      title: '边界',
      type: 'identity',
      tags: ['who:master', 'topic:boundaries', 'kind:identity'],
      emotional_weight: 95,
      pinned: true,
    })
    const entry = store.find(meta.id)
    entry.created_at = new Date(Date.now() - 500 * 86_400_000).toISOString()
    entry.updated_at = entry.created_at
    entry.last_access = entry.created_at
    entry.salience.total = 0.1
    const pinnedEntry = store.find(pinned.id)
    pinnedEntry.created_at = new Date(Date.now() - 500 * 86_400_000).toISOString()
    pinnedEntry.updated_at = pinnedEntry.created_at
    pinnedEntry.last_access = pinnedEntry.created_at
    runDream(store, {})
    assert.ok(existsSync(join(root, 'cold', meta.id)))
    assert.equal(store.find(meta.id).layers.detail, false)
    assert.equal(store.find(pinned.id).layers.detail, true)
    const dream = readFileSync(join(root, 'dreams', `${localDateKey()}.md`), 'utf8')
    assert.match(dream, /梦|睡|醒|潮水|尾巴/)
    assert.doesNotMatch(dream, /压缩|归档|条数|整理完成/)
    store.addDream('又打了一个盹。')
    assert.match(readFileSync(join(root, 'dreams', `${localDateKey()}.md`), 'utf8'), /又打了一个盹/)
  } finally {
    cleanup(root)
  }
})

test('quarantines broken meta files instead of crashing the store', () => {
  const root = tempRoot()
  try {
    const store = new MemoryStore({ root, watch: false }).ensure()
    const meta = create(store, {
      content: '一条正常记忆。',
      title: '正常',
      type: 'fact',
      tags: ['topic:test'],
      emotional_weight: 30,
    })
    writeFileSync(join(root, 'entries', meta.id, 'meta.json'), '{broken', 'utf8')
    store.reload()
    assert.equal(store.find(meta.id), undefined)
    const quarantined = readdirSync(join(root, 'quarantine'))
    assert.equal(quarantined.length > 0, true)
  } finally {
    cleanup(root)
  }
})

test('stores image assets content-addressed and finds them by tag', async () => {
  const root = tempRoot()
  try {
    const store = new MemoryStore({ root, watch: false }).ensure()
    const image = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082',
      'hex',
    )
    const source = join(root, 'meme.png')
    writeFileSync(source, image)
    const asset = await saveAsset(store, {
      filePath: source,
      description: '开心的表情',
      tags: ['mood:happy', 'use:撒娇'],
    })
    assert.ok(existsSync(join(root, 'assets', asset.file)))
    assert.equal(findAsset(store, { tag: 'mood:happy' })?.id, asset.id)
    assert.match(asset.file, /^[a-f0-9]{64}\.png$/)
  } finally {
    cleanup(root)
  }
})
