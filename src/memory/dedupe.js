import {
  computeSalience,
  jaccard,
  makeId,
  normalizeEmotionalWeight,
  normalizeTags,
  normalizeType,
  nowIso,
  summarize,
  tagOverlap,
  titleFromContent,
  tokenize,
} from './schema.js'

function normalizedTitle(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, 120)
}

function rawLine(text, source = 'agent') {
  return `${JSON.stringify({ at: nowIso(), source, content: String(text) })}\n`
}

function normalizedRaw(...parts) {
  const lines = parts.flatMap((part) => String(part ?? '').split(/\r?\n/)).filter((line) => line.trim())
  for (const line of lines) {
    try {
      const record = JSON.parse(line)
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('invalid record')
    } catch {
      throw new Error('RAW_EVIDENCE_INVALID: existing evidence requires repair before merging')
    }
  }
  return lines.length ? `${lines.join('\n')}\n` : ''
}

function sameScope(left, right) {
  for (const key of ['subject_id', 'memory_space_id', 'agent_identity_id', 'persona_id']) {
    if ((left[key] || right[key]) && left[key] !== right[key]) return false
  }
  const leftWho = (left.tags ?? []).filter((tag) => tag.startsWith('who:'))
  const rightWho = (right.tags ?? []).filter((tag) => tag.startsWith('who:'))
  return !leftWho.length || !rightWho.length || leftWho.some((tag) => rightWho.includes(tag))
}

export function buildCandidate(input = {}) {
  const type = normalizeType(input.type)
  const content = String(input.content ?? '').trim()
  if (!content) throw new Error('content must not be empty')
  const title = String(input.title ?? '').trim() || titleFromContent(content)
  const tags = normalizeTags(input.tags, type)
  const emotionalWeight = normalizeEmotionalWeight(input.emotional_weight)
  const pinned = input.pinned === true
  const id = makeId()
  const gist = String(input.gist ?? '').trim() || summarize(content, 340)
  const canonicalKey =
    typeof input.canonical_key === 'string' && input.canonical_key.trim()
      ? input.canonical_key.trim()
      : type === 'episode'
        ? null
        : `${type}:${tags.filter((tag) => tag.startsWith('topic:')).sort().join('|')}:${normalizedTitle(title)}`
  const meta = {
    schema_version: 1,
    id,
    type,
    title: title.slice(0, 200),
    summary: summarize(gist, 240),
    tags,
    entities: Array.isArray(input.entities)
      ? input.entities.filter((item) => typeof item === 'string').slice(0, 32)
      : [],
    links: Array.isArray(input.links) ? input.links.slice(0, 64) : [],
    emotional_weight: emotionalWeight,
    salience: computeSalience({ type, emotionalWeight, pinned }),
    confidence: Math.min(1, Math.max(0, Number(input.confidence) || 0.8)),
    pinned,
    status: 'active',
    source: input.source === 'user' ? 'user' : 'agent',
    user_edited: false,
    created_at: nowIso(),
    updated_at: nowIso(),
    last_access: null,
    access_count: 0,
    valid_from: null,
    valid_to: null,
    supersedes: typeof input.supersedes === 'string' ? input.supersedes : null,
    superseded_by: null,
    canonical_key: canonicalKey,
    ...Object.fromEntries(['subject_id', 'memory_space_id', 'agent_identity_id', 'persona_id']
      .filter((key) => typeof input[key] === 'string' && input[key].trim())
      .map((key) => [key, input[key].trim()])),
    layers: { gist: true, detail: true, raw: true },
    assets: Array.isArray(input.assets) ? input.assets.filter((item) => typeof item === 'string').slice(0, 32) : [],
    archived_at: null,
  }
  return {
    meta,
    layers: {
      gist,
      detail: content,
      raw: rawLine(content, meta.source),
    },
  }
}

/**
 * Find the most plausible existing entry for a new candidate.
 * This is deliberately conservative: uncertain matches become links, not silent merges.
 */
