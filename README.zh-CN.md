<p align="center">
  <img src="assets/icon.png" alt="鲸鱼娘" width="128" height="128">
</p>

# dsh-whale-soul

给 DeepSeek Harness 的「鲸鱼娘」Agent 模式，带一层会像梦一样慢慢沉淀的长期记忆。

[English README](README.md)

> 0.2.1准备中，尚未发布；npm最新版本仍为0.2.0。默认人格使用V2记忆API1.3与完整transfer v3，人格成长独立存储，数据保存在本地且可移植。从0.1.x升级前请阅读[0.2.1升级说明](docs/release-0.2.1.zh-CN.md)。0.2.0的0.1.5迁移与真实Electron桌面短流程已通过。0.2.1已通过一轮Electron合成损坏修复验收；更广泛损坏、长期成长和完整可选身体旅程仍单独验收。

## 这是什么

`dsh-whale-soul` 会在 DSH 里新增一个叫 **鲸鱼娘** 的 Agent 模式（英文或其他语言界面显示 **Whale Chan**）。她会聊天、照常做 Agent 的活，也会安静地记住重要的事。对话仍然发生在 DSH；插件只负责人格和记忆。

## 特性

- **人格保持连续**：普通聊天不能直接重写核心身份，宿主安全、隐私、权限和停止控制始终有效。
- **跟随当前语言**：人格提示要求回复和可见说明跟随当前消息语言，模型实际表现另行验收。
- **有归属的长期记忆**：筛选后的事实保留原话、修订和身份归属，同消息多项事实分别记录结果。
- **明确双方约定**：[窄对话桥接](docs/agreements.zh-CN.md)区分提议与双方接受。待办状态适配器可核验“将绑定待办标记为完成”这一明确约定；它不证明待办背后的工作产物已交付。
- **独立人格成长**：人格补完与事实、核心分开保存，有经历依据并经过后续反思才可沉淀。[核心升级](docs/core-upgrades.zh-CN.md)会重审兼容成长，并保留个体身份、原文、历史和成熟度。
- **可调稳定性**：多变、普通、顽固、自动四档控制成长门槛；默认自动随有效经历逐渐稳固，性格命令和反复自述不能刷成熟度。
- **独立管理入口**：本地预览、导出、迁移和精确清除位于普通人格工具之外；直接改文件不会获得核心权威。
- **本地存储**：插件数据保存在配置的记忆根，相关记忆可能随请求发送给所配置的模型提供方。
- **表情包，先征得同意**：只保存你明确要求保留的图片，不会自动捕获。

## 要求

- DSH `0.2.1-rc.3`（bundle 声明了该兼容性）。
- Node.js `>=22.12.0`。

## 安装

### 在 DSH 里安装

打开 DSH 的 **Plugins**，安装 `dsh-whale-soul`。如果 DSH 提示重启，按提示重启。

### 用命令行安装

```bash
dsh plugin --profile web add dsh-whale-soul
```

以上命令管理 Web profile。桌面端请在 DSH 桌面应用的 **Plugins** 中安装；标准 CLI 不能管理保留的 `desktop` profile。

以上仓库命令安装已发布版本。0.2.1候选版可安装本地构建包：`dsh plugin --profile web add /绝对路径/dsh-whale-soul-0.2.1.tgz`。

仅注册 `whale-soul` 预设。历史会话若引用已移除的预设，恢复前需在宿主中改选当前预设；此变更不改写会话历史或已存记忆。

安装后新建会话，在 Agent 模式选择器里选 **鲸鱼娘**（英文界面显示 Whale Chan）。已有会话保持启动时的模式。

记忆数据错误由独立Agent对照当前规范自动修复，覆盖已有数据损坏及旧布局。程序保全来源和回退备份，验证修复结果，未完成时自动续跑；Agent工具只处理记忆文件，不能修改插件。普通V1根及其空目录仍有无需模型的快捷转换。详见[自动修复说明](docs/release-0.2.1.zh-CN.md)；[本地管理](docs/management.zh-CN.md)继续作为可选的所有者能力保留。

