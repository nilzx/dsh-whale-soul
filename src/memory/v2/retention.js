const secretPatterns = [
  /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/i,
  /\b(?:sk|ghp|github_pat|xox[baprs])-[_A-Za-z0-9-]{16,}\b/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\b(?:authorization\s*[:=]\s*)?(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.~-]{12,}/i,
  /(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|password|passwd|secret|密码|密钥|令牌|凭证|パスワード|秘密鍵|APIキー|アクセストークン)\s*(?:[:：=]|是|为|は|\bis\b)\s*\S{4,}/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /https?:\/\/[^\s/@:]+:[^\s/@]+@/i,
  /https?:\/\/\S*[?&#](?:token|auth|key|secret|password|access_token|api_key)=\S+/i,
  /(?:身份证|银行卡|信用卡|social security|credit card)[^\n]{0,20}\d[\d -]{8,}[\dXx]/i,
  /(?:手机号|电话号码|phone number)[^\n]{0,12}(?:\+?\d[\d -]{8,}\d)/i,
]
const noRetention = /(?:不要|别|不许|请勿|不需要|不用|无需|不必)\s*(?:再\s*|(?:把|将)[^\n]{0,80})?(?:(?:长期|永久|自动|再)\s*)?(?:记(?:住|下|录|忆)?|保存|保留|存储|持久化|写入(?:长期)?记忆)|(?:这|此).{0,10}(?:不要记|别记)|\b(?:do not|don't|never)\s+(?:remember|store|save|record|retain|keep)\b|\b(?:off the record|forget this)\b/i
const japaneseNoRetention = /(?:記憶|記録|保存|保管|保持|メモ)(?:は|を)?\s*し(?:ない(?:で|こと|ように)?|なくて(?:いい|よい)|ちゃ(?:だめ|ダメ))|(?:記憶|記録|保存|保管|保持|メモ)(?:は|を)?\s*するな|覚え(?:ないで|なくて(?:いい|よい)|るな)|オフレコ/

/** Deterministic gate shared by text and image retention. It performs no LLM call. */
export function retentionBlockReason(content, { nonRetention = false, sensitive = false } = {}) {
  if (nonRetention || typeof content === 'string' && (noRetention.test(content) || japaneseNoRetention.test(content))) return 'NON_RETENTION_BOUNDARY'
  if (sensitive || typeof content === 'string' && secretPatterns.some((pattern) => pattern.test(content))) return 'SENSITIVE_CONTENT'
  return null
}
