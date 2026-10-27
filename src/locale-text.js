export const PRESET_TEXT = {
  'whale-soul': {
    zh: { name: '鲸鱼娘', description: '一只住在 DSH 里的鲸鱼娘。会跟着主人换语言，傲娇又黏人；只把摘要目录带进会话，需要时再想起细节。' },
    en: { name: 'Whale Chan', description: 'A Whale Chan who lives in DSH. She follows your language, is tsundere and affectionate, and carries only a light memory index into a session.' },
  },
}

/** Only names owned by this package participate; user-authored names stay literal. */
export function localizePreset(row, locale, id = row?.id) {
  const text = PRESET_TEXT[id]
  if (!text || typeof locale !== 'string' || !Object.values(text).some((value) => value.name === row?.name)) return row
  const copy = locale.toLowerCase().startsWith('zh') ? text.zh : text.en
  if (row.name === copy.name && row.description === copy.description) return row
  return { ...row, name: copy.name, description: copy.description }
}
