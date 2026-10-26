import { localizePreset } from './locale-text.js'

export const inject = ['slots', 'locale']

function localizeRows(rows, locale) {
  if (!Array.isArray(rows)) return rows
  const next = rows.map((row) => localizePreset(row, locale))
  return next.some((row, index) => row !== rows[index]) ? next : rows
}

export function projectSnapshot(snapshot, locale) {
  const options = localizeRows(snapshot.options, locale)
  const rows = localizeRows(snapshot.rows, locale)
  let view = snapshot.view
  let error = snapshot.error
  if (error?.preset) {
    const preset = localizePreset(error.preset, locale)
    if (preset !== error.preset) error = { ...error, preset }
  }
  if (view?.id && typeof view.title === 'string') {
    const localized = localizePreset({ id: view.id, name: view.title }, locale)
    if (localized.name !== view.title) view = { ...view, title: localized.name }
  }
  if (options === snapshot.options && rows === snapshot.rows && view === snapshot.view && error === snapshot.error) return snapshot
  return { ...snapshot, ...(options === undefined ? {} : { options }), ...(rows === undefined ? {} : { rows }), ...(view === undefined ? {} : { view }), ...(error === undefined ? {} : { error }) }
}

export function createLocaleStore(source, locale, subscriptions) {
  let before, language, cached
  return {
    getSnapshot() {
      const snapshot = source.getSnapshot(), active = locale.getLocale().active
      if (snapshot !== before || active !== language) {
        before = snapshot; language = active
        cached = projectSnapshot(snapshot, active)
      }
      return cached
    },
    subscribe(listener) {
      let live = true
      const changed = () => { if (live) listener() }
      const stopSource = source.subscribe(changed), stopLocale = locale.subscribe(changed)
      const stop = () => {
        if (!live) return
        live = false; stopSource(); stopLocale(); subscriptions?.delete(stop)
      }
      subscriptions?.add(stop)
      return stop
    },
  }
}

/** Decorate public preset slot faces without changing Remote data or Host preferences. */
export function apply(ctx) {
  const projections = new WeakMap(), subscriptions = new Set(), contributions = new Map()
  let active = true
  const targets = [
    { key: 'conversation.hero.agentPreset', component: 'AgentPresetSeat' },
    { key: 'conversation.session.header.actions', id: 'agent-preset', component: 'AgentPresetLabel' },
    { key: 'settings.section', id: 'agent-presets', component: 'AgentPresetSection' },
  ]
  const owner = 'dsh-whale-soul:locale'
  const sourceStore = (store) => {
    if (!store || typeof store.getSnapshot !== 'function' || typeof store.subscribe !== 'function') return store
    if (!projections.has(store)) projections.set(store, createLocaleStore(store, ctx.locale, subscriptions))
    return projections.get(store)
  }
  const stops = []
  for (const target of targets) {
    const reconcile = () => {
      if (!active) return
      const entries = ctx.slots.entries(target.key).filter((entry) => target.id === undefined || entry.options.id === target.id)
      const isBuiltIn = (entry) => entry.component?.name === target.component && String(entry.registrant ?? '').includes('ui-agent-preset')
      const current = contributions.get(target.key)
      if (entries.some((entry) => entry.registrant !== owner && !isBuiltIn(entry))) {
        if (current) { contributions.delete(target.key); current.dispose() }
        return
      }
      const winner = ctx.slots.entriesOfSlot(target.key).find((entry) => target.id === undefined || entry.options.id === target.id)
      if (winner?.registrant === owner && current && entries.includes(current.source)) return
      if (current) { contributions.delete(target.key); current.dispose() }
      if (!winner || !isBuiltIn(winner)) return
      const injectFace = winner.inject
      if (typeof injectFace !== 'function') return
      const options = {
        name: target.key,
        ...winner.options,
        priority: (winner.options.priority ?? 0) - 1,
        registrant: owner,
        ...(winner.locale ? { locale: winner.locale } : {}),
        inject: (...args) => {
          const face = injectFace(...args)
          if (!face?.hooks) return face
          return { ...face, hooks: Object.fromEntries(Object.entries(face.hooks).map(([key, store]) => [key, sourceStore(store)])) }
        },
      }
      contributions.set(target.key, { source: winner, dispose: ctx.slots.register(options, winner.component) })
    }
    stops.push(ctx.slots.subscribe(target.key, reconcile))
    reconcile()
  }
  ctx.effect(() => () => {
    active = false
    for (const stop of stops) stop()
    for (const { dispose } of contributions.values()) dispose()
    contributions.clear()
    for (const stop of [...subscriptions]) stop()
  }, 'whale-soul: client preset localization')
}
