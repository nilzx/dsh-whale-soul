import { localizePreset } from './locale-text.js'

function readPreference(ctx) {
  try {
    const settings = ctx.get?.('settings') ?? ctx.settings
    const descriptors = settings?.describe?.({ redactSecrets: true }) ?? []
    const locale = descriptors.find((item) => {
      const ns = String(item.ns)
      return ns === 'locale' || ns.endsWith(':locale')
    })
    const value = locale?.value
    if (typeof value?.preference === 'string' && value.preference.length > 0) {
      return value.preference
    }
    // Auto is resolved by the browser; the Host must not invent its language.
    if (locale !== undefined) return null
  } catch {
    // Fall through to the profile patch when the settings projection is unavailable.
  }

  try {
    const fs = process.getBuiltinModule('fs')
    const path = process.getBuiltinModule('path')
    const candidates = []
    const base = String(ctx.baseUrl ?? '')
    if (base.length > 0) {
      const directory = base.endsWith('/') ? base : `${base}/`
      candidates.push(directory.startsWith('file:')
        ? new URL('cordis.patch.yml', directory)
        : path.join(directory, 'cordis.patch.yml'))
    }
    for (const arg of process.argv) {
      if (/[\\/]profiles[\\/][^\\/]+[\\/]?$/.test(arg)) {
        candidates.push(path.join(arg, 'cordis.patch.yml'))
      }
    }
    for (const file of candidates) {
      try {
        const text = fs.readFileSync(file, 'utf8')
        const preference = text.match(/^\s*preference:\s*['"]?([A-Za-z0-9-]+)/m)?.[1]
        if (preference !== undefined) return preference
      } catch {
        // Try the next candidate.
      }
    }
  } catch {
    // Return the English fallback below.
  }
  return null
}

export const name = 'whale-soul-locale'
export const inject = ['agentPresets']

export function apply(ctx) {
  const service = ctx.agentPresets
  const originalList = service.list
  const originalRead = service.readDocument

  ctx.effect(() => {
    service.list = async function (...args) {
      const rows = await originalList.apply(this, args)
      return rows.map((row) => localizePreset(row, readPreference(ctx)))
    }

    service.readDocument = async function (...args) {
      const document = await originalRead.apply(this, args)
      return localizePreset(document, readPreference(ctx), document.agentPreset)
    }

    return () => {
      service.list = originalList
      service.readDocument = originalRead
    }
  }, 'whale-soul: localized preset display')
}
