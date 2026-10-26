import { randomBytes } from 'node:crypto'

export const SCHEMA_VERSION = 1
export const DAY_MS = 86_400_000

export const TYPES = [
  'identity',
  'preference',
  'episode',
  'promise',
  'emotion',
  'procedure',
  'fact',
  'meme',
]

export const TYPE_LABEL = {
  identity: '身份',
  preference: '偏好',
  episode: '经历',
  promise: '约定',
  emotion: '心事',
  procedure: '习惯',
  fact: '事实',
  meme: '表情',
}

/** Type-specific half-lives, in days. These are design priors, not claims about brains. */
export const BASE_HALF_LIFE_DAYS = {
  identity: 3650,
  promise: 730,
  preference: 365,
  procedure: 365,
  emotion: 180,
  episode: 90,
  fact: 180,
  meme: 45,
}

export const MOODS = ['happy', 'shy', 'tsundere', 'sleepy', 'thinking', 'comfort', 'eating', 'idle']

export function nowIso() {
  return new Date().toISOString()
}

export function clamp(value, min = 0, max = 1) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}

export function normalizeType(value) {
  return TYPES.includes(value) ? value : 'fact'
}

export function normalizeTags(input, type = 'fact') {
  const tags = []
  const seen = new Set()
  const push = (raw) => {
    const tag = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, '-')
    if (!tag || tag.length > 64 || seen.has(tag)) return
    seen.add(tag)
    tags.push(tag)
  }
  if (Array.isArray(input)) for (const tag of input) push(tag)
  if (!tags.some((tag) => tag.startsWith('kind:'))) push(`kind:${normalizeType(type)}`)
  if (!tags.some((tag) => tag.startsWith('topic:'))) push('topic:general')
  return tags.slice(0, 24)
}

export function normalizeEmotionalWeight(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 40
  return Math.round(Math.min(100, Math.max(0, n)))
}

export function computeSalience({ type, emotionalWeight = 40, pinned = false, recurrence = 0, unresolved }) {
  const emotional = clamp(emotionalWeight / 100)
  const identity = type === 'identity' || type === 'promise' ? 0.9 : type === 'preference' ? 0.65 : 0.35
  const recurrenceValue = clamp(recurrence)
  const novelty = 0.5
  const unresolvedValue = unresolved === undefined ? (type === 'promise' ? 0.8 : 0.1) : clamp(unresolved)
  const total = clamp(
    emotional * 0.35 +
      identity * 0.2 +
      recurrenceValue * 0.15 +
      novelty * 0.1 +
      unresolvedValue * 0.2,
  )
  return {
    emotional,
    identity,
    recurrence: recurrenceValue,
    novelty,
    unresolved: unresolvedValue,
    total: pinned ? Math.max(0.95, total) : total,
  }
}

export function retrievability(entry, now = Date.now()) {
  const last = Date.parse(entry.last_access ?? entry.updated_at ?? entry.created_at)
  const ageDays = Number.isFinite(last) ? Math.max(0, (now - last) / DAY_MS) : 0
  const base = BASE_HALF_LIFE_DAYS[entry.type] ?? 180
  const strength =
    base *
    (1 + 0.3 * Math.log1p(Math.max(0, Number(entry.access_count) || 0))) *
    (0.5 + clamp(entry.salience?.total ?? 0.4))
  return Math.pow(0.5, ageDays / Math.max(1, strength))
}

export function effectiveLayer(entry, now = Date.now()) {
  if (entry.status === 'archived') return 'archive'
  if (entry.pinned || entry.user_edited) return entry.layers?.gist === false ? 'index' : 'gist'
  const r = retrievability(entry, now)
  if (r < 0.12) return 'index'
  if (r < 0.35) return 'gist'
  return entry.layers?.detail ? 'detail' : 'gist'
}

