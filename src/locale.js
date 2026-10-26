/**
 * Host-side display localization for the Whale Chan preset.
 *
 * The preset registry stores user-authored names literally, so a custom preset
 * cannot use the built-in locale dictionaries. This small host plugin wraps the
 * roster reads and supplies the name/description for the active DSH locale.
 */

const PRESET_TEXT = {
  'whale-soul': {
    zh: {
      name: '鲸鱼娘',
      description: '一只住在 DSH 里的鲸鱼娘。会跟着主人换语言，傲娇又黏人；只把摘要目录带进会话，需要时再想起细节。',
    },
    en: {
      name: 'Whale Chan',
      description: 'A Whale Chan who lives in DSH. She follows your language, is tsundere and affectionate, and carries only a light memory index into a session.',
    },
  },
  'whale-girl': {
    zh: {
      name: '鲸鱼娘（旧会话）',
      description: '旧会话的兼容入口；新会话请选择鲸鱼娘。',
    },
    en: {
      name: 'Whale Chan (Legacy)',
      description: 'Compatibility entry for older sessions; choose Whale Chan for new sessions.',
    },
  },
}

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
  return ''
}

function localizedText(ctx, id) {
  const text = PRESET_TEXT[id]
  if (text === undefined) return undefined
  const preference = readPreference(ctx).toLowerCase()
  return preference.startsWith('zh') ? text.zh : text.en
}

function withText(row, text) {
  return text === undefined ? row : { ...row, name: text.name, description: text.description }
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
      return rows.map((row) => withText(row, localizedText(ctx, row.id)))
    }

    service.readDocument = async function (...args) {
      const document = await originalRead.apply(this, args)
      return withText(document, localizedText(ctx, document.agentPreset))
    }

    return () => {
      service.list = originalList
      service.readDocument = originalRead
    }
  }, 'whale-soul: localized preset display')
}
