import { getWhaleCorePrompt } from './persona/core.js'

export const name = 'whale-soul-context-usage'
export const inject = ['commands', 'tokenMeter']
const memoryTools = new Set(['soul_recall', 'soul_meme_recall', 'soul_meme_use'])
const ownedTool = name => typeof name === 'string' && name.startsWith('soul_')
const textOf = message => message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
const percent = (part, total) => total > 0 ? 100 * part / total : 0
const sectionCategory = name => name === 'whale-soul:growth' ? 'growth'
  : ['whale-soul:memory', 'whale-soul:owner-reviewed-memory'].includes(name) ? 'memory' : 'operations'

/** Attribute only retained, named input; ordinary conversation is never guessed. */
export function measureWhaleContext(session, tokenMeter, { estimateToolsTokens, estimateContent }) {
  const header = session.requestHeader(), measurement = tokenMeter.measure(session, header)
  const categories = { core: 0, growth: 0, memory: 0, operations: 0, tools: 0 }
  const calls = new Map()
  for (let seq = 0; seq < measurement.logRevision; seq++) {
    const event = session.eventAt(seq)
    if (event?.type === 'tool/call') calls.set(event.data.callId, event.data.name)
  }
  const entries = measurement.nodes.map(node => ({ node, message: session.deriveEventMessage(session.eventAt(node.seq)) }))
  for (const { message } of entries) for (const block of message?.content ?? []) {
    if (block.type === 'tool-call') calls.set(block.id, block.name)
  }
  const core = getWhaleCorePrompt().trim()
  let unmatchedSections = 0
  for (const { node, message } of entries) {
    if (!message) continue
    let remaining = node.tokens
    const add = (category, tokens) => {
      const assigned = Math.min(remaining, Math.max(0, tokens))
      categories[category] += assigned; remaining -= assigned
    }
    const toolName = message.role === 'tool' ? calls.get(message.source.callId) : null
    if (ownedTool(toolName)) {
      add(memoryTools.has(toolName) ? 'memory' : 'tools', remaining)
      continue
    }
    const text = textOf(message)
    if (message.role === 'system') {
      let from = 0, index
      while ((index = text.indexOf(core, from)) !== -1) {
        add('core', Math.ceil(core.length / 4)); from = index + core.length
      }
    }
    if (message.source?.kind === 'runtime-context') {
      let from = 0
      for (const section of message.source.sections ?? []) {
        if (!section.name.startsWith('whale-soul:') || !section.text) continue
        const index = text.indexOf(section.text, from)
        if (index === -1) { unmatchedSections++; continue }
        // Charge text once; shared role/block/wrapper overhead stays unassigned.
        add(sectionCategory(section.name), Math.ceil(section.text.length / 4))
        from = index + section.text.length
      }
    }
    for (const block of message.content) {
      if (block.type === 'tool-call' && ownedTool(block.name) || block.type === 'tool-addition' && ownedTool(block.toolName)) {
        add('tools', estimateContent([block]))
      }
    }
  }
  const toolsTokens = estimateToolsTokens(header)
  const otherHeader = header ? { ...header, tools: header.tools?.filter(tool => !ownedTool(tool.name)) } : undefined
  categories.tools += toolsTokens - estimateToolsTokens(otherHeader)
  const totalTokens = measurement.surfaceTokens + toolsTokens
  const whaleTokens = Object.values(categories).reduce((sum, value) => sum + value, 0)
  return { estimated: true, scope: 'current-retained-context', route: header ? { provider: header.config.provider, model: header.config.model } : null,
    revision: measurement.logRevision, totalTokens, whaleTokens,
    whalePercent: percent(whaleTokens, totalTokens), categories, otherTokens: totalTokens - whaleTokens,
    providerPressureTokens: measurement.totalTokens, unmatchedSections }
}

export function formatWhaleContextUsage(report, language = 'zh') {
  const en = language === 'en'
  const labels = en ? ['Persona core', 'Persona growth', 'Memory and recall', 'Runtime hints', 'Tool definitions and calls']
    : ['人格核心', '人格补完', '记忆与召回', '运行提示', '工具定义与调用']
  const number = value => Math.round(value).toLocaleString(en ? 'en-US' : 'zh-CN')
  const ratio = (part, total) => total ? `${percent(part, total).toFixed(1)}%` : '—'
  const rows = Object.values(report.categories).map((tokens, index) =>
    `${labels[index]}：≈ ${number(tokens)} tokens · ${ratio(tokens, report.totalTokens)} / ${ratio(tokens, report.whaleTokens)}`)
  return [en ? 'Whale Soul context usage (estimate)' : 'Whale Soul 上下文占用（估算）',
    `${en ? 'Current retained context' : '当前留存上下文'}：≈ ${number(report.totalTokens)} tokens`,
    ...(report.route ? [`${en ? 'Model' : '模型'}：${report.route.model}`] : []),
    `Whale Soul：≈ ${number(report.whaleTokens)} tokens · ${ratio(report.whaleTokens, report.totalTokens)}`,
    `${en ? 'Personality total' : '人格合计'}：≈ ${number(report.categories.core + report.categories.growth)} tokens · ${ratio(report.categories.core + report.categories.growth, report.totalTokens)}`,
    `${en ? 'Runtime support total' : '运行辅助合计'}：≈ ${number(report.categories.operations + report.categories.tools)} tokens · ${ratio(report.categories.operations + report.categories.tools, report.totalTokens)}`,
    en ? 'Breakdown: tokens · % of context / % of Whale Soul' : '拆分：tokens · 占全部上下文 / 占 Whale Soul', ...rows,
    `${en ? 'Other context' : '非 Whale Soul 的其余上下文'}：≈ ${number(report.otherTokens)} tokens`,
    '', en ? 'Uses the DSH estimator on retained messages and current tool schemas. Not billing tokens; CJK text may be underestimated. Unattributed summaries or ordinary paraphrases are not guessed. Unloaded disk memories are excluded. This command and result do not enter model context or memory.'
      : '按 DSH 估算器统计当前保留消息与工具定义，非计费 token；中文可能被低估。无来源的压缩摘要或普通转述不猜归属，未加载的磁盘记忆不计入。本指令及结果不进入模型上下文或记忆。',
    ...(report.totalTokens === 0 ? [en ? 'No assembled request yet; send a message before measuring.' : '尚无已组装请求，请先发送一条消息后查看。'] : []),
    ...(report.unmatchedSections ? [en ? 'Some named sections could not be attributed; Whale Soul may be underestimated.' : '部分具名片段未能归因，Whale Soul 占比可能偏低。'] : [])].join('\n')
}

/** Human-only command; registration is scoped by the containing Agent preset. */
export function installWhaleContextUsage(ctx, pricing) {
  ctx.effect(() => ctx.commands.register({ name: 'whale-context', description: '查看鲸鱼娘上下文 token 占比 / Whale Soul context usage',
    handler: ({ agent, rawInput }) => {
      const language = rawInput.trim() || 'zh'
      if (!['zh', 'en'].includes(language)) return { kind: 'error', text: 'Usage: /whale-context [zh|en]' }
      return { kind: 'success', text: formatWhaleContextUsage(measureWhaleContext(agent.session, ctx.tokenMeter, pricing), language) }
    } }), 'whale-soul.context-usage()')
}

export async function apply(ctx) {
  const pricing = await import('@deepseek-ai/dsh-token-meter/estimate')
  installWhaleContextUsage(ctx, pricing)
}

export default { name, inject, apply }
