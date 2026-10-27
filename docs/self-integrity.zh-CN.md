# 人格自身数据完整性与所有者升级

当前存储API为**1.3.0**。事实和经历由根级record head核验；每个独立个体的self manifest、候选、稳定特征及历史由单独的self head核验。原始证据和成熟度仍以独立persona ledger为权威。手动改写的一组自洽文件不能自行取得人格权威。

正常写入先核验旧的完整self bundle，再在同一持久事务中提交下一版head。损坏或未锚定的self不能进入上下文。`PersonaSelfAdministration.restoreSelf`只恢复与已有可信head逐字节匹配的原件，不能任意指定人格值。

完整导出使用transfer v3，携带无正文的`self_integrity_state`。导入除原有身份、清除和record完整性接纳外，还要求`identity_mode: preserve`与明确`accept_self_integrity: true`。宿主当前稳定性档位优先；不同self快照不按文件时间猜测合并，普通备份恢复不能降低独立成熟度水位。

## 升级API1.1旧根

先停止旧源写入与维护，保全原目录，选择互不重叠的新目标。在人格受限工具进程之外运行：

```sh
dsh-whale-soul-manage upgrade-self --root /absolute/new-root --space owner \
  --source /absolute/old-root --source-quiescent \
  --legacy-self-policy preserve-opaque
```

审阅预览与`source_snapshot`后，同一命令增加`--snapshot HASH --apply`。源目录保持原样；身份和证据资格保留，旧的未锚成长逐字节归档到`cold/legacy-self/`，不加载为稳定特征；宿主当前档位继续有效。

目标保存本机旧源路径保护清单，清单不进入可移植归档。声明需要却缺失权威时拒绝启动；已COMMIT但尚未安装的限制也会在恢复前生效。这不会删除旧源，也不能远程停止已经运行的旧writer。

API1.0的record基线只升至API1.1中间根；新reader仍拒绝，须继续上述独立self升级。目前record基线通过[外改审查文档](external-review-api.md)的明确owner API执行，CLI尚未自动串联这一步。保留其operation ID与已审阅快照，供精确恢复重试。

参见[英文版本](self-integrity.md)和[本地管理CLI](management.zh-CN.md)。
