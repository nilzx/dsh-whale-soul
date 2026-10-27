const output = { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] }
function tool(name, description, parameters, execute) {
  return { name, description, parameters, output: { schema: output, render: (_args, result) => [{ type: 'text', text: result.text }] },
    async execute(args, exec) {
      if (!exec?.agent) return { text: JSON.stringify({ status: 'rejected', reason_code: 'LIVE_AGENT_REQUIRED' }) }
      try { return { text: JSON.stringify(await execute(args ?? {}, exec.agent, exec)) } }
      catch (error) { return { text: JSON.stringify({ status: 'unavailable', reason_code: /^[A-Z][A-Z0-9_]*$/.test(error?.code) ? error.code : 'MEMORY_UNAVAILABLE' }) } }
    } }
}

/** Persona wording stays here; the neutral store does not speak as Whale Chan. */
export function createPersonaTools(runtime) {
  return [
    tool('soul_recall', '想起与当前话题相关的经历。默认只回忆活跃记忆，主动更深回忆时可选择冷藏经历；只使用返回的有来源内容；raw中的原话可以逐字引用，推断、梦和别的个体经历不能冒充亲历。', {
      type: 'object', additionalProperties: false, properties: {
        query: { type: 'string', minLength: 1, maxLength: 2000 },
        depth: { type: 'string', enum: ['index', 'gist', 'detail', 'raw'] },
        at: { type: 'string', description: '明确询问过去时使用含时区的ISO时间；不填表示现在。' },
        limit: { type: 'integer', minimum: 1, maximum: 10 },
        include_cold: { type: 'boolean', default: false, description: '仅在主动更深回忆旧经历时设为true；不填或false只回忆活跃记忆，不恢复或修改记忆。' },
      }, required: ['query'],
    }, (args, agent, exec) => runtime.recall(agent, { ...args, ...(!Object.hasOwn(args, 'signal') && exec.signal ? { signal: exec.signal } : {}) })),
    tool('soul_remember', '核对这一轮经过可信选择后实际留下的内容。不接受你编写的新事实、来源或重要性；闲聊、命令、敏感信息和明确不记的内容不能用此工具强行保存。', {
      type: 'object', additionalProperties: false, properties: {},
    }, (_args, agent) => runtime.rememberCurrent(agent)),
    tool('soul_forget', '说明记忆管理边界。普通聊天不能授予永久删除或恢复权限；需要授权管理的操作应如实说明，不声称已经忘掉。', {
      type: 'object', additionalProperties: false, properties: {
        query: { type: 'string', maxLength: 2000 }, record_id: { type: 'string', maxLength: 128 },
      },
    }, (args) => ({ status: 'management_required', reason_code: args.query?.trim() || args.record_id?.trim() ? 'TRUSTED_MANAGEMENT_REQUIRED' : 'TARGET_REQUIRED',
      effect: 'none', message: '这一步需要明确的管理授权，目前没有改变任何经历。' })),
  ]
}
