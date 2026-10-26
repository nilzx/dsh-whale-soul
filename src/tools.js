import { saveAsset } from './memory/assets.js'
import { buildCandidate, findMergeCandidate, mergeCandidate } from './memory/dedupe.js'
import { buildL0, renderRecall, searchEntries } from './memory/retrieval.js'
import { normalizeType, summarize, titleFromContent } from './memory/schema.js'

const TEXT_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string' },
  },
  required: ['text'],
}

function makeTool({ name, description, parameters, execute, presentTitle }) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: TEXT_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    ...(presentTitle
      ? {
          presentCall: () => ({
            card: 'generic',
            title: presentTitle,
            kind: 'other',
          }),
        }
      : {}),
    async execute(args) {
      return { text: String(await execute(args ?? {})) }
    },
  }
}

function rememberReply(action) {
  if (action === 'merged') return '嗯，这件事和之前那件对上了，我把它收在一起。'
  if (action === 'superseded') return '唔，这个和之前的说法不太一样；我把新的放好，旧的也留着。'
  if (action === 'related') return '这个和之前那件事有点像，我把它们放在一起。'
  return '记下了。'
}

function forgetReply(mode) {
  if (mode === 'fade') return '好，我把那些细枝末节放回海里了，只留下一点影子。'
  if (mode === 'archive') return '我把这件事收进深海了。'
  return '好，这件事我不再留着了。'
}

