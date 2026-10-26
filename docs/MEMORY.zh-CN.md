# 记忆系统设计

鲸鱼娘的记忆是一个文件驱动、分层、可编辑的记忆花园。目标是**可检查、可修正、可重建**，而不是不可变的数据库。

## 事实源

- `entries/<id>/meta.json` 和层文件是事实源。
- `index.json`、`index.md`、`topics/` 是派生物；删掉后下次扫描会重建。
- 不做逐条 hash。合法用户编辑会让 hash 失效，还要引入签名/密钥管理；而真正的问题是索引过期、写到一半、模型静默覆盖。
- 权威性来自：Agent 单一写入路径、原子写、schema 校验、来源、版本，以及可重建索引。

## 分层

| 层 | 文件 | 何时加载 | 作用 |
|---|---|---|---|
| L0 | 索引 / 自动目录 | 每次会话 | 标题、tags、类型、salience、一句话要旨 |
| L1 | `gist.md` | 检索 / `soul_recall` | 这件事意味着什么 |
| L2 | `detail.md` | 明确 `depth=detail` | 结构化细节、上下文、原话 |
| L3 | `raw.jsonl` | 明确 `depth=raw` | 原始片段、冷证据 |

这个分层借鉴模糊痕迹理论：要旨比逐字细节活得久。它是工程类比，不是宣称模拟大脑。

## 条目 schema

`meta.json` 包含：

- `id`、`schema_version`、`type`、`title`、`summary`
- `tags`、`entities`、`links`
- `emotional_weight`、`salience`（emotional/identity/recurrence/novelty/unresolved）
- `confidence`、`source`、`user_edited`、`pinned`
- `created_at`、`updated_at`、`last_access`、`access_count`
- `valid_from`、`valid_to`、`supersedes`、`superseded_by`
- `layers`、`assets`、`canonical_key`
- `status`，可选 `archived_at`

tags 使用命名空间（`who:master`、`topic:food/rice`、`mood:warm`、`kind:preference`）。缺少 `kind:` 或 `topic:` 会自动补。

## 写入与去重

`soul_remember` 先构造 candidate，再找匹配的 active 条目：

1. 同一个 canonical key；或
2. 同类型 + 有意义的 tag 重叠 + 标题/要旨相似。

安全匹配则合并：tags 取并集，证据追加到 `detail`/`raw`，重算 salience，保留 links。canonical key 相同但内容明显不同，则新建版本，旧条目 `superseded_by`。用户编辑过的条目不静默覆盖，新内容作为 related 条目保存。

宁可保守：不确定的相似度应该变成 link 或独立条目，而不是静默合并。

## 衰退与做梦

`retrievability` 使用按类型区分的半衰期，并受 access count 和 salience 影响。真正的整理只在“到期 + 会话空闲”时运行：

- `detail` 先移入 `cold/`。
- `raw` 再移入 `cold/`。
- gist 可以压缩成目录行。
- 很旧的低分量条目归档。
- `pinned` 和 `user_edited` 受保护。
- 永久删除需要显式开启 `autoPurgeArchived`。

整理只写 `dreams/YYYY-MM-DD.md`，并向可选的身体适配器发内部 dream 事件；不写聊天状态汇报。

## 用户编辑

- 用户可以编辑任何条目文件。
- 加载时扫描文件；`mtime` 和解析结果足以识别外部编辑。
- 合法编辑视为 `source: user`，标记 `user_edited`，重建索引。
- 非法条目移入 `quarantine/` 并保留。
- Agent 不得静默覆盖用户编辑过的条目。修正事实应创建版本或 related 条目。

## 图片资产

图片按 SHA-256 内容寻址存放在 `assets/`，旁边有 JSON 元数据（tags、来源、描述、使用次数）。`soul_meme_save` 是显式动作：`recent_image: true` 会通过 `ctx.attachments` 读取当前会话最近一张图片；也支持本地路径或 URL。身体适配器可以通过本地 `/whale-soul-assets/` 路由把图片 URL 交给可选身体的 `broadcast`（见 [BODY.zh-CN.md](BODY.zh-CN.md)）。不会自动捕获任何图片。

## 隐私

只存本地，不上传云端。人设排除敏感凭证。图片只在用户同意时保存。