## 使用

- 选择 **鲸鱼娘**（英文界面显示 Whale Chan），正常聊天即可。文件、shell、网页、定时、skills 这些 Agent 能力都还在。
- 在人格插件行配置`individualKey`可在同一记忆空间保留多个独立个体；省略或设置`default`继续原个体。会话切换与恢复见[个体身份](docs/individuals.zh-CN.md)。
- 在`dsh-whale-soul/persona`插件行配置`stabilityMode`，四档及持久成熟度见[稳定性规则](docs/stability.zh-CN.md)。
- 输入`/whale-context`查看鲸鱼娘占当前留存上下文的估算比例，细分人格核心、人格补完、记忆/召回、运行提示和工具，同时显示占总上下文和占鲸鱼娘内部的百分比。本地指令无需模型调用，结果不进入模型上下文或记忆；沿用DSH估算方式，不是计费token。
- [人格完整性与所有者升级](docs/self-integrity.zh-CN.md)说明显式所有者API对旧根的直接校验规则；普通预设启动遇到这些数据错误时会进入自动修复。writer门槛与冷藏边界见[生命周期与更深回忆](docs/lifecycle.zh-CN.md)。
- 管理操作使用[本地管理CLI](docs/management.zh-CN.md)。直接外改需明确[审查](docs/external-review-api.md)；存储、正文纯净和可移植性见[V2记忆设计](docs/MEMORY.zh-CN.md)。

## 记忆位置与基础配置

默认记忆根是`~/.dsh/whale-soul/memory`；设置`DSH_HOME`后为`$DSH_HOME/whale-soul/memory`，默认空间为`owner`。未另行配置时，Web与桌面profile使用同一根。

在`dsh-whale-soul/persona`插件行设置：

| 选项 | 默认值 | 用途 |
|---|---|---|
| `memoryRoot` | 上述默认根 | 选择记忆库，建议使用绝对路径或`~/…`。 |
| `memorySpaceId` | `owner` | 选择根目录下的记忆空间。 |
| `subjectId` | `owner` | 标识与该个体互动的人。 |
| `individualKey` | `default` | 接续指定个体，修改后新建会话。 |
| `stabilityMode` | `auto` | `variable`多变、`normal`普通、`stubborn`顽固、`auto`自动。 |
| `autoDream` | `true` | 允许空闲人格反思，不会生成V2叙事梦日记。 |
| `autoMemoryMaintenance` | `false` | 开启自动物理记忆维护。 |
| `automaticCold` | `false` | 允许物理维护将符合条件的条目转入冷藏。 |

修改根或空间只是选择数据，不会搬迁原库。跨根接续同一个体请使用[导出导入流程](docs/management.zh-CN.md)。如可选身体也使用自定义根或空间，其`memoryRoot`与`memorySpaceId`需与人格行一致。不要让独立的Web与桌面进程同时写同一根；物理维护只协调单个宿主进程。

## 隐私和安全

- 记忆文件存在本机配置的根目录；进入Agent请求的相关记忆会发送给配置的模型提供方。
- 人设是全年龄、非性化的；有害或色情请求会用鲸鱼娘的口吻拒绝。
- 不记录密码、令牌、银行卡、身份证等敏感信息。可明确要求新信息“不记”；移除已存条目使用本地管理流程，聊天中定点移除某个细节尚未实现。
- 只有你明确要求时才会保存图片；不会自动捕获。
- 管理入口支持导出、迁移和清除。人格工具不能自行取得管理权限或绕过受保护的宿主路径。
- 她不会声称自己是真人，也不会制造排他依赖。

## 了解更多

- [0.2.0更新与升级说明](docs/release-0.2.0.zh-CN.md)
- [记忆设计](docs/MEMORY.zh-CN.md)
- [角色契约](docs/ROLEPLAY.zh-CN.md)
- [稳定性与成熟度](docs/stability.zh-CN.md)
- [本地管理](docs/management.zh-CN.md)

## 许可

MIT，见 [LICENSE](LICENSE)。
