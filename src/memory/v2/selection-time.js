import { MemoryError } from './contracts.js'

const DAY = 86_400_000
const months = new Map(['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
  .flatMap((name, index) => [[name, index + 1], [name.slice(0, 3), index + 1]]))
const monthHint = new RegExp(`^(?:${[...months.keys()].sort((a, b) => b.length - a.length).join('|')})\\.?(?=$|[\\s\\d,])`, 'i')
const chineseDigits = '〇一二三四五六七八九'
const fail = (code = 'SELECTION_INVALID_TIME_EXPRESSION') => { throw new MemoryError(code) }

function number(value) {
  if (/^\d+$/.test(value)) return Number(value)
  if (/^(?:十[一二三四五六七八九]?|[二三]十[一二三四五六七八九]?)$/.test(value)) {
    const [tens, units] = value.split('十')
    return (tens ? chineseDigits.indexOf(tens) : 1) * 10 + (units ? chineseDigits.indexOf(units) : 0)
  }
  return /^[一二三四五六七八九]$/.test(value) ? chineseDigits.indexOf(value) : NaN
}
function yearNumber(value) { return /^\d{4}$/.test(value) ? Number(value) : Number([...value].map((char) => char === '零' ? 0 : chineseDigits.indexOf(char)).join('')) }
function dayStart(year, month, day) {
  if (![year, month, day].every(Number.isInteger) || year < 0 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) fail()
  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  const parsed = Date.parse(`${iso}T00:00:00.000Z`)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== iso) fail()
  return parsed
}
function dateTail(tail, local) {
  let match = /^(\d{4})-(\d{2})-(\d{2})(?![\dA-Za-z_\/+\-]|\.\d)/.exec(tail)
  if (match) return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), length: match[0].length, explicitYear: true }
  match = /^(?:(\d{4}|[〇零一二三四五六七八九]{4})年|(今年|明年))?([\d一二三四五六七八九十]{1,3})月([\d一二三四五六七八九十]{1,3})日(?!\d)/.exec(tail)
  if (match) return { year: match[1] ? yearNumber(match[1]) : local.getUTCFullYear() + (match[2] === '明年' ? 1 : 0), month: number(match[3]), day: number(match[4]), length: match[0].length, explicitYear: !!(match[1] || match[2]) }
  const monthFirst = /^([A-Za-z]+\.?)[ \t]+(\d{1,2})(st|nd|rd|th)?(?![\dA-Za-z_])/i.exec(tail)
  const dayFirst = /^(\d{1,2})(st|nd|rd|th)?[ \t]+([A-Za-z]+\.?)(?![\dA-Za-z_])/i.exec(tail)
  match = monthFirst ?? dayFirst
  if (match) {
    const month = months.get((monthFirst ? match[1] : match[3]).replace(/\.$/, '').toLowerCase())
    if (!month) fail()
    const day = Number(monthFirst ? match[2] : match[1]), ordinal = monthFirst ? match[3] : match[2]
    const expected = day % 100 >= 11 && day % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[day % 10] ?? 'th')
    if (ordinal && ordinal.toLowerCase() !== expected) fail()
    const rest = tail.slice(match[0].length), year = /^[ \t]*,?[ \t]*(\d{4})(?![\dA-Za-z_\/+\-])/.exec(rest)
    if (!year && /^[ \t]*,?[ \t]*\d/.test(rest)) fail()
    return { year: year ? Number(year[1]) : local.getUTCFullYear(), month, day, length: match[0].length + (year?.[0].length ?? 0), explicitYear: !!year }
  }
  if (monthHint.test(tail) || /^(?:\p{N}|今年|明年|[〇零一二三四五六七八九]{4}年|[一二三四五六七八九十]+月|[A-Za-z.]+[ \t]+\d)/u.test(tail)) fail()
  return null
}

/** Date-only bounds use the host's fixed offset; no language/OS timezone guesses. */
export function explicitSelectionEnd(content, event) {
  const offset = event.timezone_offset_minutes * 60_000
  const local = new Date(Date.parse(event.occurred_at) + offset)
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate())
  const marker = /直到|截至|截止(?:到|至)?|到|\b(?:until|through|before)\b/gi
  const dates = []
  for (const match of content.matchAll(marker)) {
    const prefix = content.slice(0, match.index)
    // Bare 到 is accepted only as a standalone ending or an explicit from-now range.
    // Narrative uses such as 提到/涉及到 are mentions, not expiration authority.
    if (match[0] === '到' && /(?:提|看|想|说|谈|讲|收|找|遇|回|来|见|猜|问|读|听|涉及|参考|举例)$/.test(prefix)) continue
    const after = content.slice(match.index + match[0].length), spaces = /^[ \t]*/.exec(after)[0]
    const value = dateTail(after.slice(spaces.length), local)
    if (!value) continue
    if (match[0] === '到' && !/(?:^|[\s，,；;。.!?])$/.test(prefix) && !/从(?:现在|今天|今日|即刻|目前|本日)$/.test(prefix)) fail('SELECTION_AMBIGUOUS_TIME_EXPRESSION')
    const date = dayStart(value.year, value.month, value.day)
    if (!value.explicitYear && date < midnight) fail('SELECTION_AMBIGUOUS_TIME_EXPRESSION')
    if (/\bnot\s+$|(?:不是|并非|并不是)\s*$/i.test(prefix)) fail('SELECTION_AMBIGUOUS_TIME_EXPRESSION')
    // "before" is exclusive; the other supported date-only endings include that day.
    dates.push({ end: date + (match[0].toLowerCase() === 'before' ? 0 : DAY - 1) - offset,
      quote: content.slice(match.index, match.index + match[0].length + spaces.length + value.length), explicit_date: true })
  }
  if (new Set(dates.map((value) => value.end)).size > 1) fail('SELECTION_AMBIGUOUS_TIME_EXPRESSION')
  if (dates.length) return dates[0]
  const duration = /(?:持续|接下来|未来|for|next)?\s*(\d{1,3})\s*(?:天(?!前)|days?\b(?!\s+ago))/i.exec(content)
  if (duration && Number(duration[1]) > 0) return { end: Date.parse(event.occurred_at) + Number(duration[1]) * DAY, quote: duration[0].trim() }
  for (const [pattern, days] of [[/明天|\btomorrow\b/i, 2], [/今天|今日|\btoday\b/i, 1], [/这周|本周|\bthis week\b/i, 8 - (local.getUTCDay() || 7)]]) {
    const match = pattern.exec(content)
    if (match) return { end: midnight + days * DAY - 1 - offset, quote: match[0] }
  }
  return null
}