export function findMergeCandidate(entries, candidate) {
  const candidateTokens = tokenize(`${candidate.meta.title}\n${candidate.layers.gist}`)
  const candidateTime = Date.parse(candidate.meta.created_at)
  let best = null
  let bestScore = 0
  for (const entry of entries) {
    if (entry.id === candidate.meta.id) continue
    if (entry.status !== 'active' || entry.superseded_by) continue
    if (entry.type !== candidate.meta.type || !sameScope(entry, candidate.meta)) continue
    if (entry.canonical_key && candidate.meta.canonical_key && entry.canonical_key === candidate.meta.canonical_key) {
      return { entry, kind: 'canonical', score: 1 }
    }
    const overlap = tagOverlap(entry.tags, candidate.meta.tags)
    if (overlap < 2) continue
    const meaningfulOverlap = tagOverlap(
      (entry.tags ?? []).filter((tag) => tag !== 'topic:general' && !tag.startsWith('kind:')),
      (candidate.meta.tags ?? []).filter((tag) => tag !== 'topic:general' && !tag.startsWith('kind:')),
    )
    const titleSimilarity = jaccard(tokenize(entry.title), tokenize(candidate.meta.title))
    const gistSimilarity = jaccard(tokenize(entry.summary ?? ''), candidateTokens)
    const timeDistance = Number.isFinite(candidateTime)
      ? Math.abs(candidateTime - Date.parse(entry.created_at)) / 3_600_000
      : Infinity
    const episodeBonus = entry.type === 'episode' && timeDistance <= 8 ? 0.15 : 0
    if (meaningfulOverlap === 0 && titleSimilarity < 0.5 && gistSimilarity < 0.6) continue
    const score = overlap * 0.12 + titleSimilarity * 0.35 + gistSimilarity * 0.35 + episodeBonus
    if (score > bestScore) {
      bestScore = score
      best = entry
    }
  }
  if (best && bestScore >= 0.52) return { entry: best, kind: 'similar', score: bestScore }
  return null
}

export function mergeCandidate(existing, candidate, { existingDetail = '', existingRaw = '' } = {}) {
  if (existing.user_edited) return { action: 'link', entry: candidate.meta, reason: 'user-edited' }
  if (existing.type !== candidate.meta.type || !sameScope(existing, candidate.meta)) {
    return { action: 'link', entry: candidate.meta, reason: 'different-scope' }
  }
  const oldGist = existing.summary ?? existing.gist ?? ''
  const newGist = candidate.layers.gist
  const combinedTokens = tokenize(`${oldGist}\n${newGist}`)
  const oldTokens = tokenize(oldGist)
  const newTokens = tokenize(newGist)
  const similarity = jaccard(oldTokens, newTokens)
  const sameCanonical =
    existing.canonical_key && candidate.meta.canonical_key && existing.canonical_key === candidate.meta.canonical_key
  if (sameCanonical && similarity < 0.25 && combinedTokens.size > 8) {
    candidate.meta.supersedes = existing.id
    return { action: 'supersede', entry: candidate.meta, old: existing, reason: 'contradiction' }
  }

  const timestamp = nowIso()
  const raw = normalizedRaw(existingRaw, candidate.layers.raw)
  const detail = [existingDetail.trim(), `---\n[${timestamp}] ${candidate.layers.detail.trim()}`]
    .filter(Boolean)
    .join('\n\n')
    .slice(-60_000)
  const tags = [...new Set([...(existing.tags ?? []), ...(candidate.meta.tags ?? [])])].slice(0, 24)
  const emotional = Math.max(existing.emotional_weight ?? 0, candidate.meta.emotional_weight ?? 0)
  const pinned = existing.pinned === true || candidate.meta.pinned === true
  const salience = computeSalience({
    type: existing.type,
    emotionalWeight: emotional,
    pinned,
    recurrence: Math.min(1, (existing.salience?.recurrence ?? 0) + 0.12),
    unresolved: existing.salience?.unresolved ?? (existing.type === 'promise' ? 0.8 : 0.1),
  })
  const links = [...(existing.links ?? [])]
  for (const link of candidate.meta.links ?? []) {
    if (!links.some((item) => item.rel === link.rel && item.id === link.id)) links.push(link)
  }
  const gist = newGist && newGist.length >= oldGist.length ? newGist : oldGist || newGist
  Object.assign(existing, {
    title: existing.title || candidate.meta.title,
    summary: summarize(gist, 240),
    tags,
    emotional_weight: emotional,
    salience,
    confidence: Math.max(existing.confidence ?? 0.7, candidate.meta.confidence ?? 0.7),
    pinned,
    links,
    assets: [...new Set([...(existing.assets ?? []), ...(candidate.meta.assets ?? [])])].slice(0, 32),
    canonical_key: existing.canonical_key ?? candidate.meta.canonical_key ?? null,
    updated_at: timestamp,
    layers: { ...existing.layers, gist: true, detail: true },
  })
  return {
    action: 'merge',
    entry: existing,
    layers: {
      gist,
      detail,
      raw,
    },
  }
}
