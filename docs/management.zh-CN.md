# 本地所有者管理

[English](management.md)

入口：`node /绝对路径/plugin/src/manage.js help`。所有数据命令都必须提供绝对路径 `--root` 和明确的 `--space`，不会选择真实默认记忆目录。该命令只供所有者在独立本地进程使用，不注册为聊天工具；不能用来改核心、伪造来源或任意改写历史。

导入、迁移、清除默认只预览，变更原库必须在同一条具体命令中加 `--apply`。`status` 始终只读；`export --out 文件` 已明确本地目的地，会直接出包，无需额外 `--apply`。状态和导出也从临时副本读取，不初始化或修复原库。预览在私有临时副本上调用现有公开接口，检查复制哈希、源快照和实际导入/清除约束，随后删除副本。它不会给原库设置假初始化状态，也不通过内部存储方法绕过权限。

先停止写入与维护。正在占用的锁、未恢复日志、不支持的管理登记文件、符号链接、格式错误、源变化或超过预览预算都会明确拒绝，不声称已经修复。预览最多20,000文件、单文件128 MiB、总量256 MiB。当前公开接口只管理根目录内的 `exports`、`backups`，没有外部副本登记或自动修复命令。

```sh
node /plugin/src/manage.js status --root /绝对路径/memory --space owner
node /plugin/src/manage.js export --root /绝对路径/memory --space owner --out /绝对路径/export.json
node /plugin/src/manage.js import --root /绝对路径/new-memory --space owner \
  --archive /绝对路径/export.json --identity-mode preserve --accept-purge-state --accept-persona-state
```

导出直接写入明确指定的文件，已有文件不覆盖。导入保留身份，并要求明确接受包中携带的清除状态和人格状态。成熟度倒退仍由公开接口拒绝，只有另外显式使用 `--allow-maturity-reset` 才可能执行获准的管理重置。普通聊天不能授予这些能力。

```sh
node /plugin/src/manage.js migrate-v1 --root /绝对路径/v2-memory --space owner \
  --source /绝对路径/已停止的v1-memory --source-quiescent \
  --subject owner --persona whale-chan --agent-identity 从status确认的个体ID --opaque-policy preserve-local
```

迁移预览返回 `source_snapshot`。应用时在相同命令中加 `--snapshot HASH --apply`；缺少快照或源已变化都会拒绝。`--source-quiescent` 是所有者关于已停写的声明，接口还会在导入前重查源快照。身份参数仅给无归属旧记录赋值，已有归属由接口保留。旧记录不会冒充当前用户原话，也不自动获得成长资格。

V2运行时发现无manifest的旧根时返回`LEGACY_MIGRATION_REQUIRED`，不会在那里建立空白替代库。请选择独立的空目标根。如果无归属旧记录应接续某个人格，先在新目标根初始化该人格、停止其写入，再从`status`取得真实个体ID用于迁移；任意填写ID不会自动绑定人格anchor。上述参数不会重分配旧记录已有的归属。

同时含旧版标志和V2根manifest的目录返回`MIXED_MEMORY_ROOT`。先停写并保全目录，不要删除manifest，也不要直接把混合目录交给`migrate-v1`。当前CLI不提供自动提取或混合根恢复。

```sh
node /plugin/src/manage.js purge --root /绝对路径/memory --space owner --record 记录ID@预期修订号
```

可重复 `--record` 指定多条精确目标，不支持整库通配。先核对预览范围，再加 `--apply`。如旧叙述需要纳入清除，必须明确加 `--include-legacy-narratives`，不会静默扩大范围。兄弟记录保持不变。

已经批准但尚未形成任何当前/历史正式记录的项，可单独使用：

```sh
node /plugin/src/manage.js purge --root /绝对路径/memory --space owner --pending-item 项证据ID
```

该参数与 `--record`、`--include-legacy-narratives` 互斥，同样默认在副本预览，`--apply` 才清除原库。后台必须验证真实item绑定以及所有当前/历史记录引用；已有引用时返回 `ITEM_HAS_RECORDS`，不会自动扩大成记录清除。成功时删除该项正文及受管副本，保留事件的无正文资格和兄弟项。status只列安全ID和持久结果，`approved_unverified` 不等于“尚未成记录”；是否没有record引用由后台执行清除时确认。

`--opaque-policy omit` 明确排除不透明材料；导出可用 `include-reviewed`，本地迁移可用 `preserve-local` 显式处理已审阅材料。这些选项不等于对历史正文做了全面脱敏。

本入口把能在persona隔离之外访问该root的本地进程视为所有者管理进程，不能鉴别人类与同一OS用户的其它进程。`--apply` 只是动作选择，不能凭此参数移除persona进程继承的内核禁根。普通鲸鱼聊天没有注册管理工具。这里不声称所有标准/第三方Agent或整个OS都已隔离；标准模式不自动加载私有记忆，与文件访问权限是不同层次。

根目录外导出的包属于不受管副本，清除不会替你删除它们。旧包不能覆盖目标根已有的清除账本；新机器应先接收最新、携带清除状态的包，不能把空根误当作拥有跨机器撤销历史。命令不会提权，复制到 Agent 工作区执行也不能突破受保护目录。

退出码：成功或预览为 `0`，拒绝/错误为 `1`，需要明确不透明材料策略为 `2`。预览中的 `status: committed` 仅表示副本内模拟结果；`mode: preview` 与 `writes_applied: false` 表示原库未变。导出另外报告 `file_written`；明确导出到root内的exports/backups会新增受管副本，`source_unchanged`为false，但不改活跃记忆数据。应用失败时 `writes_applied: null` 表示完成情况不确定，应先检查再重试。导入、迁移和清除可用 `--operation-id ID` 进行明确的幂等重试。
