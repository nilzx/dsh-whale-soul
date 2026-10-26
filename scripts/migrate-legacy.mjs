#!/usr/bin/env node
/**
 * Migrate the legacy `dsh-whale-girl` memory store into `dsh-whale-soul`.
 * The old store used one Markdown block per entry with YAML-ish front matter;
 * this script maps its kinds and preserves timestamps, tags, title, and content.
 *
 * Usage:
 *   node scripts/migrate-legacy.mjs [--from DIR] [--to DIR] [--dry-run]
 *
 * Defaults:
 *   --from $DSH_HOME/whale-girl/memory
 *   --to   $DSH_HOME/whale-soul/memory
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { MemoryStore } from '../src/memory/store.js'
import { makeId, normalizeTags } from '../src/memory/schema.js'

function parseArgs(argv) {
  const out = { dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') out.dryRun = true
    else if (arg === '--from') out.from = argv[++i]
    else if (arg === '--to') out.to = argv[++i]
  }
  return out
}

function dshHome() {
  return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
}

function parseBlock(text) {
  const normalized = String(text).replace(/\r\n?/g, '\n')
  if (!normalized.startsWith('---\n')) return { meta: {}, body: normalized.trim() }
  const end = normalized.indexOf('\n---\n', 4)
  if (end < 0) return { meta: {}, body: normalized.trim() }
  const head = normalized.slice(4, end)
  const body = normalized.slice(end + 5).trim()
  const meta = {}
  for (const line of head.split('\n')) {
    const at = line.indexOf(':')
    if (at < 0) continue
    const key = line.slice(0, at).trim()
    const raw = line.slice(at + 1).trim()
    try {
      meta[key] = JSON.parse(raw)
    } catch {
      meta[key] = raw.replace(/^"|"$/g, '')
    }
  }
  return { meta, body }
}

function mapKind(kind) {
  return {
    player: 'identity',
    moment: 'episode',
    preference: 'preference',
    promise: 'promise',
    emotion: 'emotion',
    fact: 'fact',
    other: 'fact',
  }[kind] ?? 'fact'
}

function topicFor(kind) {
  return {
    player: 'topic:identity/basics',
    moment: 'topic:memory/legacy',
    preference: 'topic:preference/legacy',
    promise: 'topic:promise/legacy',
    emotion: 'topic:emotion/legacy',
    fact: 'topic:legacy',
    other: 'topic:legacy',
  }[kind] ?? 'topic:legacy'
}

const args = parseArgs(process.argv.slice(2))
const from = resolve(args.from ?? join(dshHome(), 'whale-girl', 'memory'))
const to = resolve(args.to ?? join(dshHome(), 'whale-soul', 'memory'))
if (!existsSync(join(from, 'catalog.json'))) {
  console.error(`legacy catalog not found: ${join(from, 'catalog.json')}`)
  process.exit(1)
}
const catalog = JSON.parse(readFileSync(join(from, 'catalog.json'), 'utf8'))
const store = new MemoryStore({ root: to, watch: false }).ensure()
const existingKeys = new Set(
  store.active().map((entry) => entry.canonical_key).filter(Boolean),
)
let migrated = 0
let skipped = 0

for (const old of catalog.entries ?? []) {
  if (!old || old.status === 'archived' || old.status === 'compressed') {
    skipped++
    continue
  }
  const blockPath = join(from, old.path)
  if (!existsSync(blockPath)) {
    skipped++
    continue
  }
  const key = `legacy:${old.id}`
  if (existingKeys.has(key)) {
    skipped++
    continue
  }
  const parsed = parseBlock(readFileSync(blockPath, 'utf8'))
  const type = mapKind(parsed.meta.kind ?? old.kind)
  const title = String(parsed.meta.title ?? old.title ?? '旧记忆').slice(0, 200)
  const tags = normalizeTags(
    [
      'who:master',
      topicFor(parsed.meta.kind ?? old.kind),
      ...(Array.isArray(parsed.meta.tags) ? parsed.meta.tags : []),
    ],
    type,
  )
  const createdAt = parsed.meta.created_at ?? old.created_at ?? new Date().toISOString()
  const updatedAt = parsed.meta.updated_at ?? old.updated_at ?? createdAt
  const weight = Number(parsed.meta.emotional_weight ?? old.emotional_weight ?? 40)
  const id = makeId()
  const meta = {
    schema_version: 1,
    id,
    type,
    title,
    summary: String(parsed.meta.summary ?? old.summary ?? '').slice(0, 400),
    tags,
    entities: type === 'identity' ? ['person:master'] : [],
    links: [],
    emotional_weight: weight,
    salience: {
      emotional: Math.min(1, Math.max(0, weight / 100)),
      identity: type === 'identity' || type === 'promise' ? 0.9 : 0.35,
      recurrence: 0.2,
      novelty: 0.3,
      unresolved: type === 'promise' ? 0.8 : 0.1,
      total: type === 'identity' ? 0.9 : Math.min(0.9, weight / 100),
    },
    confidence: 0.95,
    pinned: type === 'identity' || type === 'promise',
    status: 'active',
    source: 'import',
    user_edited: false,
    created_at: createdAt,
    updated_at: updatedAt,
    last_access: null,
    access_count: 0,
    valid_from: null,
    valid_to: null,
    supersedes: null,
    superseded_by: null,
    canonical_key: key,
    layers: { gist: true, detail: true, raw: true },
    assets: [],
    archived_at: null,
  }
  const gist = String(parsed.meta.summary ?? old.summary ?? parsed.body).slice(0, 400)
  if (args.dryRun) {
    console.log(`[dry-run] ${title} -> ${type} (${weight})`)
  } else {
    store.createEntry(meta, {
      gist,
      detail: parsed.body,
      raw: `${JSON.stringify({
        at: createdAt,
        source: 'legacy:dsh-whale-girl',
        content: parsed.body,
      })}\n`,
    })
    const created = store.find(id)
    created.created_at = createdAt
    created.updated_at = updatedAt
    store.saveMeta(created)
    existingKeys.add(key)
    console.log(`migrated: ${title} -> ${type}`)
  }
  migrated++
}
console.log(`\n${args.dryRun ? 'would migrate' : 'migrated'} ${migrated}, skipped ${skipped}`)
console.log(`from: ${from}`)
console.log(`to:   ${to}`)
