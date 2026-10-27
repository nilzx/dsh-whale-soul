# 核心升级后的成长续接

[English](core-upgrades.md)

新的`core.version`不会创建新个体。persona及`individualKey`不变时，身份、事实记忆、证据和成熟度继续保留。旧核心版本的成长仍在磁盘中，但在按当前核心重审前，不参与普通加载。

## 重审行为

- 兼容且有依据的稳定项保持`stable`，原value、scope和证据保留。
- 兼容候选仍为`candidate`；核心升级不把候选直接提升为稳定，也不降低原成长门槛。
- 新核心移除了维度、内容不兼容、缺少有效依据或反证未解决时，旧项不改动、不加载，结果说明未续接原因。
- 通过后更新核心版本及修订号，旧条目完整保存在`history/`；同一重审重复执行返回耐久结果。

重审不是新经历，不增加或重置成熟度，不改事实记忆正文。不同persona或不同个体不继承彼此的成长。

## Runtime宿主入口

宿主可对空闲Agent明确发起重审：

```js
const result = await runtime.reviewCoreUpgrade(agent, { signal })
```

Runtime使用当前核心指令和已有成长评估器。结果可能为`completed`、`partial`、`busy`、`cancelled`、`failed`或`no_core_upgrade`，需要时包含逐项结果。正常到期维护会先检查待重审的旧成长，再做普通反思。同一源修订及目标版本已有拒绝回执后，不会反复阻断日常反思。

这是宿主API，不是聊天指令、人格编辑工具或新增管理CLI命令。关闭自动反思时，宿主仍可明确调用。续接成功后，后续上下文准备可加载兼容稳定项；候选仍不作为稳定人格注入。

## 成长服务API

已持有绑定新核心的`PersonaGrowth`实例的宿主，可用当前`self.evaluate` context列出并重审精确目标：

```js
const pending = await growth.listCoreUpgrade(context, { pendingOnly: true })
if (pending.status === 'ok') {
  for (const item of pending.items) {
    await growth.rebaseCore({
      kind: item.kind,
      id: item.id,
      expected_revision: item.entry.revision,
      from_core_version: item.from_core_version,
    }, context)
  }
}
```

`kind`为`trait`或`proposal`，目标版本取自服务绑定的当前核心。`rebased`表示续接已提交，`not_rebased`表示保留旧项并给出原因，`current`表示条目已经使用当前核心。默认operation ID由精确条目修订及目标版本派生。`listCoreUpgrade`默认最多20项，`truncated`提示仍有后续；`pendingOnly: false`时，已审旧项可带`last_review`。

实际修改核心时应更新版本；迁移时保留完整self包。此流程与旧存储API根升级不同，后者见[人格完整性及存储升级](self-integrity.zh-CN.md)。窄续接检查不代表对所有未来核心或长期模型表现均已验证兼容。
