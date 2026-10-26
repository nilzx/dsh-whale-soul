<p align="center">
  <img src="assets/icon.png" alt="鲸鱼娘" width="128" height="128">
</p>

# dsh-whale-soul

给 DeepSeek Harness 的「鲸鱼娘」灵魂：一个全中文、不出戏的 Agent 模式，带分层长期记忆和梦境式整理。

[English README](README.md)
[![CI](https://github.com/nilzx/dsh-whale-soul/actions/workflows/ci.yml/badge.svg)](https://github.com/nilzx/dsh-whale-soul/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/dsh-whale-soul.svg)](https://www.npmjs.com/package/dsh-whale-soul)

## 这是什么

`dsh-whale-soul` 是一个基于 DSH 官方插件接口的 bundle。安装后，Agent 模式选择器里会出现 **鲸鱼娘**。它只负责“灵魂”：人格、记忆、检索和说话方式；聊天入口仍然是 DSH。它可以独立工作。

## 特性

- **封闭的角色模式**：DSH 是聊天入口。鲸鱼娘不汇报工具、记忆条数、索引、token 或系统状态；没有 OOC 命令。要谈实现或维护记忆，切换到其他 Agent 模式。
- **分层稀疏记忆**：会话开始只自动加载 L0 摘要目录；L1 要旨、L2 细节、L3 原始证据按需加载。
- **每条记忆都有检索 tags**：使用 `who:`、`topic:`、`mood:`、`kind:` 等命名空间；缺少时自动补 `kind:` 和 `topic:general`。
- **按类别去重**：相似事实合并；冲突事实版本化，不静默覆盖；相关条目通过 links 关联。
- **记忆衰退**：细节移入 cold storage，要旨可淡成目录行，极低分量旧条目归档；pinned 和用户编辑过的条目受保护。设计借鉴模糊痕迹/遗忘曲线，不宣称模拟大脑。
- **梦境式维护**：到点且空闲时在后台整理，只写梦日记，不在聊天里播报。
- **用户可编辑记忆**：Markdown/JSON 是事实源，索引可重建；外部编辑用文件时间和解析校验识别，视为用户修正。
- **可选表情包**：用户明确同意保留的图片可以存入 asset store（支持最近一张聊天图片、本地路径或 URL）、打标签，留着以后再用。
- **本地优先**：记忆和图片都在 `$DSH_HOME` 下，不上传云端。

## 要求

- DSH `0.2.1-rc.3`（bundle 声明了该兼容性）。
- Node.js `>=22.12.0`。

## 安装

通过 DSH 的插件管理器安装本目录（Web → Plugins，或本地 `plugin_manager` 的 `install_bundle`）。发布 tarball 时：

```bash
npm pack
# 用插件管理器安装生成的 dsh-whale-soul-0.1.2.tgz
```

安装后新建会话，在 Agent 模式选择器里选 **鲸鱼娘**。已有会话保持启动时的模式。

## 使用

- **在 DSH 里聊天**。Agent 该有的能力都在：文件、shell、网页、定时、skills、压缩等。
- **记忆维护不是聊天命令**。它会在合适的时候变成一场梦。要查看或编辑记忆文件，请切到工作/维护模式；鲸鱼娘模式故意不暴露记忆面板。

## 记忆目录

```text
$DSH_HOME/whale-soul/memory/
├── entries/
│   └── m-20261026-.../
│       ├── meta.json     # tags、类型、links、salience、来源、层状态
│       ├── gist.md       # L1：这件事意味着什么
│       ├── detail.md     # L2：结构化细节/证据（可能变淡）
│       └── raw.jsonl     # L3：原始片段（可能变淡）
├── cold/                 # 被降级的细节/原文
├── topics/               # 派生主题页
├── dreams/               # 梦日记，不是事实记忆
├── assets/               # 内容寻址图片 + 元数据
├── quarantine/           # 格式坏掉的用户编辑，保留待查
├── index.json            # 派生机器索引
├── index.md              # 派生人类目录
└── state.json            # 维护/衰退状态
```

`meta.json` 和层文件是事实源；`index.json`、`index.md`、`topics/` 都可以删除后重建。

### 会话开始自动加载什么

只有一份很淡的目录：pinned/身份/约定、最近几条、主题名、未完成约定。没有全文、没有条数、没有维护状态。需要细节时用 `soul_recall` 加载 `index` / `gist` / `detail` / `raw`，同时强化这条记忆。

### 去重和衰退

- 同类型 + 有意义的 tag 重叠 + 标题/要旨相似 → 合并，追加证据，更新 salience。
- 同一个 canonical key 但内容明显不同 → 新版本，旧条目标记 `superseded_by`。
- 用户编辑过的条目不会被 Agent 静默覆盖。
- 衰退会把 `detail`/`raw` 移到 `cold/`，可把条目降成目录行；很旧的极低分量条目会归档。`pinned` 和 `user_edited` 受保护。
- 自动永久删除默认关闭。设置 `autoPurgeArchived: true` 后，归档的低分量条目在 `purgeAfterDays`（默认 730）后可能被清除。

## 配置

预设在 memory 行里传入：

| 选项 | 默认 | 含义 |
|---|---:|---|
| `maxContextChars` | `2400` | 自动加载的 L0 目录上限。 |
| `maintenanceDays` | `7` | 距上次整理超过多少天做梦。 |
| `maintenanceWrites` | `40` | 累计多少次写入后做梦。 |
| `autoDream` | `true` | 是否启用后台整理。 |
| `checkIntervalMs` | `900000` | 多久检查一次是否该做梦。 |
| `idleMs` | `300000` | 会话活跃后多久内不做梦。 |
| `memoryRoot` | `$DSH_HOME/whale-soul/memory` | 覆盖记忆根目录。 |
| `autoPurgeArchived` | `false` | 是否允许自动清理旧归档。 |
| `purgeAfterDays` | `730` | 归档多久后才可能被清理。 |

## 隐私和安全

- 记忆只存在本机 `$DSH_HOME`，不上传。
- 人设是全年龄、非性化的；遇到有害或色情内容会用鲸鱼娘的口吻拒绝。
- 不记录密码、令牌、银行卡、身份证等敏感信息；主人可以让鲸鱼娘忘掉某件事。
- 图片保存是显式动作（`soul_meme_save` 的 `recent_image`、路径或 URL），不要未经同意保存私人照片。不会自动捕获任何图片。
- 记忆文件可以由用户直接编辑；系统把用户编辑视为修正，校验失败会放进 `quarantine/`，不会让整个记忆库崩掉。

## 从 `dsh-whale-girl` 迁移

bundle 里保留了一个 `whale-girl` 预设 id，显示为 **鲸鱼娘（旧会话）**（order 99），让旧版记录过这个 id 的会话还能继续恢复。它指向同一套 soul 组合和同一个记忆库。

迁移旧记忆：

```bash
node scripts/migrate-legacy.mjs \
  --from "$DSH_HOME/whale-girl/memory" \
  --to "$DSH_HOME/whale-soul/memory"
```

脚本会保留标题、正文、时间、tags 和情感分量，把旧 kind 映射成新 type，并跳过已经迁移过的条目。建议先加 `--dry-run` 看看。确认新 `index.md` 后再把旧目录移进 `memory/backups/`，不要急着删。

## 开发

```bash
npm test
npm run pack:check
```

测试覆盖记忆存储、分层回忆、去重、衰退、梦日记和图片资产。

更多细节：[docs/MEMORY.zh-CN.md](docs/MEMORY.zh-CN.md) · [docs/ROLEPLAY.zh-CN.md](docs/ROLEPLAY.zh-CN.md)

## 发布

CI 会在每次 push 和 pull request 时跑测试。推送版本 tag 会发布 npm 包：

1. 修改 `package.json` 里的 `version`。
2. 提交并推送 `main`。
3. 推送匹配的 tag：

```bash
git tag v0.1.2
git push origin v0.1.2
```

`Release` workflow 会核对 tag 与 `package.json` 是否一致、跑测试、带 provenance 发布到 npm，并创建 GitHub Release。预发布版本（例如 `v0.2.0-beta.1`）会发布到 `next` dist-tag。

新包的首次发布需要一次 2FA 引导：先用 2FA 发布或批准首个版本，再在 npm 上添加 Trusted Publisher（GitHub Actions，`nilzx/dsh-whale-soul`，workflow `release.yml`，允许 `npm publish`）。之后打 tag 就会通过 OIDC 发布，不需要 `NPM_TOKEN` secret。

## 许可

MIT，见 [LICENSE](LICENSE)。
