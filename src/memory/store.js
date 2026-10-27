import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  watch,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import {
  DAY_MS,
  TYPE_LABEL,
  TYPES,
  effectiveLayer,
  normalizeEntryMeta,
  nowIso,
  localDateKey,
  parseTime,
  summarize,
} from './schema.js'
import { resolveMemoryRoot } from '../paths.js'

const META = 'meta.json'
const GIST = 'gist.md'
const DETAIL = 'detail.md'
const RAW = 'raw.jsonl'
const INDEX_JSON = 'index.json'
const INDEX_MD = 'index.md'
const STATE_JSON = 'state.json'
const OBSERVATIONS_JSON = 'write-observations.json'
const ENTRY_FILES = [META, GIST, DETAIL, RAW]

function observeEntry(dir) {
  const files = Object.fromEntries(ENTRY_FILES.map((file) => {
    const path = join(dir, file)
    return [file, existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null]
  }))
  return { files, summary: safeJson(readText(join(dir, META)), {})?.summary ?? null }
}

function changedFiles(before, after) {
  return ENTRY_FILES.filter((file) => before.files?.[file] !== after.files[file])
}

function safeJson(text, fallback = null) {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

function readText(path, fallback = '') {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return fallback
  }
}

function atomicWrite(path, text, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`
  writeFileSync(tmp, text, { encoding: 'utf8', mode })
  renameSync(tmp, path)
  try {
    chmodSync(path, mode)
  } catch {
    // Best-effort hardening; content is already durable.
  }
}

function defaultState() {
  return {
    schema_version: 1,
    created_at: nowIso(),
    last_maintained_at: null,
    last_dream_at: null,
    writes_since_maintenance: 0,
    total_writes: 0,
    last_error: null,
  }
}

function isInside(parent, child) {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !rel.includes(`..${sep}`))
}

function topicSlug(tag) {
  const value = tag.startsWith('topic:') ? tag.slice(6) : tag
  return value.replace(/[^a-z0-9\u3400-\u9fff_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'general'
}

export class MemoryStore {
  constructor(config = {}) {
    this.config = config && typeof config === 'object' ? config : {}
    this.root = resolveMemoryRoot(this.config)
    this.paths = {
      root: this.root,
      entries: join(this.root, 'entries'),
      topics: join(this.root, 'topics'),
      dreams: join(this.root, 'dreams'),
      assets: join(this.root, 'assets'),
      cold: join(this.root, 'cold'),
      quarantine: join(this.root, 'quarantine'),
      backups: join(this.root, 'backups'),
      indexJson: join(this.root, INDEX_JSON),
      indexMd: join(this.root, INDEX_MD),
      state: join(this.root, STATE_JSON),
      observations: join(this.root, OBSERVATIONS_JSON),
      externalChanges: join(this.root, 'external-changes'),
    }
    this.entries = new Map()
    this.state = defaultState()
    this.loaded = false
    this.activityAt = Date.now()
    this.watcher = null
    this.watchTimer = null
    this.reloading = false
    this.observations = new Map()
  }

  ensure() {
    for (const path of [
      this.paths.root,
      this.paths.entries,
      this.paths.topics,
      this.paths.dreams,
      this.paths.assets,
      this.paths.cold,
      this.paths.quarantine,
      this.paths.backups,
      this.paths.externalChanges,
    ]) {
      mkdirSync(path, { recursive: true, mode: 0o700 })
      try {
        chmodSync(path, 0o700)
      } catch {
        // Best effort.
      }
    }
    this.state = { ...defaultState(), ...(safeJson(readText(this.paths.state), {}) ?? {}) }
    const savedObservations = safeJson(readText(this.paths.observations), {})
    this.observations = new Map(Object.entries(savedObservations?.entries ?? {}))
    this.reload()
    this.saveState()
    this.startWatcher()
    return this
  }

  startWatcher() {
    if (this.watcher) return
    if (this.config.watch === false) {
      this.watchStatus = { status: 'disabled' }
      return
    }
    try {
      this.watcher = watch(this.paths.entries, { recursive: true }, () => {
        if (this.reloading) return
        clearTimeout(this.watchTimer)
        this.watchTimer = setTimeout(() => {
          this.watchTimer = null
          this.reload()
        }, 250)
        this.watchTimer.unref?.()
      })
      this.watcher.unref?.()
      this.watchStatus = { status: 'active' }
    } catch (error) {
      this.watcher = null
      this.watchStatus = { status: 'unavailable', reason_code: error?.code ?? 'WATCH_FAILED' }
    }
    this.state.watcher = this.watchStatus
    this.saveState()
  }

  stopWatcher() {
    clearTimeout(this.watchTimer)
    this.watchTimer = null
    this.watcher?.close?.()
    this.watcher = null
    this.watchStatus = { status: 'stopped' }
  }

  dispose() {
    this.stopWatcher()
  }

  reload({ writeIndex = true } = {}) {
    if (this.reloading) return
    this.reloading = true
    try {
      const next = new Map()
      for (const dirent of readdirSync(this.paths.entries, { withFileTypes: true })) {
        if (!dirent.isDirectory()) continue
        const id = dirent.name
        if (!/^[a-zA-Z0-9._-]+$/.test(id)) continue
        const dir = join(this.paths.entries, id)
        try {
          const rawMeta = safeJson(readText(join(dir, META)), null)
          if (!rawMeta) throw new Error('missing meta.json')
          const observed = observeEntry(dir)
          const previous = this.observations.get(id)
          const meta = normalizeEntryMeta(rawMeta, { id })
          meta.id = id
          const gistPath = join(dir, GIST)
          const detailPath = join(dir, DETAIL)
          const rawPath = join(dir, RAW)
          const gist = readText(gistPath, '')
          const hasGist = existsSync(gistPath)
          const hasDetail = existsSync(detailPath)
          const hasRaw = existsSync(rawPath)
          meta.layers = { gist: hasGist, detail: hasDetail, raw: hasRaw }
          // Digests only detect change; they do not grant authorship or authority.
          // Legacy stores without a write baseline retain the old mtime fallback.
          const metaTime = parseTime(meta.updated_at, 0) ?? 0
          const legacyLayersEdited = !previous && [gistPath, detailPath, rawPath]
            .filter((path) => existsSync(path))
            .some((path) => {
              try {
                return statSync(path).mtimeMs > metaTime + 2000
              } catch {
                return false
              }
            })
          const changed = previous ? changedFiles(previous, observed) : legacyLayersEdited ? [GIST, DETAIL, RAW] : []
          const gistChanged = changed.includes(GIST)
          const summaryChanged = previous && changed.includes(META) && previous.summary !== rawMeta.summary
          if (gistChanged) meta.summary = summarize(gist || meta.summary || meta.title, 220)
          else if (summaryChanged || (meta.user_edited && rawMeta.summary)) meta.summary = summarize(rawMeta.summary || gist || meta.title, 220)
          else meta.summary = summarize(gist || meta.summary || meta.title, 220)
          if (changed.length) {
            meta.user_edited = true
            meta.source = 'user'
            const changeDir = join(this.paths.externalChanges, id)
            atomicWrite(join(changeDir, `${Date.now()}-${Math.random().toString(16).slice(2)}.json`), JSON.stringify({
              at: nowIso(), id, changed_files: changed,
              before: previous ?? null, after: observed,
            }, null, 2))
          }
          meta.layer = effectiveLayer(meta)
          meta._gist = gist
          if (changed.length) this.saveMeta(meta)
          else this.observations.set(id, observed)
          next.set(id, meta)
        } catch (error) {
          this.quarantineEntry(dir, error instanceof Error ? error.message : String(error))
        }
      }
      this.entries = next
      for (const id of this.observations.keys()) if (!next.has(id)) this.observations.delete(id)
      this.loaded = true
      this.saveObservations()
      if (writeIndex) this.saveIndex()
    } finally {
      this.reloading = false
    }
  }

  quarantineEntry(dir, reason) {
    try {
      const stamp = Date.now()
      const target = join(this.paths.quarantine, `${dir.split(sep).pop()}-${stamp}`)
      mkdirSync(this.paths.quarantine, { recursive: true, mode: 0o700 })
      renameSync(dir, target)
      this.state.last_error = { at: nowIso(), reason: `quarantined ${dir.split(sep).pop()}: ${reason}` }
      this.saveState()
    } catch {
      // Leave the broken directory in place if it cannot be quarantined.
    }
  }

  saveState() {
    atomicWrite(this.paths.state, JSON.stringify(this.state, null, 2))
  }

  saveObservations() {
    atomicWrite(this.paths.observations, JSON.stringify({ schema_version: 1, entries: Object.fromEntries(this.observations) }, null, 2))
  }

  assertUnchanged(entry) {
    const previous = this.observations.get(entry.id)
    if (previous && changedFiles(previous, observeEntry(join(this.paths.entries, entry.id))).length) {
      this.reload()
      throw new Error('MEMORY_EXTERNAL_CHANGE: reload the protected revision before changing it')
    }
  }

  saveMeta(entry) {
    const meta = { ...entry }
    delete meta._gist
    delete meta.layer
    atomicWrite(join(this.paths.entries, entry.id, META), JSON.stringify(meta, null, 2))
    this.observations.set(entry.id, observeEntry(join(this.paths.entries, entry.id)))
    this.saveObservations()
  }

  writeLayer(entry, kind, text) {
    const file = kind === 'gist' ? GIST : kind === 'detail' ? DETAIL : RAW
    atomicWrite(join(this.paths.entries, entry.id, file), text)
    entry.layers[kind] = true
  }

  createEntry(meta, layers = {}) {
    const id = meta.id
    const dir = join(this.paths.entries, id)
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(id)) throw new Error('invalid memory id')
    if (existsSync(dir)) throw new Error('memory id already exists')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (typeof layers.gist === 'string') this.writeLayer(meta, 'gist', layers.gist)
    if (typeof layers.detail === 'string' && layers.detail.trim()) this.writeLayer(meta, 'detail', layers.detail)
    if (typeof layers.raw === 'string' && layers.raw.trim()) this.writeLayer(meta, 'raw', layers.raw)
    meta.layers = { ...meta.layers, ...layers.flags }
    if (!meta.layers.gist) meta.layers.gist = true
    meta.updated_at = nowIso()
    meta.created_at = meta.created_at ?? meta.updated_at
    meta.summary = summarize(layers.gist ?? meta._gist ?? '', 220)
    meta.layer = effectiveLayer(meta)
    this.saveMeta(meta)
    meta._gist = layers.gist ?? meta._gist ?? ''
    this.entries.set(id, meta)
    this.state.total_writes = (this.state.total_writes ?? 0) + 1
    this.state.writes_since_maintenance = (this.state.writes_since_maintenance ?? 0) + 1
    this.touchActivity()
    this.saveState()
    this.saveIndex()
    return meta
  }

  updateEntry(entry, patch) {
    this.assertUnchanged(entry)
    Object.assign(entry, patch)
    entry.updated_at = nowIso()
    if (typeof patch.gist === 'string') {
      entry._gist = patch.gist
      entry.summary = summarize(patch.gist, 220)
      this.writeLayer(entry, 'gist', patch.gist)
    }
    if (typeof patch.detail === 'string') this.writeLayer(entry, 'detail', patch.detail)
    if (typeof patch.raw === 'string') this.writeLayer(entry, 'raw', patch.raw)
    delete entry.gist
    delete entry.detail
    delete entry.raw
    entry.layer = effectiveLayer(entry)
    this.saveMeta(entry)
    this.touchActivity()
    this.saveState()
    this.saveIndex()
    return entry
  }

  touch(entry) {
    this.assertUnchanged(entry)
    entry.access_count = Math.max(0, Number(entry.access_count) || 0) + 1
    entry.last_access = nowIso()
    entry.salience = {
      ...(entry.salience ?? {}),
      recurrence: Math.min(1, (entry.salience?.recurrence ?? 0) + 0.04),
      total: Math.min(1, (entry.salience?.total ?? 0.4) + 0.01),
    }
    entry.layer = effectiveLayer(entry)
    this.saveMeta(entry)
    this.saveState()
    this.touchActivity()
  }

  touchActivity() {
    this.activityAt = Date.now()
  }

  find(id) {
    return this.entries.get(id)
  }

  active() {
    return [...this.entries.values()].filter(
      (entry) => entry.status === 'active' && !entry.superseded_by,
    )
  }

  readGist(entry) {
    return readText(join(this.paths.entries, entry.id, GIST), entry._gist ?? entry.summary ?? '')
  }

  readDetail(entry) {
    return readText(join(this.paths.entries, entry.id, DETAIL), '')
  }

  readRaw(entry, maxLines = 24) {
    const text = readText(join(this.paths.entries, entry.id, RAW), '')
    if (!text) return ''
    return text.split('\n').filter(Boolean).slice(-maxLines).join('\n')
  }

  readDepth(entry, depth = 'gist') {
    const gist = this.readGist(entry)
    if (depth === 'index') return { gist: '', detail: '', raw: '', summary: entry.summary ?? gist }
    if (depth === 'gist') return { gist, detail: '', raw: '', summary: entry.summary ?? gist }
    const detail = this.readDetail(entry)
    if (depth === 'detail') return { gist, detail, raw: '', summary: entry.summary ?? gist }
    return { gist, detail, raw: this.readRaw(entry), summary: entry.summary ?? gist }
  }

  removeLayer(entry, layer) {
    if (!['gist', 'detail', 'raw'].includes(layer)) throw new Error('invalid memory layer')
    this.assertUnchanged(entry)
    if (!entry.layers?.[layer]) return false
    const file = layer === 'gist' ? GIST : layer === 'detail' ? DETAIL : RAW
    const source = join(this.paths.entries, entry.id, file)
    if (existsSync(source)) {
      const coldDir = join(this.paths.cold, entry.id)
      mkdirSync(coldDir, { recursive: true, mode: 0o700 })
      try {
        renameSync(source, join(coldDir, file))
      } catch {
        return false
      }
    }
    entry.layers[layer] = false
    entry.layer = effectiveLayer(entry)
    this.saveMeta(entry)
    this.saveIndex()
    return true
  }

  archive(entry, reason = 'faded') {
    this.assertUnchanged(entry)
    entry.status = 'archived'
    entry.archived_at = nowIso()
    entry.archive_reason = reason
    entry.layer = 'archive'
    this.saveMeta(entry)
    this.saveIndex()
    return entry
  }

  supersede(oldEntry, newEntry) {
    this.assertUnchanged(oldEntry)
    oldEntry.status = 'superseded'
    oldEntry.superseded_by = newEntry.id
    oldEntry.valid_to = newEntry.created_at
    oldEntry.layer = 'archive'
    this.saveMeta(oldEntry)
    this.saveIndex()
  }

  deleteEntry(entry) {
    this.assertUnchanged(entry)
    const dir = join(this.paths.entries, entry.id)
    if (!isInside(this.paths.entries, dir)) throw new Error('refusing to delete outside the memory store')
    rmSync(dir, { recursive: true, force: true })
    rmSync(join(this.paths.cold, entry.id), { recursive: true, force: true })
    rmSync(join(this.paths.externalChanges, entry.id), { recursive: true, force: true })
    this.entries.delete(entry.id)
    this.observations.delete(entry.id)
    this.saveObservations()
    this.touchActivity()
    this.saveState()
    this.saveIndex()
  }

  saveIndex() {
    const active = [...this.entries.values()]
      .filter((entry) => entry.status === 'active' && !entry.superseded_by)
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
        return (b.salience?.total ?? 0) - (a.salience?.total ?? 0)
      })
    const archived = [...this.entries.values()].filter((entry) => entry.status !== 'active')
    const json = {
      schema_version: 1,
      generated_at: nowIso(),
      entries: active.map((entry) => ({
        id: entry.id,
        type: entry.type,
        title: entry.title,
        tags: entry.tags,
        summary: entry.summary,
        layer: entry.layer,
        pinned: entry.pinned,
        salience: entry.salience,
        updated_at: entry.updated_at,
        access_count: entry.access_count,
      })),
    }
    atomicWrite(this.paths.indexJson, JSON.stringify(json, null, 2))
    this.writeIndexMarkdown(active, archived)
    try {
      for (const file of readdirSync(this.paths.topics)) {
        if (file.endsWith('.md')) rmSync(join(this.paths.topics, file), { force: true })
      }
    } catch {
      // The directory is created lazily.
    }
    this.writeTopicPages(active)
  }

  writeIndexMarkdown(active, archived) {
    const lines = [
      '# 鲸鱼娘的记忆花园',
      '',
      '> 这个目录由记忆插件自动维护；可以直接编辑 entries 下的文件，下一次加载会重建索引。',
      `> 最后生成：${nowIso()}`,
      '',
      '## 当前记得的事',
      '',
    ]
    for (const type of TYPES) {
      const group = active.filter((entry) => entry.type === type)
      if (group.length === 0) continue
      lines.push(`### ${TYPE_LABEL[type] ?? type}`, '')
      for (const entry of group) {
        lines.push(
          `- ${entry.layer === 'index' ? '［淡］' : entry.pinned ? '［钉］' : ''}${entry.pinned ? ' ' : ''}${entry.title}`,
          `  - id: \`${entry.id}\` · tags: ${entry.tags.join(', ')}`,
          `  - ${entry.summary ?? ''}`,
        )
      }
      lines.push('')
    }
    if (active.length === 0) lines.push('（还没有记忆。等你和主人留下第一件小事。）', '')
    if (archived.length > 0) {
      lines.push('## 已归档 / 已被取代', '')
      for (const entry of archived) {
        lines.push(`- ${entry.title} (\`${entry.id}\`) · ${entry.status} · ${entry.archived_at ?? entry.updated_at}`)
      }
      lines.push('')
    }
    lines.push('---', '', '记忆块是可编辑的；系统不会用哈希阻止你修改。索引、主题页和目录都会从块重建。')
    atomicWrite(this.paths.indexMd, `${lines.join('\n')}\n`)
  }

  writeTopicPages(active) {
    const topics = new Map()
    for (const entry of active) {
      for (const tag of entry.tags) {
        if (!tag.startsWith('topic:')) continue
        const key = topicSlug(tag)
        const list = topics.get(key) ?? []
        list.push(entry)
        topics.set(key, list)
      }
    }
    for (const [slug, entries] of topics) {
      const lines = [
        `# 主题：${slug}`,
        '',
        '> 由记忆插件生成，可重建；不要在这里写新的记忆，写到 entries 里。',
        '',
      ]
      for (const entry of entries) {
        lines.push(`- **${entry.title}** · ${entry.type} · ${entry.tags.join(', ')}`, `  ${entry.summary ?? ''}`)
        const links = entry.links?.filter((link) => link?.id) ?? []
        for (const link of links) lines.push(`  - ${link.rel ?? 'related'} → ${link.id}`)
      }
      atomicWrite(join(this.paths.topics, `${slug}.md`), `${lines.join('\n')}\n`)
    }
  }

  due({ days = 7, writes = 40 } = {}) {
    if (this.entries.size === 0) return false
    const last = Date.parse(this.state.last_maintained_at ?? '')
    if (!Number.isFinite(last)) return true
    return Date.now() - last >= days * DAY_MS || (this.state.writes_since_maintenance ?? 0) >= writes
  }

  markMaintained(trigger = 'dream') {
    this.state.last_maintained_at = nowIso()
    this.state.last_dream_at = this.state.last_maintained_at
    this.state.writes_since_maintenance = 0
    this.state.last_trigger = trigger
    this.saveState()
  }

  addDream(text, date = new Date()) {
    const day = localDateKey(date)
    const path = join(this.paths.dreams, `${day}.md`)
    const exists = existsSync(path)
    const header = exists ? '' : `# ${day} 的梦\n\n`
    const body = `${header}${exists ? '\n---\n\n' : ''}（${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}）\n\n${text.trim()}\n`
    if (exists) {
      writeFileSync(path, body, { encoding: 'utf8', mode: 0o600, flag: 'a' })
    } else {
      atomicWrite(path, body)
    }
  }

  listCold() {
    try {
      return readdirSync(this.paths.cold, { withFileTypes: true })
        .filter((item) => item.isDirectory())
        .map((item) => item.name)
    } catch {
      return []
    }
  }

  rootPath() {
    return resolve(this.root)
  }
}

export { META, GIST, DETAIL, RAW, INDEX_JSON, INDEX_MD }