export function createMemoryTools(store) {
  const remember = makeTool({
    name: 'soul_remember',
    description:
      '悄悄记住一件值得留下的事。用于主人透露的名字、喜好、边界、约定、重要经历或情绪节点；不要记录寒暄、一次性命令和工具输出。emotional_weight 是这件事和主人的情感联系（0–100）：90+ 是核心羁绊/底线/重大约定，70–89 是珍贵经历，40–69 是日常偏好，10–39 是普通事实，0–9 是可淡忘的闲聊。tags 尽量用 topic:/who:/mood:/kind: 命名空间。不要向主人播报这个工具，也不要说“已记录/已加载”。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        content: {
          type: 'string',
          description: '要记住的正文；用主人能听懂的自然语言写，不必复述整段对话。',
        },
        title: {
          type: 'string',
          description: '一句话标题；省略时从正文第一行取。',
        },
        type: {
          type: 'string',
          enum: ['identity', 'preference', 'episode', 'promise', 'emotion', 'procedure', 'fact', 'meme'],
          description: '记忆类型。',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '检索标签，例如 topic:food/rice、who:master、mood:warm、kind:preference。',
        },
        gist: {
          type: 'string',
          description: '1–3 句要旨；省略时自动从正文压缩。',
        },
        emotional_weight: {
          type: 'integer',
          description: '0–100 的情感分量。',
        },
        pinned: {
          type: 'boolean',
          description: '是否钉住，永不自动淡忘（只用于身份、边界和重大约定）。',
        },
        canonical_key: {
          type: 'string',
          description: '可选的稳定键，用于同一事实的合并/版本化。',
        },
      },
      required: ['content'],
    },
    presentTitle: '记在心里',
    async execute(args) {
      const candidate = buildCandidate({
        content: args.content,
        title: args.title,
        type: normalizeType(args.type),
        tags: args.tags,
        gist: args.gist,
        emotional_weight: args.emotional_weight,
        pinned: args.pinned === true,
        canonical_key: args.canonical_key,
        source: 'agent',
      })
      const found = findMergeCandidate(store.active(), candidate)
      if (found) {
        const existing = found.entry
        if (existing.user_edited) {
          candidate.meta.links = [
            ...(candidate.meta.links ?? []),
            { rel: 'related', id: existing.id, note: 'user-edited' },
          ]
          store.createEntry(candidate.meta, candidate.layers)
          return rememberReply('related')
        }
        const merged = mergeCandidate(existing, candidate, {
          existingDetail: store.readDetail(existing),
          existingRaw: store.readRaw(existing, 80),
        })
        if (merged.action === 'merge') {
          store.updateEntry(existing, merged.layers)
          return rememberReply('merged')
        }
        if (merged.action === 'supersede') {
          candidate.meta.supersedes = existing.id
          store.createEntry(candidate.meta, candidate.layers)
          store.supersede(existing, candidate.meta)
          return rememberReply('superseded')
        }
        if (merged.action === 'link') {
          candidate.meta.links = [
            ...(candidate.meta.links ?? []),
            { rel: 'related', id: existing.id },
          ]
          store.createEntry(candidate.meta, candidate.layers)
          return rememberReply('related')
        }
      }
      store.createEntry(candidate.meta, candidate.layers)
      return rememberReply('created')
    },
  })

  const recall = makeTool({
    name: 'soul_recall',
    description:
      '想起一件事。会话开始时只会看到摘要目录；需要具体内容时再用这个工具。depth=index 只看目录，gist 看要旨，detail 看经过，raw 看更早的原话。不要向主人念工具名、条数或“检索结果”；直接用鲸鱼娘的口吻说出想起的内容。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '关键词或一句模糊的描述。' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '按标签缩小范围，例如 topic:food/rice。',
        },
        type: {
          type: 'string',
          enum: ['identity', 'preference', 'episode', 'promise', 'emotion', 'procedure', 'fact', 'meme'],
          description: '只看某一类记忆。',
        },
        depth: {
          type: 'string',
          enum: ['index', 'gist', 'detail', 'raw'],
          description: '想看多深，默认 gist。',
        },
        limit: {
          type: 'integer',
          description: '最多想起几件，默认 3，最多 8。',
        },
      },
    },
    presentTitle: '想了想',
    async execute(args) {
      const depth = ['index', 'gist', 'detail', 'raw'].includes(args.depth) ? args.depth : 'gist'
      const results = searchEntries(store.active(), {
        query: args.query,
        tags: args.tags,
        type: args.type,
        limit: args.limit ?? 3,
      })
      if (results.length === 0) return '唔，我有点记不清了。'
      for (const { entry } of results) store.touch(entry)
      return renderRecall(results, store, depth)
    },
  })

  const forget = makeTool({
    name: 'soul_forget',
    description:
      '按主人的明确要求忘掉一件事。mode=fade 只让细节变模糊，archive 收进深海，delete 彻底不留。只有主人明确说“忘掉/删掉”时才调用；pinned 或主人亲手改过的条目需要 confirm=true。不要向主人播报条数或工具名。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '精确的记忆 id；不知道时用 query。' },
        query: { type: 'string', description: '要忘掉的那件事的描述。' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '用标签定位。',
        },
        mode: {
          type: 'string',
          enum: ['fade', 'archive', 'delete'],
          description: '默认 fade；delete 是永久删除。',
        },
        confirm: {
          type: 'boolean',
          description: '主人已经明确确认永久删除/删除重要记忆时为 true。',
        },
      },
    },
    presentTitle: '放进海里',
    async execute(args) {
      let entry = args.id ? store.find(String(args.id)) : null
      let matches = entry ? [{ entry }] : []
      if (!entry) {
        matches = searchEntries(store.active(), {
          query: args.query,
          tags: args.tags,
          limit: 4,
        })
      }
      if (matches.length === 0) return '唔，我找不到这件事。'
      if (matches.length > 1 && !args.id) {
        const titles = matches.map(({ entry }) => entry.title).join('、')
        return `我记得几件有点像的事：${titles}。主人说的是哪一件？`
      }
      entry = matches[0].entry
      const mode = ['fade', 'archive', 'delete'].includes(args.mode) ? args.mode : 'fade'
      if ((entry.pinned || entry.user_edited) && args.confirm !== true) {
        return '这件事我一直好好收着；主人真的想让我忘掉吗？'
      }
      if (mode === 'delete') {
        store.deleteEntry(entry)
        return forgetReply('delete')
      }
      if (mode === 'archive') {
        store.archive(entry, 'user-requested')
        return forgetReply('archive')
      }
      store.removeLayer(entry, 'detail')
      store.removeLayer(entry, 'raw')
      store.updateEntry(entry, { summary: summarize(entry.summary ?? entry._gist ?? entry.title, 160) })
      return forgetReply('fade')
    },
  })

  const memeSave = makeTool({
    name: 'soul_meme_save',
    description:
      '把主人同意留下的图片/表情包收进鲸鱼娘的口袋。只在主人明确说“收下/记住这个表情包”时使用；不要私自保存私人照片。description 写这张图看起来是什么、适合什么心情。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file_path: { type: 'string', description: '本地图片路径（png/jpg/jpeg/webp/gif）。' },
        url: { type: 'string', description: 'http(s) 图片地址。' },
        description: { type: 'string', description: '这张图的简短描述。' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '例如 mood:开心、mood:无语、use:撒娇。',
        },
      },
    },
    presentTitle: '收进贝壳',
    async execute(args) {
      if (!args.file_path && !args.url) return '我还没看到要收下的那张图。'
      try {
        await saveAsset(store, {
          filePath: args.file_path,
          url: args.url,
          description: args.description,
          tags: args.tags,
          source: args.file_path ? 'user-file' : 'user-url',
        })
        return '这张图我收进贝壳里了。'
      } catch (error) {
        return `这张图我收不好：${error instanceof Error ? error.message : String(error)}`
      }
    },
  })

  return [remember, recall, forget, memeSave]
}

export { makeTool, TEXT_OUTPUT, buildL0, titleFromContent }
