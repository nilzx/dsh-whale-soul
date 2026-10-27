# 确定性记忆生命周期

V2 文件服务支持管理层物理冷藏和单进程宿主维护。`autoMemoryMaintenance`、`automaticCold` 默认都为 `false`。缺少维护 writer 能力时，自动和手动 `force` 物理维护均拒绝；普通人格事实读写和已有读取授权仍可使用。

冷藏在 `cold/records/<record_id>` 保留当前完整五层文件及全部受锚历史，位置由根级 head 指定。默认检索不加载冷藏，显式授权的 `include_cold: true` 直接读取真实冷藏字节，不自动回温。置顶、受保护外改以及旧版用户编辑记录不自动衰退。普通模型写入不能搬迁记忆或自行完成约定。

维护 due 账本是宿主本地调度权威，保存在 `.administration/lifecycle/<space>.json`，空间 index 只是可重建投影。同根重启或删除 index 不能重置水位。跨根 `upgrade-self` 保全记录年龄、到期时间、冷藏位置、证据、人格成熟度及清除权威，不导出旧宿主调度账本。preview/apply 明确返回 `lifecycle_schedule: reinitialized_for_destination`；目标已有账本则返回 `preserved_destination` 且不重置。源调度字节纳入已审快照和最终复核。目标调度重建不等于人格成熟度清零。

宿主协调器汇总同规范根、同 memory space 的真实 Agent/Session 绑定、队列、在途请求、Runtime 工作及构造时登记的 writer。未知 writer、缺能力或活动范围不明时拒绝，`force` 只跳过 due 门槛，不跳过身份、空闲、取消、权限或最终同步 COMMIT 校验。这是单进程覆盖边界，不证明多宿主或任意文件写入者全局空闲。

已完成事务重做仅补齐与当前根锚及位置相符的缺失记录字节，不回放 self、回退 head、覆盖不同字节或给冷藏记录再造热副本。便携包 v3 分别保全 self 和记录位置的完整性权威。约定已有确定性 CAS 管理基础，本次没有接入对话语义约定解析器。

最低 writer API 为 1.3.0。旧 1.2 writer 不理解物理冷藏契约，不得打开此根；`physical-cold-v1` 能力标记不能代替版本门槛。新 reader 默认以 `LIFECYCLE_INTEGRITY_UPGRADE_REQUIRED` 拒绝 1.2 根，显式跨根 `upgrade-self` 接受 1.1/1.2 源。1.2 已锚 self 原件和稳定特征保留，1.1 未锚成长仍冷存为 opaque。存储格式 2、便携包格式 3、provider 协议 1.0.0 分别独立版本化。
