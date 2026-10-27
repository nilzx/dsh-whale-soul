# 确定性记忆生命周期

V2 文件服务支持管理层物理冷藏和单进程宿主维护。`autoMemoryMaintenance`、`automaticCold` 默认都为 `false`。缺少维护 writer 能力时，自动和手动 `force` 物理维护均拒绝；普通人格事实读写和已有读取授权仍可使用。

冷藏在 `cold/records/<record_id>` 保留当前完整五层文件及全部受锚历史，位置由根级 head 指定。默认检索不加载冷藏，显式授权的 `include_cold: true` 直接读取真实冷藏字节，不自动回温。置顶、受保护外改以及旧版用户编辑记录不自动衰退。普通模型写入不能自行搬迁记忆或完成约定。新准入的明确更正可通过下述窄路径恢复一条已绑定的冷藏事实。

维护 due 账本是宿主本地调度权威，保存在 `.administration/lifecycle/<space>.json`，空间 index 只是可重建投影。同根重启或删除 index 不能重置水位。跨根 `upgrade-self` 保全记录年龄、到期时间、冷藏位置、证据、人格成熟度及清除权威，不导出旧宿主调度账本。preview/apply 明确返回 `lifecycle_schedule: reinitialized_for_destination`；目标已有账本则返回 `preserved_destination` 且不重置。源调度字节纳入已审快照和最终复核。目标调度重建不等于人格成熟度清零。

宿主协调器汇总同规范根、同 memory space 的真实 Agent/Session 绑定、队列、在途请求、Runtime 工作及构造时登记的 writer。未知 writer、缺能力或活动范围不明时拒绝，`force` 只跳过 due 门槛，不跳过身份、空闲、取消、权限或最终同步 COMMIT 校验。这是单进程覆盖边界，不证明多宿主或任意文件写入者全局空闲。

已完成事务重做仅补齐与当前根锚及位置相符的缺失记录字节，不回放 self、回退 head、覆盖不同字节或给冷藏记录再造热副本。便携包 v3 分别保全 self 和记录位置的完整性权威。约定已有确定性CAS管理基础；[窄对话桥接](agreements.zh-CN.md)现支持明确提议、分别接受、取消与期限，不把普通工具成功当作履行。

最低 writer API 为 1.3.0。旧 1.2 writer 不理解物理冷藏契约，不得打开此根；`physical-cold-v1` 能力标记不能代替版本门槛。新 reader 默认以 `LIFECYCLE_INTEGRITY_UPGRADE_REQUIRED` 拒绝 1.2 根，显式跨根 `upgrade-self` 接受 1.1/1.2 源。1.2 已锚 self 原件和稳定特征保留，1.1 未锚成长仍冷存为 opaque。存储格式 2、便携包格式 3、provider 协议 1.0.0 分别独立版本化。

可信 `PersonaRuntime.recall` 宿主 API 将显式 `include_cold: true` 传给管理层确认引文的读取授权。授权绑定布尔读取意图、原 context、层级、当前 head、字节和时间窗，取消或晚期变化立即失效。默认自动上下文和普通召回仍排除冷藏，模型工具 `soul_recall` 提供相同可选布尔项，供主动更深回忆；不填或 `false` 仍只读活跃层，不授予记忆管理、恢复或写入能力；引文读取不授予成长或成熟度资格。

## 主动更深回忆

主动回忆较早的冷藏经历时，可以调用 `soul_recall({"query":"那次演出","include_cold":true})`。此可选项只接受布尔值，默认 false。原 query、depth、时间和数量参数契约保持。读取仍绑定真实 Agent/Session/个体，并继续检查来源、隐私、同意边界、到期和取消；不会改写原件或增加成长、成熟度资格。

此召回选项仍只读，不恢复、修订或回温；自动L0上下文继续排除冷藏。

## 更正较早的事实

“更正：我现在更偏好白茶”这类明确自然更正，可令运行时在有界目标目录中纳入冷藏事实。获准项必须绑定对应record和预期修订号；目标含混或版本已变时，不静默套用到新版本。

宿主在一次提交中完成恢复与新修订：当前head回到active并表达更正后的事实，旧修订及原字节保留在历史中。人工审阅记录的标题、标签、置顶和保护状态保持。新要旨/详情仅写事实；来源、恢复与修订信息留在元数据。

这与`include_cold`读取不同。普通深层召回保持只读，泛泛新增事实不会恢复无关冷藏条目。当前窄路径覆盖同一个体范围内的私有长期fact、preference和episode，见[受保护事实更正](protected-fact-correction.md)。