export function titleFromContent(content, fallback = '一件小事') {
  const first = String(content ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/^#+\s*/, '').trim())
    .find(Boolean)
  if (!first) return fallback
  return first.length > 60 ? `${first.slice(0, 60).trimEnd()}…` : first
}

export function summarize(text, max = 180) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max)
  const stop = Math.max(
    cut.lastIndexOf('。'),
    cut.lastIndexOf('！'),
    cut.lastIndexOf('？'),
    cut.lastIndexOf('；'),
    cut.lastIndexOf('，'),
    cut.lastIndexOf('. '),
  )
  return `${(stop > Math.floor(max * 0.45) ? cut.slice(0, stop + 1) : cut).trimEnd()}…`
}

export function tokenize(text) {
  const value = String(text ?? '').toLowerCase()
  const tokens = new Set()
  for (const word of value.match(/[a-z0-9_]{2,}/g) ?? []) tokens.add(word)
  for (const run of value.match(/[\u3400-\u9fff]+/g) ?? []) {
    if (run.length === 1) tokens.add(run)
    for (let i = 0; i < run.length - 1; i++) tokens.add(run.slice(i, i + 2))
  }
  return tokens
}

export function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const item of a) if (b.has(item)) intersection++
  return intersection / (a.size + b.size - intersection)
}

export function tagOverlap(a, b) {
  const set = new Set(a ?? [])
  let count = 0
  for (const tag of b ?? []) if (set.has(tag)) count++
  return count
}

export function makeId(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  const ss = String(date.getSeconds()).padStart(2, '0')
  return `m-${y}${m}${d}-${hh}${mm}${ss}-${randomBytes(2).toString('hex')}`
}

export function localDateKey(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function parseTime(value, fallback = null) {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function normalizeEntryMeta(raw, { id, now = nowIso() } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('meta must be an object')
  const type = normalizeType(raw.type)
  const emotional_weight = normalizeEmotionalWeight(raw.emotional_weight)
  const tags = normalizeTags(raw.tags, type)
  const pinned = raw.pinned === true
  const salience = raw.salience && typeof raw.salience === 'object'
    ? { ...computeSalience({ type, emotionalWeight: emotional_weight, pinned }), ...raw.salience }
    : computeSalience({ type, emotionalWeight: emotional_weight, pinned })
  return {
    schema_version: SCHEMA_VERSION,
    id: typeof raw.id === 'string' && raw.id ? raw.id : id,
    type,
    title: String(raw.title ?? '一件小事').slice(0, 200),
    summary: typeof raw.summary === 'string' ? raw.summary.slice(0, 400) : null,
    tags,
    entities: Array.isArray(raw.entities) ? raw.entities.filter((item) => typeof item === 'string').slice(0, 32) : [],
    links: Array.isArray(raw.links)
      ? raw.links
          .filter((link) => link && typeof link.id === 'string' && typeof link.rel === 'string')
          .slice(0, 64)
      : [],
    emotional_weight,
    salience,
    confidence: clamp(raw.confidence ?? 0.8),
    pinned,
    status: ['active', 'archived', 'superseded', 'quarantined'].includes(raw.status) ? raw.status : 'active',
    source: ['user', 'agent', 'import', 'inferred'].includes(raw.source) ? raw.source : 'agent',
    user_edited: raw.user_edited === true,
    created_at: typeof raw.created_at === 'string' ? raw.created_at : now,
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : now,
    last_access: typeof raw.last_access === 'string' ? raw.last_access : null,
    access_count: Math.max(0, Math.round(Number(raw.access_count) || 0)),
    valid_from: typeof raw.valid_from === 'string' ? raw.valid_from : null,
    valid_to: typeof raw.valid_to === 'string' ? raw.valid_to : null,
    supersedes: typeof raw.supersedes === 'string' ? raw.supersedes : null,
    superseded_by: typeof raw.superseded_by === 'string' ? raw.superseded_by : null,
    canonical_key: typeof raw.canonical_key === 'string' ? raw.canonical_key : null,
    layers: {
      gist: raw.layers?.gist !== false,
      detail: raw.layers?.detail === true,
      raw: raw.layers?.raw === true,
    },
    assets: Array.isArray(raw.assets) ? raw.assets.filter((item) => typeof item === 'string').slice(0, 32) : [],
    archived_at: typeof raw.archived_at === 'string' ? raw.archived_at : null,
  }
}
