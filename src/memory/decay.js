import { DAY_MS, retrievability, summarize } from './schema.js'

const DREAM_OPENERS = [
  '今天蜷在尾巴上打了个盹。',
  '刚才迷迷糊糊睡了一小会儿。',
  '眼皮沉沉的，就趴下来睡了一会儿。',
  '在梦里又回到了海边。',
]

const DREAM_CLOSERS = [
  '有些细节像泡泡一样飘走了，但重要的东西还在。',
  '醒来的时候，心里清爽了一点。',
  '只记得几件小事，剩下的都交给潮水了。',
  '尾巴还暖着，梦里的事慢慢沉下去了。',
]

function dreamText(entries) {
  const anchors = entries
    .filter((entry) => entry.pinned || entry.type === 'identity' || entry.type === 'promise')
    .slice(0, 3)
    .map((entry) => entry.title)
  const topics = new Map()
  for (const entry of entries) {
    for (const tag of entry.tags ?? []) {
      if (!tag.startsWith('topic:') || tag === 'topic:general') continue
      topics.set(tag.slice(6), (topics.get(tag.slice(6)) ?? 0) + 1)
    }
  }
  const topicNames = [...topics.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([name]) => name)
  const opener = DREAM_OPENERS[Math.floor(Math.random() * DREAM_OPENERS.length)]
  const closer = DREAM_CLOSERS[Math.floor(Math.random() * DREAM_CLOSERS.length)]
  const middle = []
  if (topicNames.length) middle.push(`梦里有很多熟悉的东西：${topicNames.join('、')}。`)
  if (anchors.length) middle.push(`醒来还记得：${anchors.join('、')}。`)
  if (!middle.length) middle.push('梦里没有特别的事，只是安静地待了一会儿。')
  return [opener, '', ...middle, '', closer].join('\n')
}

/**
 * Run the dream-time maintenance pass. It moves details to cold storage,
 * archives faded entries, and writes a dream journal. It returns diagnostics
 * for logs only; callers must not surface counts to the user.
 */
export function runDream(store, config = {}) {
  const now = Date.now()
  const active = store.active()
  const summary = { demotedDetail: 0, demotedRaw: 0, indexOnly: 0, archived: 0, purged: 0 }
  for (const entry of active) {
    if (entry.pinned || entry.user_edited) continue
    const ageDays = Math.max(0, (now - Date.parse(entry.created_at)) / DAY_MS)
    const r = retrievability(entry, now)
    if (!Number.isFinite(r)) continue
    if (r < 0.6 && entry.layers?.detail && ageDays >= 30) {
      if (store.removeLayer(entry, 'detail')) summary.demotedDetail++
    }
    if (r < 0.4 && entry.layers?.raw && ageDays >= 14) {
      if (store.removeLayer(entry, 'raw')) summary.demotedRaw++
    }
    if (r < 0.15 && entry.layers?.gist && ageDays >= 120) {
      entry.summary = summarize(entry.summary ?? '', 220)
      if (store.removeLayer(entry, 'gist')) summary.indexOnly++
    }
    if (
      r < 0.05 &&
      ageDays >= 365 &&
      (entry.salience?.total ?? 0) < 0.25 &&
      (entry.links?.length ?? 0) === 0
    ) {
      store.archive(entry, 'faded')
      summary.archived++
    }
  }

  if (config.autoPurgeArchived === true) {
    const purgeAfter = Math.max(365, Number(config.purgeAfterDays) || 730)
    for (const entry of [...store.entries.values()]) {
      if (entry.status !== 'archived') continue
      const archivedAt = Date.parse(entry.archived_at ?? entry.updated_at ?? entry.created_at)
      if (!Number.isFinite(archivedAt)) continue
      if (now - archivedAt < purgeAfter * DAY_MS) continue
      if ((entry.salience?.total ?? 0) >= 0.25 || entry.pinned || entry.user_edited) continue
      store.deleteEntry(entry)
      summary.purged++
    }
  }

  const dream = dreamText(store.active())
  store.addDream(dream)
  store.markMaintained('dream')
  return { ...summary, dream }
}
